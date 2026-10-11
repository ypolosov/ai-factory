#!/bin/sh
# Поднимает ядро стенда фабрики: Forgejo, администратора, бота и три runner.
# Повторный запуск безопасен: готовые учётки, токены и регистрации не трогает.
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need docker curl jq od sed awk
load_env
mkdir -p .state
chmod 700 .state

log "Forgejo: запуск"
docker compose up -d forgejo >/dev/null
wait_healthy

ensure_user "$FORGEJO_ADMIN_USER" "$FORGEJO_ADMIN_EMAIL" admin
ensure_token "$FORGEJO_ADMIN_USER" admin all
ensure_user "$FORGEJO_BOT_USER" "$FORGEJO_BOT_EMAIL" bot
ensure_token "$FORGEJO_BOT_USER" bot "write:repository,write:issue"

for name in agent ci deploy; do
	ensure_runner "$name"
done

log "runner: запуск"
docker compose up -d >/dev/null
wait_runners agent ci deploy

log "готово: $FORGEJO_URL, вход $FORGEJO_ADMIN_USER, пароль в .state/admin.password"
