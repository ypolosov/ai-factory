#!/bin/sh
# Проверка ядра стенда: пустышка с заданиями на трёх runner должна пройти.
# Каждый запуск делает новый коммит в репозиторий smoke и ждёт итог прогона.
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need curl jq git mktemp
load_env
[ -s .state/admin.token ] || die "сначала scripts/stand-up.sh"

owner=$FORGEJO_ADMIN_USER
repo=smoke
if ! api GET "/repos/$owner/$repo" >/dev/null 2>&1; then
	api POST /user/repos --data "{\"name\":\"$repo\",\"private\":false}" >/dev/null
	log "репозиторий $owner/$repo создан"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -R examples/smoke/. "$tmp/"
git -C "$tmp" init -q -b main
git -C "$tmp" add -A
git -C "$tmp" -c user.name=factory-smoke -c user.email=smoke@factory.local \
	commit -q -m "smoke $(date -u +%Y-%m-%dT%H:%M:%SZ)"
sha=$(git -C "$tmp" rev-parse HEAD)

# Учётные данные для git - во временном файле хранилища, не в командной строке.
creds="$tmp/.git-credentials"
printf 'http://%s:%s@127.0.0.1:%s\n' "$owner" "$(cat .state/admin.token)" "$FORGEJO_HTTP_PORT" >"$creds"
chmod 600 "$creds"
git -C "$tmp" -c credential.helper="store --file=$creds" push -q -f "$FORGEJO_URL/$owner/$repo.git" main
log "коммит $sha отправлен, жду прогон"

i=0
status=none
while :; do
	status=$(api GET "/repos/$owner/$repo/actions/runs?head_sha=$sha" | jq -r '.workflow_runs[0].status // "none"')
	case $status in
	success | failure | cancelled | skipped) break ;;
	esac
	i=$((i + 1))
	[ "$i" -le 300 ] || die "прогон не закончился за 10 мин, статус $status"
	sleep 2
done

api GET "/repos/$owner/$repo/actions/tasks?limit=50" |
	jq -r --arg s "$sha" '.workflow_runs[] | select(.head_sha == $s) | "  \(.name): \(.status)"' >&2
[ "$status" = success ] || die "пустышка: $status"
log "пустышка зелёная: $FORGEJO_URL/$owner/$repo/actions"
