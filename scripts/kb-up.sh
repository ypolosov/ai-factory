#!/bin/sh
# Поднимает Hindsight 1.1.0 вместо Onyx. Прежние контейнеры и тома не удаляет.
# Ключ провайдера остается у шлюза; у памяти свой ключ с дневным бюджетом.
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need docker curl jq od
load_env
: "${KB_PORT:=8300}" "${KB_UI_PORT:=8301}"
mkdir -p .state/kb
chmod 700 .state/kb
umask 077
for name in api.token mcp.token ui.key; do
	[ -s ".state/kb/$name" ] || random_hex 24 >".state/kb/$name"
done
printf 'Authorization: Bearer %s\n' "$(cat .state/kb/api.token)" >.state/kb/api.header
printf 'Authorization: Bearer %s\n' "$(cat .state/kb/mcp.token)" >.state/kb/mcp.header
ensure_gateway
{
	printf 'HINDSIGHT_API_LLM_API_KEY=%s\n' "$(cat .state/gw-hindsight.key)"
	printf 'HINDSIGHT_API_TENANT_API_KEY=%s\n' "$(cat .state/kb/api.token)"
	printf 'HINDSIGHT_API_MCP_AUTH_TOKEN=%s\n' "$(cat .state/kb/mcp.token)"
	printf 'HINDSIGHT_CP_DATAPLANE_API_KEY=%s\n' "$(cat .state/kb/api.token)"
	printf 'HINDSIGHT_CP_ACCESS_KEY=%s\n' "$(cat .state/kb/ui.key)"
} >.state/kb/hindsight.env
share_mounts
docker compose up -d --no-deps gateway
if [ -n "${GATEWAY_CHANGED:-}" ]; then
	docker compose restart gateway
fi
wait_gateway
log "база знаний: запуск Hindsight 1.1.0, OpenRouter, лимит $HINDSIGHT_DAILY_USD USD/сутки"
docker compose -f kb/compose.yaml up -d --wait --wait-timeout 360
log "API: http://127.0.0.1:$KB_PORT, панель: http://127.0.0.1:$KB_UI_PORT"
log "ключ панели: .state/kb/ui.key; настройка банка: scripts/kb-setup.sh"
