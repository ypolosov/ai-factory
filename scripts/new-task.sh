#!/bin/sh
# Заводит задачу с меткой роли и ждёт: прогон агента, PR от бота, статусы проверок PR.
# Использование: scripts/new-task.sh РЕПОЗИТОРИЙ "Заголовок" ФАЙЛ_С_ОПИСАНИЕМ [МЕТКА]
# Метка: agent (разработка, по умолчанию), agent:spec (спецификация), agent:tests (приёмочные тесты).
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need curl jq mktemp
load_env
name=${1:?использование: scripts/new-task.sh РЕПОЗИТОРИЙ ЗАГОЛОВОК ФАЙЛ}
title=${2:?нужен заголовок}
body_file=${3:?нужен файл с описанием}
label_name=${4:-agent}
[ -f "$body_file" ] || die "нет файла $body_file"
repo="$FORGEJO_ADMIN_USER/$name"

label=$(api GET "/repos/$repo/labels" | jq -r --arg n "$label_name" '.[] | select(.name == $n) | .id')
[ -n "$label" ] || die "нет метки $label_name: сначала scripts/setup-repo.sh $name"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
jq -n --arg t "$title" --rawfile b "$body_file" '{title: $t, body: $b}' >"$tmp/issue.json"
issue=$(api POST "/repos/$repo/issues" --data @"$tmp/issue.json" | jq -r .number)
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
start=$(date +%s)
api POST "/repos/$repo/issues/$issue/labels" --data "{\"labels\":[$label]}" >/dev/null
log "задача #$issue: $FORGEJO_URL/$repo/issues/$issue"
follow_agent_pr "$repo" "$issue" "$since" "$start"
