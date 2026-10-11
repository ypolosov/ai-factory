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
	_uuid=$(fj forgejo-cli actions register --name "runner-$1" --secret-stdin=- <"$_dir/token" | tail -n 1)
	printf '%s' "$_uuid" | grep -Eq '^[0-9a-f-]{36}$' || die "регистрация runner-$1 не вернула UUID: $_uuid"
	sed -e "s/@LABEL@/$1/" -e "s/@UUID@/$_uuid/" config/runner/runner.yaml.tmpl >"$_dir/runner.yaml"
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
		config/gateway/config.yaml.tmpl >.state/gateway/gateway.yaml
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
