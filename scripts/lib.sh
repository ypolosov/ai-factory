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

# ensure_runner ИМЯ - секрет, регистрация (идемпотентная) и настройки runner.
ensure_runner() {
	_tok=".state/runner-$1.token"
	if [ ! -s "$_tok" ]; then
		random_hex 20 >"$_tok"
		chmod 600 "$_tok"
	fi
	# Флаг строковый, значение не читается: секрет приходит через stdin, а не через аргументы.
	_uuid=$(fj forgejo-cli actions register --name "runner-$1" --secret-stdin=- <"$_tok" | tail -n 1)
	printf '%s' "$_uuid" | grep -Eq '^[0-9a-f-]{36}$' || die "регистрация runner-$1 не вернула UUID: $_uuid"
	sed -e "s/@LABEL@/$1/" -e "s/@UUID@/$_uuid/" config/runner/runner.yaml.tmpl >".state/runner-$1.yaml"
	log "runner-$1 зарегистрирован"
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
