#!/bin/sh
# Отчёт фабрики (images/report/report.ts): четыре числа учёта - цена принятого изменения,
# время от задачи до стенда по участкам, доля слитых с первой попытки по исполнителю и
# модели, DORA выкладок - и сравнение исполнителей. Markdown - в стандартный вывод.
# Использование: scripts/factory-report.sh [РЕПОЗИТОРИЙ...] (по умолчанию - из DEPLOY_APPS)
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need docker sqlite3
load_env
if [ $# -gt 0 ]; then
	repos=$(for r in "$@"; do printf '%s/%s ' "$FORGEJO_ADMIN_USER" "$r"; done)
else
	repos=$(for e in $DEPLOY_APPS; do printf '%s ' "${e%%=*}"; done)
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Снимок журнала шлюза: шлюз пишет в него в это же время.
# Снимок - без журнала WAL: его можно открыть только на чтение.
sqlite3 "file:.state/gateway-db/gateway.sqlite?mode=ro" ".backup '$tmp/gateway.sqlite'"
sqlite3 "$tmp/gateway.sqlite" "PRAGMA journal_mode=DELETE;" >/dev/null
(umask 077 && cp .state/admin.token "$tmp/admin.token")
chmod 755 "$tmp"
chmod 644 "$tmp/gateway.sqlite" "$tmp/admin.token"
docker run --rm -u 1000:1000 --network ai-factory_factory \
	-e FORGEJO_URL=http://forgejo:3000 -e REPOS="$repos" -e DB=/data/gateway.sqlite -e SECRETS_DIR=/data \
	-v "$PWD/images/report:/app:ro" -v "$tmp:/data:ro" \
	docker.io/library/node:24.21.0-alpine3.24 node --no-warnings /app/report.ts
