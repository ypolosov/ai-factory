#!/bin/sh
# Поднимает стенд фабрики: Forgejo, администратора, бота, три runner, шлюз моделей,
# службу выкладки, проверки доступности и сбор ошибок (GlitchTip и мост в задачи).
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
ensure_user "$FORGEJO_OPS_USER" "$FORGEJO_OPS_EMAIL" ops
ensure_token "$FORGEJO_OPS_USER" ops "write:issue,read:repository,read:user"

for name in agent ci deploy; do
	ensure_runner "$name"
done
ensure_gateway
ensure_deployer
ensure_gatus
ensure_glitchtip_env
share_mounts

log "runner, шлюз, прокси выхода, служба выкладки и сбор ошибок: запуск"
docker compose build -q deployer egress errbridge
docker compose up -d >/dev/null
if [ -n "${RUNNERS_CHANGED:-}" ]; then
	# shellcheck disable=SC2086 # список имён через пробел
	docker compose restart $RUNNERS_CHANGED >/dev/null
	log "перезапущены с новыми настройками:$RUNNERS_CHANGED"
fi
if [ -n "${GATUS_CHANGED:-}" ]; then
	docker compose restart gatus >/dev/null
fi
if [ -n "${GATEWAY_CHANGED:-}" ]; then
	docker compose restart gateway >/dev/null
fi
ensure_glitchtip
share_mounts
if [ -n "${ERRBRIDGE_CHANGED:-}" ]; then
	docker compose restart errbridge >/dev/null
fi
wait_runners agent ci deploy
wait_gateway
build_agent_image
preload_job_images

log "готово: $FORGEJO_URL, вход $FORGEJO_ADMIN_USER, пароль в .state/admin.password"
