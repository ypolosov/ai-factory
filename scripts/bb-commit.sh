#!/bin/sh
# bb-commit.sh СООБЩЕНИЕ ФАЙЛ ПУТЬ_В_РЕПОЗИТОРИИ - коммит одного файла в main репозитория
# фабрики на Bitbucket через API (без клона и без токена в адресе git).
set -eu

[ $# -eq 3 ] || {
	echo "использование: $0 СООБЩЕНИЕ ФАЙЛ ПУТЬ_В_РЕПОЗИТОРИИ" >&2
	exit 2
}
state=${STATE_DIR:-.state}
umask 077
tmp=$(mktemp -d)
cleanup() {
	rm -f "$tmp/env" "$tmp/h"
	rmdir "$tmp"
}
trap cleanup EXIT INT TERM
sed 's/\r$//' "$state/bitbucket.env" >"$tmp/env"
# shellcheck disable=SC1091
. "$tmp/env"
rm -f "$tmp/env"
printf 'Authorization: Bearer %s\n' "$BITBUCKET_TOKEN" >"$tmp/h"

curl -sS -H @"$tmp/h" -o /dev/null -w '%{http_code}\n' \
	-F "message=$1" -F "branch=main" -F "$3=@$2" \
	"https://api.bitbucket.org/2.0/repositories/$BITBUCKET_WORKSPACE/$BITBUCKET_REPO/src"
