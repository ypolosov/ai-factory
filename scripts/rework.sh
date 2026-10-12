#!/bin/sh
# Доработка: снимает и заново ставит метку роли на задаче. Агент продолжает в ветке
# прошлой попытки и получает замечания из PR, оставленные после её последнего коммита
# (ревью ИИ, комментарии человека). Затем скрипт ждёт прогон и проверки PR.
# Использование: scripts/rework.sh РЕПОЗИТОРИЙ НОМЕР_ЗАДАЧИ
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need curl jq
load_env
name=${1:?использование: scripts/rework.sh РЕПОЗИТОРИЙ НОМЕР_ЗАДАЧИ}
issue=${2:?нужен номер задачи}
repo="$FORGEJO_ADMIN_USER/$name"

label=$(api GET "/repos/$repo/issues/$issue/labels" |
	jq -r '[.[] | select(.name == "agent" or (.name | startswith("agent:")))][0] | select(. != null) | "\(.id) \(.name)"')
[ -n "$label" ] || die "на задаче #$issue нет метки роли агента"
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
start=$(date +%s)
api DELETE "/repos/$repo/issues/$issue/labels/${label%% *}" >/dev/null
api POST "/repos/$repo/issues/$issue/labels" --data "{\"labels\":[${label%% *}]}" >/dev/null
log "метка ${label#* } поставлена заново: доработка задачи #$issue"
follow_agent_pr "$repo" "$issue" "$since" "$start"
