#!/bin/sh
# Вопрос к базе знаний (Onyx): ответ с цитатами и ссылками на источники.
# Использование: scripts/kb-ask.sh "вопрос" [kb-claude-cli|kb-claude-api|kb-openrouter]
# Без модели - модель по умолчанию (scripts/kb-model.sh).
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need curl jq
load_env
: "${KB_PORT:=8300}"
q=${1:?использование: scripts/kb-ask.sh "вопрос" [модель]}
[ -s .state/kb/admin.header ] || die "база знаний не настроена: scripts/kb-setup.sh"
tmp=$(mktemp)
trap 'rm -f "$tmp" "$tmp.out"' EXIT
jq -n --arg q "$q" --arg m "${2:-}" '{message: $q, stream: false, chat_session_info: {persona_id: 0}}
	+ (if $m == "" then {} else {llm_override: {model_provider: "factory-gateway", model_version: $m}} end)' >"$tmp"
start=$(date +%s)
curl -fsS -H @.state/kb/admin.header -H 'content-type: application/json' --data @"$tmp" \
	"http://127.0.0.1:$KB_PORT/api/chat/send-chat-message" >"$tmp.out"
jq -r --arg s "$(($(date +%s) - start))" '
	if .error_msg then "ошибка: " + .error_msg else
	.answer + "\n\nИсточники:\n" + ([.citation_info[]? as $c | .top_documents[]?
		| select(.document_id == $c.document_id)
		| "[\($c.citation_number)] \(.semantic_identifier) - \(.link)"] | unique | join("\n"))
	+ "\n\n(" + $s + " с)" end' "$tmp.out"
