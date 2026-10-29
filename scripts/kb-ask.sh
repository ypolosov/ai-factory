#!/bin/sh
# Вопрос Hindsight: ответ с источниками, действительно использованными при reflect.
# Использование: scripts/kb-ask.sh "вопрос". Модель - kb-openrouter.
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need curl jq
load_env
: "${KB_PORT:=8300}" "${KB_BANK_ID:=factory}"
[ "$#" -eq 1 ] || die 'использование: scripts/kb-ask.sh "вопрос"'
[ -s .state/kb/api.header ] || die "сначала scripts/kb-up.sh и scripts/kb-setup.sh"
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bank=$(jq -nr --arg b "$KB_BANK_ID" '$b | @uri')
jq -n --arg q "$1" '{query: $q, budget: "low", max_tokens: 2048, include: {facts: {}}}' >"$tmp/question.json"
start=$(date +%s)
curl -fsS --max-time 330 -H @.state/kb/api.header -H 'Content-Type: application/json' \
	--data @"$tmp/question.json" "http://127.0.0.1:$KB_PORT/v1/default/banks/$bank/reflect" >"$tmp/answer.json"
jq -r --arg seconds "$(($(date +%s) - start))" '
	.text + "\n\nИсточники:\n" +
	([.based_on.memories[]? | select(.metadata.source_url != null)
		| (.metadata.title // .document_id // "источник") + " - " + .metadata.source_url] | unique | join("\n")) +
	"\n\n(" + $seconds + " с)"' "$tmp/answer.json"
