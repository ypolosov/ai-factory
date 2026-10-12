#!/bin/sh
# Переключает модель ответов базы знаний (Onyx) по умолчанию между тремя путями шлюза:
#   kb-claude-cli  - подписка Claude через официальный claude -p (images/claude-cli);
#   kb-claude-api  - API-кредиты подписки Max (ключ Console в .state/gateway/anthropic-kb.key);
#   kb-openrouter  - DeepSeek V4.1 Flash через OpenRouter (дневной бюджет ключа kb).
# Использование: scripts/kb-model.sh [kb-claude-cli|kb-claude-api|kb-openrouter]
# Без аргумента - показать текущую.
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need curl jq
load_env
: "${KB_PORT:=8300}"
kb=http://127.0.0.1:$KB_PORT/api
[ -s .state/kb/admin.header ] || die "база знаний не настроена: scripts/kb-setup.sh"
provider=$(curl -fsS -H @.state/kb/admin.header "$kb/admin/llm/provider" | jq -c '[.providers[] | select(.name == "factory-gateway")][0]')
[ "$provider" != null ] || die "в Onyx нет поставщика factory-gateway: scripts/kb-setup.sh"
if [ $# -eq 0 ]; then
	curl -fsS -H @.state/kb/admin.header "$kb/admin/llm/provider" | jq -r '.default_text | if . == null then "не задана" else (.model_name // tostring) end'
	exit 0
fi
case $1 in
kb-claude-cli | kb-claude-api | kb-openrouter) ;;
*) die "модель: kb-claude-cli, kb-claude-api или kb-openrouter" ;;
esac
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
jq -n --argjson id "$(printf '%s' "$provider" | jq .id)" --arg m "$1" '{provider_id: $id, model_name: $m}' >"$tmp"
curl -fsS -o /dev/null -X POST -H @.state/kb/admin.header -H 'content-type: application/json' --data @"$tmp" "$kb/admin/llm/default"
log "база знаний: модель ответов - $1"
