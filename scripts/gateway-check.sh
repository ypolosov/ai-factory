#!/bin/sh
# Проверка шлюза моделей: ключи, ограничения по моделям, открытая модель и учёт по задаче.
# Подписки Claude Code и Codex проверяются вручную (нужны входы владельца), см. README.
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need curl jq docker
load_env
gw="http://127.0.0.1:${GATEWAY_PORT}"
task="gateway-check-$(date -u +%Y%m%dT%H%M%SZ)"
fail=0

expect() {
	if [ "$2" = "$3" ]; then
		log "  ok: $1 ($3)"
	else
		log "  НЕТ: $1 - ждали $2, получили $3"
		fail=1
	fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

expect "без ключа отказ" 401 "$(code "$gw/v1/models")"
expect "ключ открытых моделей не пускает к Claude" 403 "$(code -H @.state/gw-agent-api.header \
	-H 'content-type: application/json' \
	-d '{"model":"claude-haiku-4-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}' \
	"$gw/v1/messages")"
expect "ключ подписок не пускает к открытым моделям" 403 "$(code -H @.state/gw-agent-sub.header \
	-H 'content-type: application/json' \
	-d '{"model":"default","messages":[{"role":"user","content":"hi"}]}' \
	"$gw/v1/chat/completions")"
expect "открытая модель отвечает" 200 "$(code -H @.state/gw-agent-api.header -H "x-task-id: $task" \
	-H 'content-type: application/json' \
	-d '{"model":"default","max_tokens":300,"messages":[{"role":"user","content":"Answer with one word: ok"}]}' \
	"$gw/v1/chat/completions")"

sleep 1
record=$(docker compose logs --no-log-prefix gateway 2>/dev/null | grep "\"$task\"" | tail -n 1)
cost=$(printf '%s' "$record" | jq -r '."agw.ai.usage.cost.total" // empty' 2>/dev/null)
if [ -n "$cost" ]; then
	log "  ok: учёт по задаче $task, цена $cost USD"
else
	log "  НЕТ: в журнале шлюза нет записи с ценой для $task"
	fail=1
fi

[ "$fail" -eq 0 ] || die "проверка шлюза не прошла"
log "шлюз в порядке"
