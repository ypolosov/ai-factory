#!/bin/sh
# Поднимает стенд фабрики: Forgejo, администратора, бота, три runner, шлюз моделей
# и службу выкладки.
# Повторный запуск безопасен: готовые учётки, токены и регистрации не трогает.
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need docker curl jq od sed awk sha256sum cmp tar
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
ensure_gateway
ensure_deployer

log "runner, шлюз, прокси выхода и служба выкладки: запуск"
docker compose build -q deployer egress
docker compose up -d >/dev/null
if [ -n "${RUNNERS_CHANGED:-}" ]; then
	# shellcheck disable=SC2086 # список имён через пробел
	docker compose restart $RUNNERS_CHANGED >/dev/null
	log "перезапущены с новыми настройками:$RUNNERS_CHANGED"
fi
wait_runners agent ci deploy
wait_gateway
build_agent_image
preload_job_images

log "готово: $FORGEJO_URL, вход $FORGEJO_ADMIN_USER, пароль в .state/admin.password"
