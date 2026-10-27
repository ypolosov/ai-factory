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
	: "${GLITCHTIP_PORT:=8200}" "${KB_DAILY_USD:=2}"
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
	_cap=1
	[ "$1" != ci ] || _cap=2
	sed -e "s/@LABEL@/$1/" -e "s|@IMAGE@|$_image|" -e "s/@UUID@/$_uuid/" -e "s/@CAPACITY@/$_cap/" \
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
	for _r in agent-api agent-sub owner kb; do
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
	# Ключ Console для API-кредитов подписки Max (путь kb-claude-api базы знаний).
	if [ ! -f .state/gateway/anthropic-kb.key ]; then
		: >.state/gateway/anthropic-kb.key
		chmod 600 .state/gateway/anthropic-kb.key
	fi
	sed -e "s/@AGENT_API_HASH@/$(sha256sum .state/gw-agent-api.key | cut -d' ' -f1)/" \
		-e "s/@AGENT_SUB_HASH@/$(sha256sum .state/gw-agent-sub.key | cut -d' ' -f1)/" \
		-e "s/@OWNER_HASH@/$(sha256sum .state/gw-owner.key | cut -d' ' -f1)/" \
		-e "s/@KB_HASH@/$(sha256sum .state/gw-kb.key | cut -d' ' -f1)/" \
		-e "s/@KB_DAILY_USD@/$KB_DAILY_USD/" \
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

# share_mounts - открыть каталоги .state, которые монтируются в контейнеры, их пользователям.
# Службы читают секреты от uid 1000 внутри контейнера. В rootless Docker это не владелец
# файлов на хосте (тот внутри - root), и с правами 600 служба их не прочитает. Поэтому
# смонтированные каталоги - 755, файлы - 644; на хосте их закрывает .state (700).
# Журнал шлюза (gateway-db) пишут шлюз и координатор, читают отчёты на хосте: каталог 777,
# файлы 666 - SQLite создаёт -wal и -shm с правами файла базы. Права журнала меняет
# контейнер: файлы, созданные службой в rootless, принадлежат подчинённому uid хоста.
# Вызывать после записи секретов и до запуска или перезапуска служб.
share_mounts() {
	chmod 700 .state
	for _d in runner-agent runner-ci runner-deploy claude-cli deployer errbridge gateway gatus coordinator kbsync cd; do
		[ -d ".state/$_d" ] || continue
		find ".state/$_d" -type d -exec chmod 755 {} +
		find ".state/$_d" -type f -exec chmod 644 {} +
	done
	mkdir -p .state/gateway-db
	[ -e .state/gateway-db/gateway.sqlite ] || : >.state/gateway-db/gateway.sqlite
	docker run --rm -v "$PWD/.state/gateway-db:/db" docker.io/library/node:24.21.0-alpine3.24 \
		sh -c 'chmod 777 /db && chmod 666 /db/*'
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
# по проверке на каждое приложение из DEPLOY_APPS, задачи о сбоях - от учётки эксплуатации
# в репозитории приложения. Поднят экземпляр демо (scripts/demo-up.sh положил учётку цели
# службе cd) - ещё проверки стенда цели демо (demo-endpoints.yaml.tmpl). Вызывают stand-up.sh
# и demo-up.sh: настройки одни и те же, кто бы ни вызвал.
ensure_gatus() {
	mkdir -p .state/gatus
	chmod 700 .state/gatus
	_first=${DEPLOY_APPS%% *}
	(
		umask 077
		# Токен - из файла внутри awk, не аргументом команды.
		sed -e "s|@ALERT_REPO@|${_first%%=*}|" config/gatus/config.yaml.tmpl |
			awk 'BEGIN { getline tok <".state/ops.token" } { gsub(/@OPS_TOKEN@/, tok); print }'
		for _e in $DEPLOY_APPS; do
			_r=${_e%%=*}
			sed -e "s|@APP@|${_r##*/}|" -e "s|@PORT@|${_e#*=}|" -e "s|@REPO@|$_r|" config/gatus/app-endpoint.yaml.tmpl
		done
		# Признак демо - только наличие файла, содержимое не читается.
		[ ! -s .state/cd/github-target.env ] || cat config/gatus/demo-endpoints.yaml.tmpl
	) >.state/gatus/config.yaml.new
	if cmp -s .state/gatus/config.yaml.new .state/gatus/config.yaml; then
		rm -f .state/gatus/config.yaml.new
	else
		mv .state/gatus/config.yaml.new .state/gatus/config.yaml
		# shellcheck disable=SC2034 # читают scripts/stand-up.sh и scripts/demo-up.sh
		GATUS_CHANGED=1
	fi
}

# ensure_glitchtip_env - до запуска служб: секреты GlitchTip (.state/glitchtip/env - ключ
# Django и пароль базы; пароль администратора) и errbridge (.state/errbridge/ - токен
# учётки эксплуатации и токен вебхука).
ensure_glitchtip_env() {
	mkdir -p .state/glitchtip .state/errbridge
	chmod 700 .state/glitchtip .state/errbridge
	if [ ! -s .state/glitchtip/env ]; then
		_pw=$(random_hex 16)
		(
			umask 077
			printf 'SECRET_KEY=%s\nPOSTGRES_USER=glitchtip\nPOSTGRES_DB=glitchtip\nPOSTGRES_PASSWORD=%s\n' "$(random_hex 32)" "$_pw"
			printf 'DATABASE_URL=postgres://glitchtip:%s@glitchtip-db:5432/glitchtip\n' "$_pw"
		) >.state/glitchtip/env
	fi
	[ -s .state/glitchtip/admin.password ] || (umask 077 && random_hex 12 >.state/glitchtip/admin.password)
	[ -s .state/errbridge/hook.token ] || (umask 077 && random_hex 20 >.state/errbridge/hook.token)
	if ! cmp -s .state/ops.token .state/errbridge/forgejo.token; then
		(umask 077 && cp .state/ops.token .state/errbridge/forgejo.token)
	fi
}

# ensure_claude_cli - секреты обёртки над claude -p (.state/claude-cli/): ключ, который
# предъявляет ей шлюз (его копия - .state/gateway/claude-cli.key), вход подписки Claude и
# ключ шлюза для подписок. Нет входа подписки - обёртка не нужна.
ensure_claude_cli() {
	mkdir -p .state/claude-cli
	chmod 700 .state/claude-cli
	[ -s .state/claude-cli/token ] || (umask 077 && random_hex 24 >.state/claude-cli/token)
	_changed=""
	for _pair in "token:gateway/claude-cli.key" "claude-oauth.token:claude-cli/claude-oauth.token" \
		"gw-agent-sub.key:claude-cli/gateway.key"; do
		_src=${_pair%%:*}
		_dst=.state/${_pair#*:}
		[ "$_src" != token ] || _src=claude-cli/token
		[ -s ".state/$_src" ] || continue
		if ! cmp -s ".state/$_src" "$_dst"; then
			(umask 077 && cp ".state/$_src" "$_dst")
			_changed=1
		fi
	done
	# shellcheck disable=SC2034 # читает scripts/stand-up.sh
	[ -z "$_changed" ] || CLAUDE_CLI_CHANGED=1
}

# put_if_changed ФАЙЛ - стандартный ввод в ФАЙЛ (права 600), если содержимое другое.
# Код выхода 0 - файл изменился.
put_if_changed() {
	(umask 077 && cat >"$1.new")
	if cmp -s "$1.new" "$1"; then
		rm -f "$1.new"
		return 1
	fi
	mv "$1.new" "$1"
}

# ensure_glitchtip - после запуска GlitchTip: администратор, проекты приложений с
# оповещением в errbridge (config/glitchtip/setup.py). DSN приложений - службе выкладки
# (.state/deployer/dsn/ПРИЛОЖЕНИЕ), токен чтения событий - errbridge.
ensure_glitchtip() {
	_i=0
	until docker compose exec -T glitchtip python healthcheck.py >/dev/null 2>&1; do
		_i=$((_i + 1))
		[ "$_i" -le 90 ] || die "GlitchTip не ответил за 180 с"
		sleep 2
	done
	mkdir -p .state/deployer/dsn
	_pw=$(cat .state/glitchtip/admin.password)
	_hook=$(cat .state/errbridge/hook.token)
	{
		printf 'EMAIL = "%s"\nPASSWORD = "%s"\nAPPS = "%s"\nHOOK_TOKEN = "%s"\n' \
			"$FORGEJO_ADMIN_EMAIL" "$_pw" "$DEPLOY_APPS" "$_hook"
		cat config/glitchtip/setup.py
	} | docker compose exec -T glitchtip python manage.py shell >.state/glitchtip/setup.out 2>/dev/null ||
		die "GlitchTip: настройка не прошла"
	while read -r _kind _a _b _c; do
		case $_kind in
		dsn) printf 'http://%s@glitchtip:8000/%s\n' "$_b" "$_c" | put_if_changed ".state/deployer/dsn/$_a" || true ;;
		token)
			# shellcheck disable=SC2034 # читает scripts/stand-up.sh
			printf '%s\n' "$_a" | put_if_changed .state/errbridge/glitchtip.token && ERRBRIDGE_CHANGED=1
			;;
		esac
	done <.state/glitchtip/setup.out
	rm -f .state/glitchtip/setup.out
	grep -q . .state/errbridge/glitchtip.token 2>/dev/null || die "GlitchTip: нет токена для errbridge"
	log "GlitchTip: http://127.0.0.1:${GLITCHTIP_PORT}, вход $FORGEJO_ADMIN_EMAIL, пароль в .state/glitchtip/admin.password"
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

# build_job_image КАТАЛОГ ОБРАЗ DIND... - собирает образ заданий на хосте, если содержимое
# каталога изменилось с прошлой сборки, и загружает в Docker заданий, где его нет или он
# другой: том dind мог смениться (перенос стенда, сброс Docker), а метка сборки - остаться.
# Docker заданий в интернет не ходит, поэтому собирать в нём нельзя.
build_job_image() {
	_dir=$1
	_img=$2
	shift 2
	_sumf=.state/$(basename "$_dir")-image.sum
	_sum=$(find "$_dir" -type f -exec sha256sum {} + | sort | sha256sum | cut -c1-16)
	if [ "$(cat "$_sumf" 2>/dev/null)" != "$_sum" ] || ! docker image inspect "$_img" >/dev/null 2>&1; then
		log "образ $_img: сборка (несколько минут при первом запуске)"
		docker build -q -t "$_img" "$_dir" >/dev/null
		printf '%s' "$_sum" >"$_sumf"
	fi
	_id=$(docker image inspect -f '{{.Id}}' "$_img")
	for _d in "$@"; do
		[ "$(dind "$_d" image inspect -f '{{.Id}}' "$_img" 2>/dev/null)" != "$_id" ] || continue
		docker save "$_img" | dind "$_d" load -q >/dev/null
		log "образ $_img загружен в Docker заданий $_d"
	done
}

# build_agent_image - образ исполнителя (агенты и проверки) и образ ревьюера (ворота ИИ).
build_agent_image() {
	build_job_image images/agent "$AGENT_IMAGE" agent ci
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

# follow_agent_pr РЕПОЗИТОРИЙ ЗАДАЧА С_МОМЕНТА(ISO) НАЧАЛО(эпоха) - ждёт прогон агента
# по задаче, начатый не раньше С_МОМЕНТА, его PR и статусы проверок PR. Обязательные
# статусы (из защиты main) держат слияние, остальные - совет человеку.
follow_agent_pr() {
	_repo=$1
	_issue=$2
	_since=$3
	_start=$4
	_i=0
	while :; do
		_r=$(api GET "/repos/$_repo/actions/runs?limit=20" |
			jq -r --argjson n "$_issue" --arg s "$_since" '[.workflow_runs[]
				| select(.event == "issues" and .created >= $s and (.event_payload | fromjson | .issue.number) == $n)][0]
				| select(. != null) | "\(.status) \(.html_url)"')
		case ${_r%% *} in
		success | failure | cancelled | skipped) break ;;
		esac
		_i=$((_i + 1))
		[ "$_i" -le 600 ] || die "прогон агента по задаче #$_issue не закончился за 40 мин"
		sleep 4
	done
	log "агент: $_r"
	[ "${_r%% *}" = success ] || die "прогон агента не прошёл"

	_pr=$(api GET "/repos/$_repo/pulls?state=open&limit=50" |
		jq -r --arg b "agent/issue-$_issue" '[.[] | select(.head.ref == $b)][0] | select(. != null) | "\(.number) \(.html_url)"')
	[ -n "$_pr" ] || die "PR от бота не найден"
	log "PR: ${_pr#* }"

	_sha=$(api GET "/repos/$_repo/pulls/${_pr%% *}" | jq -r .head.sha)
	_req=$(api GET "/repos/$_repo/branch_protections/main" | jq -c '.status_check_contexts // []')
	_i=0
	while :; do
		# Сразу после пуша статусов ещё нет (statuses: null).
		_st=$(api GET "/repos/$_repo/commits/$_sha/status" | jq -c '.statuses = (.statuses // [])')
		# Ещё ждём: статусы в работе и обязательные, которых пока нет.
		_left=$(printf '%s' "$_st" | jq --argjson r "$_req" '[.statuses[].context] as $have
			| ([.statuses[] | select(.status == "pending")] | length)
			+ ([$r[] | select(. as $c | $have | index($c) | not)] | length)')
		[ "$_left" -eq 0 ] && break
		_i=$((_i + 1))
		[ "$_i" -le 600 ] || die "проверки PR не закончились за 40 мин"
		sleep 4
	done
	printf '%s' "$_st" | jq -r --argjson r "$_req" '.statuses[] | .context as $c
		| "  \($c): \(.status)" + (if ($r | index($c)) then "" else " (совет, слияние не держит)" end)' >&2
	_failed=$(printf '%s' "$_st" | jq --argjson r "$_req" \
		'[.statuses[] | select((.context as $c | $r | index($c)) and .status != "success")] | length')
	[ "$_failed" -eq 0 ] || die "обязательные проверки PR не прошли"
	log "от метки до PR с зелёными обязательными проверками: $(($(date +%s) - _start)) с"
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
