#!/bin/sh
# Заводит задачу с меткой agent и ждёт: прогон агента, PR от бота, проверки PR.
# Использование: scripts/new-task.sh РЕПОЗИТОРИЙ "Заголовок" ФАЙЛ_С_ОПИСАНИЕМ
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need curl jq mktemp
load_env
name=${1:?использование: scripts/new-task.sh РЕПОЗИТОРИЙ ЗАГОЛОВОК ФАЙЛ}
title=${2:?нужен заголовок}
body_file=${3:?нужен файл с описанием}
[ -f "$body_file" ] || die "нет файла $body_file"
repo="$FORGEJO_ADMIN_USER/$name"

label=$(api GET "/repos/$repo/labels" | jq -r '.[] | select(.name == "agent") | .id')
[ -n "$label" ] || die "нет метки agent: сначала scripts/setup-repo.sh $name"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
jq -n --arg t "$title" --rawfile b "$body_file" '{title: $t, body: $b}' >"$tmp/issue.json"
issue=$(api POST "/repos/$repo/issues" --data @"$tmp/issue.json" | jq -r .number)
api POST "/repos/$repo/issues/$issue/labels" --data "{\"labels\":[$label]}" >/dev/null
start=$(date +%s)
log "задача #$issue: $FORGEJO_URL/$repo/issues/$issue"

# wait_run СОБЫТИЕ ПОЛЕ НОМЕР - ждёт конца прогона, вызванного событием по задаче
# или PR с этим номером, и печатает "статус ссылка".
wait_run() {
	_i=0
	while :; do
		_r=$(api GET "/repos/$repo/actions/runs?limit=20" |
			jq -r --arg e "$1" --arg f "$2" --argjson n "$3" '[.workflow_runs[]
				| select(.event == $e and (.event_payload | fromjson | .[$f].number) == $n)][0]
				| select(. != null) | "\(.status) \(.html_url)"')
		case ${_r%% *} in
		success | failure | cancelled | skipped)
			printf '%s\n' "$_r"
			return 0
			;;
		esac
		_i=$((_i + 1))
		[ "$_i" -le 600 ] || die "прогон по $1 #$3 не закончился за 40 мин"
		sleep 4
	done
}

run=$(wait_run issues issue "$issue")
log "агент: $run"
[ "${run%% *}" = success ] || die "прогон агента не прошёл"

pr=$(api GET "/repos/$repo/pulls?state=open&limit=50" |
	jq -r --arg b "agent/issue-$issue" '[.[] | select(.head.ref == $b)][0] | select(. != null) | "\(.number) \(.html_url)"')
[ -n "$pr" ] || die "PR от бота не найден"
log "PR: ${pr#* }"

ci=$(wait_run pull_request pull_request "${pr%% *}")
log "проверки PR: $ci"
[ "${ci%% *}" = success ] || die "проверки PR не прошли"
log "от задачи до зелёного PR: $(($(date +%s) - start)) с"
