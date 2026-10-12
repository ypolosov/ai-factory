#!/bin/sh
# Поднимает базу знаний стенда: Onyx (kb/onyx - файлы развёртывания Onyx без изменений,
# kb/compose.override.yaml - правки стенда), проект compose "kb" рядом с фабрикой.
# Нужна работающая фабрика (scripts/stand-up.sh): сети ai-factory_factory и ai-factory_jobs,
# шлюз с ключом kb. Памяти - от 10 ГБ свободных (замер - в README).
# Повторный запуск безопасен: секреты и данные не трогает.
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need docker curl jq od
load_env
: "${KB_PORT:=8300}" "${KB_ONYX_TAG:=v4.8.1}"
mkdir -p .state/kb
chmod 700 .state/kb

# Секреты Onyx - один раз; пароль OpenSearch требует букв разного регистра, цифры и знака.
if [ ! -s .state/kb/env ]; then
	(
		umask 077
		printf 'IMAGE_TAG=%s\nAUTH_TYPE=basic\nFILE_STORE_BACKEND=postgres\n' "$KB_ONYX_TAG"
		printf 'POSTGRES_PASSWORD=%s\nOPENSEARCH_ADMIN_PASSWORD=Kb-%sA1!\n' "$(random_hex 16)" "$(random_hex 12)"
		printf 'USER_AUTH_SECRET=%s\nENCRYPTION_KEY_SECRET=%s\n' "$(random_hex 32)" "$(random_hex 16)"
		printf 'WEB_DOMAIN=http://127.0.0.1:%s\nDISABLE_TELEMETRY=true\nMCP_SERVER_ENABLED=true\n' "$KB_PORT"
	) >.state/kb/env
fi
# Onyx читает .env рядом со своим файлом compose (в git не попадает).
envfile=kb/onyx/deployment/docker_compose/.env
cmp -s .state/kb/env "$envfile" || (umask 077 && cp .state/kb/env "$envfile")

kb() {
	KB_PORT=$KB_PORT docker compose -p kb --env-file "$envfile" \
		-f kb/onyx/deployment/docker_compose/docker-compose.yml -f kb/compose.override.yaml "$@"
}

log "база знаний: запуск Onyx $KB_ONYX_TAG"
kb up -d
_i=0
until curl -fsS -o /dev/null "http://127.0.0.1:$KB_PORT/api/health" 2>/dev/null; do
	_i=$((_i + 1))
	[ "$_i" -le 120 ] || die "Onyx не ответил за 10 мин; журнал: docker compose -p kb logs api_server"
	sleep 5
done
log "база знаний: http://127.0.0.1:$KB_PORT"
