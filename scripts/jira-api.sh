#!/bin/sh
# jira-api.sh МЕТОД ПУТЬ [ФАЙЛ_ТЕЛА_JSON] - запрос к API Jira (.state/atlassian.env) токеном
# с областями через api.atlassian.com. ПУТЬ - от /rest/api/3, например /myself.
# Токен - в файле заголовка, а не в аргументах команд.
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

sed 's/\r$//' "$state/atlassian.env" >"$tmp/env"
# shellcheck disable=SC1091
. "$tmp/env"
rm -f "$tmp/env"
cloud=$(curl -sS "${ATLASSIAN_SITE%/}/_edge/tenant_info" | jq -r .cloudId)
printf 'Authorization: Basic %s\n' "$(printf '%s:%s' "$ATLASSIAN_EMAIL" "$JIRA_API_TOKEN" | base64 | tr -d '\n')" >"$tmp/h"
base="https://api.atlassian.com/ex/jira/$cloud/rest/api/3"

if [ $# -ge 3 ]; then
	curl -sS -X "$1" -H @"$tmp/h" -H 'Content-Type: application/json' --data @"$3" -w '\n%{http_code}\n' "$base$2"
else
	curl -sS -X "$1" -H @"$tmp/h" -w '\n%{http_code}\n' "$base$2"
fi
