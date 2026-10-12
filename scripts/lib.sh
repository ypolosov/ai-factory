# Общие функции скриптов стенда. Подключается из корня репозитория: . ./scripts/lib.sh
# shellcheck shell=sh

log() { printf '%s\n' "$*" >&2; }

die() {
	log "ошибка: $*"
	exit 1
}

need() {
	for _c in "$@"; do
		command -v "$_c" >/dev/null 2>&1 || die "нет команды $_c"
	done
}

# Читает .env (создаёт из .env.example при первом запуске) и задаёт FORGEJO_URL.
load_env() {
	[ -f .env ] || cp .env.example .env
	set -a
	# shellcheck disable=SC1091
	. ./.env
	# Значения по умолчанию для переменных, которых нет в старом .env.
	: "${FORGEJO_HTTP_PORT:=3000}" "${FORGEJO_ADMIN_USER:=factory-admin}" "${FORGEJO_ADMIN_EMAIL:=admin@factory.local}"
	: "${FORGEJO_BOT_USER:=factory-bot}" "${FORGEJO_BOT_EMAIL:=bot@factory.local}"
	: "${GATEWAY_PORT:=4000}" "${GATEWAY_AGENT_DAILY_USD:=2}"
	: "${AGENT_IMAGE:=factory/agent:stand}"
	: "${FORGEJO_OPS_USER:=factory-ops}" "${FORGEJO_OPS_EMAIL:=ops@factory.local}"
	: "${DEPLOY_APPS:=factory-admin/hello=8080 factory-admin/todo=8081}" "${GATUS_PORT:=8100}"
	set +a
	FORGEJO_URL="http://127.0.0.1:${FORGEJO_HTTP_PORT}"
}

# Случайная строка из 2*N шестнадцатеричных символов.
random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

# Команда forgejo внутри контейнера от пользователя git.
fj() { docker compose exec -T -u git forgejo forgejo "$@"; }

# api МЕТОД ПУТЬ [аргументы curl] - запрос к API от имени администратора.
# Токен читается из файла заголовка, а не из командной строки.
api() {
	_method=$1
	_path=$2
	shift 2
	curl -fsS -X "$_method" -H @.state/admin.header -H 'Content-Type: application/json' \
		"$FORGEJO_URL/api/v1$_path" "$@"
}

wait_healthy() {
	_i=0
	until curl -fsS "$FORGEJO_URL/api/healthz" >/dev/null 2>&1; do
		_i=$((_i + 1))
		[ "$_i" -le 60 ] || die "Forgejo не ответил за 120 с"
		sleep 2
	done
}

# ensure_user ИМЯ ПОЧТА ВИД - создаёт учётку, если её нет; пароль кладёт в .state/ВИД.password.
ensure_user() {
	if fj admin user list | awk 'NR > 1 { print $2 }' | grep -qx "$1"; then
		return 0
	fi
	if [ "$3" = admin ]; then
		_out=$(fj admin user create --admin --username "$1" --email "$2" \
			--random-password --random-password-length 24 --must-change-password=false)
	else
		_out=$(fj admin user create --username "$1" --email "$2" \
			--random-password --random-password-length 24 --must-change-password=false)
	fi
	printf '%s\n' "$_out" | sed -n "s/.*generated random password is '\(.*\)'.*/\1/p" >".state/$3.password"
	chmod 600 ".state/$3.password"
	[ -s ".state/$3.password" ] || die "не удалось прочитать пароль учётки $1"
	log "учётка $1 создана"
}

# ensure_token ИМЯ ВИД ОБЛАСТИ - выпускает токен, если его ещё нет.
ensure_token() {
	if [ ! -s ".state/$2.token" ]; then
		fj admin user generate-access-token --username "$1" \
			--token-name "stand-$2-$(random_hex 4)" --scopes "$3" --raw >".state/$2.token"
		chmod 600 ".state/$2.token"
		log "токен $2 выпущен"
	fi
	printf 'Authorization: token %s\n' "$(cat ".state/$2.token")" >".state/$2.header"
	chmod 600 ".state/$2.header"
}

# ensure_runner ИМЯ - секрет, регистрация (идемпотентная) и настройки runner
# в каталоге .state/runner-ИМЯ/ (монтируется в контейнер целиком).
ensure_runner() {
	_dir=".state/runner-$1"
	mkdir -p "$_dir"
	# Переезд со старой раскладки (файлы прямо в .state/).
	[ -f ".state/runner-$1.token" ] && mv ".state/runner-$1.token" "$_dir/token"
	rm -f ".state/runner-$1.yaml"
	if [ ! -s "$_dir/token" ]; then
		random_hex 20 >"$_dir/token"
		chmod 600 "$_dir/token"
	fi
	# Флаг строковый, значение не читается: секрет приходит через stdin, а не через аргументы.
	# Метки - явно: повторная регистрация без них стирает метки, и задания перестают находить runner.
	_uuid=$(fj forgejo-cli actions register --name "runner-$1" --labels "$1" --secret-stdin=- <"$_dir/token" | tail -n 1)
	printf '%s' "$_uuid" | grep -Eq '^[0-9a-f-]{36}$' || die "регистрация runner-$1 не вернула UUID: $_uuid"
	case $1 in
	agent | ci) _image=$AGENT_IMAGE ;;
	*) _image=docker.io/library/alpine:3.24 ;;
	esac
	sed -e "s/@LABEL@/$1/" -e "s|@IMAGE@|$_image|" -e "s/@UUID@/$_uuid/" \
		config/runner/runner.yaml.tmpl >"$_dir/runner.yaml.new"
	# Runner читает настройки только при старте: изменившиеся отмечаем для перезапуска.
	if cmp -s "$_dir/runner.yaml.new" "$_dir/runner.yaml"; then
		rm -f "$_dir/runner.yaml.new"
	else
		mv "$_dir/runner.yaml.new" "$_dir/runner.yaml"
		RUNNERS_CHANGED="${RUNNERS_CHANGED:-} runner-$1"
	fi
	log "runner-$1 зарегистрирован"
}

# ensure_gateway - ключи шлюза по ролям (в настройки попадают только их хэши),
# заготовка ключа провайдера и настройки шлюза в .state/gateway/ (монтируется целиком).
ensure_gateway() {
	mkdir -p .state/gateway .state/gateway-db
	# Переезд со старой раскладки.
	[ -s .state/openrouter.key ] && mv .state/openrouter.key .state/gateway/openrouter.key
	rm -f .state/openrouter.key .state/gateway.yaml
	for _r in agent-api agent-sub owner; do
		if [ ! -s ".state/gw-$_r.key" ]; then
			printf 'gw-%s-%s' "$_r" "$(random_hex 24)" >".state/gw-$_r.key"
			chmod 600 ".state/gw-$_r.key"
		fi
		printf 'x-gateway-key: %s\n' "$(cat ".state/gw-$_r.key")" >".state/gw-$_r.header"
		chmod 600 ".state/gw-$_r.header"
	done
	if [ ! -s .state/gateway/openrouter.key ]; then
		: >.state/gateway/openrouter.key
		chmod 600 .state/gateway/openrouter.key
		log "внимание: .state/gateway/openrouter.key пуст - открытые модели не ответят, пока владелец не положит ключ"
	fi
	sed -e "s/@AGENT_API_HASH@/$(sha256sum .state/gw-agent-api.key | cut -d' ' -f1)/" \
		-e "s/@AGENT_SUB_HASH@/$(sha256sum .state/gw-agent-sub.key | cut -d' ' -f1)/" \
		-e "s/@OWNER_HASH@/$(sha256sum .state/gw-owner.key | cut -d' ' -f1)/" \
		-e "s/@AGENT_DAILY_USD@/$GATEWAY_AGENT_DAILY_USD/" \
		config/gateway/config.yaml.tmpl >.state/gateway/gateway.yaml.new
	# Шлюз читает настройки при старте: изменившиеся отмечаем для перезапуска.
	if cmp -s .state/gateway/gateway.yaml.new .state/gateway/gateway.yaml; then
		rm -f .state/gateway/gateway.yaml.new
	else
		mv .state/gateway/gateway.yaml.new .state/gateway/gateway.yaml
		# shellcheck disable=SC2034 # читает scripts/stand-up.sh
		GATEWAY_CHANGED=1
	fi
}

# ensure_deployer - токен бота для статусов выкладки в .state/deployer/ (монтируется целиком).
ensure_deployer() {
	mkdir -p .state/deployer
	chmod 700 .state/deployer
	if ! cmp -s .state/bot.token .state/deployer/bot.token; then
		(umask 077 && cp .state/bot.token .state/deployer/bot.token)
	fi
}

# ensure_gatus - настройки проверок доступности в .state/gatus/ (монтируется целиком):
# приложение стенда - первое из DEPLOY_APPS, задачи о сбоях - от учётки эксплуатации.
ensure_gatus() {
	mkdir -p .state/gatus
	chmod 700 .state/gatus
	_first=${DEPLOY_APPS%% *}
	_repo=${_first%%=*}
	(umask 077 && sed -e "s|@ALERT_REPO@|$_repo|" -e "s|@APP@|${_repo##*/}|" -e "s|@PORT@|${_first#*=}|" \
		-e "s|@OPS_TOKEN@|$(cat .state/ops.token)|" config/gatus/config.yaml.tmpl >.state/gatus/config.yaml.new)
	if cmp -s .state/gatus/config.yaml.new .state/gatus/config.yaml; then
		rm -f .state/gatus/config.yaml.new
	else
		mv .state/gatus/config.yaml.new .state/gatus/config.yaml
		# shellcheck disable=SC2034 # читает scripts/stand-up.sh
		GATUS_CHANGED=1
	fi
}

# wait_gateway - ждёт, пока шлюз начнёт отвечать на список моделей.
wait_gateway() {
	_gw="http://127.0.0.1:${GATEWAY_PORT}"
	_i=0
	until curl -fsS -o /dev/null -H @.state/gw-owner.header "$_gw/v1/models" 2>/dev/null; do
		_i=$((_i + 1))
		[ "$_i" -le 60 ] || die "шлюз не ответил за 120 с"
		sleep 2
	done
	log "шлюз на связи: $_gw"
}

# dind ИМЯ команда... - docker внутри dind runner ИМЯ.
dind() {
	_n=$1
	shift
	docker compose exec -T "$_n-dind" docker -H unix:///var/run/dind/docker.sock "$@"
}

# build_agent_image - собирает образ исполнителя на хосте и загружает в Docker заданий
# агента и проверок, если содержимое images/agent изменилось с прошлой сборки.
# Docker заданий в интернет не ходит, поэтому собирать в нём нельзя.
build_agent_image() {
	_sum=$(find images/agent -type f -exec sha256sum {} + | sort | sha256sum | cut -c1-16)
	if [ "$(cat .state/agent-image.sum 2>/dev/null)" = "$_sum" ]; then
		return 0
	fi
	log "образ исполнителя: сборка (несколько минут при первом запуске)"
	docker build -q -t "$AGENT_IMAGE" images/agent >/dev/null
	for _d in agent ci; do
		docker save "$AGENT_IMAGE" | dind "$_d" load -q >/dev/null
	done
	printf '%s' "$_sum" >.state/agent-image.sum
	log "образ исполнителя: $AGENT_IMAGE готов"
}

# preload_job_images - готовые образы заданий (container: image: в workflow шаблонов)
# загружаются в Docker проверок с хоста: Docker заданий за образами в интернет не ходит.
preload_job_images() {
	grep -ho 'image: docker\.io/[^ ]*' examples/*/.forgejo/workflows/*.yml | cut -d' ' -f2 | sort -u |
		while read -r _img; do
			dind ci image inspect "$_img" >/dev/null 2>&1 && continue
			log "образ заданий: $_img"
			docker pull -q "$_img" >/dev/null
			docker save "$_img" | dind ci load -q >/dev/null
		done
}

# wait_runners ИМЯ... - ждёт, пока runner выйдут на связь с Forgejo.
wait_runners() {
	for _n in "$@"; do
		_i=0
		until api GET /admin/actions/runners |
			jq -e --arg n "runner-$_n" '.[] | select(.name == $n and .status != "offline")' >/dev/null 2>&1; do
			_i=$((_i + 1))
			[ "$_i" -le 60 ] || die "runner-$_n не вышел на связь за 120 с"
			sleep 2
		done
		log "runner-$_n на связи"
	done
}
