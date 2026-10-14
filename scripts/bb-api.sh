#!/bin/sh
# bb-api.sh МЕТОД ПУТЬ [ФАЙЛ_ТЕЛА_JSON] - запрос к API Bitbucket репозитория фабрики
# (.state/bitbucket.env) от имени токена репозитория. ПУТЬ - от адреса репозитория,
# например /pipelines/. Токен - в файле заголовка, а не в аргументах команд.
# Вывод: тело ответа, последней строкой - код ответа HTTP.
set -eu

[ $# -ge 2 ] || {
	echo "использование: $0 МЕТОД ПУТЬ [ФАЙЛ_ТЕЛА_JSON]" >&2
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
base="https://api.bitbucket.org/2.0/repositories/$BITBUCKET_WORKSPACE/$BITBUCKET_REPO"

if [ $# -ge 3 ]; then
	curl -sS -X "$1" -H @"$tmp/h" -H 'Content-Type: application/json' --data @"$3" -w '\n%{http_code}\n' "$base$2"
else
	curl -sS -X "$1" -H @"$tmp/h" -w '\n%{http_code}\n' "$base$2"
fi
