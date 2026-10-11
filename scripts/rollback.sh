#!/bin/sh
# Откат на стенде: scripts/rollback.sh ПРИЛОЖЕНИЕ [ТЕГ] (по умолчанию - прошлая версия).
# Теги: ПРИЛОЖЕНИЕ:первые-12-знаков-коммита; что выложено - scripts/rollback.sh ПРИЛОЖЕНИЕ status.
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need docker
app=${1:?использование: scripts/rollback.sh ПРИЛОЖЕНИЕ [ТЕГ | status]}
if [ "${2:-}" = status ]; then
	docker compose exec -T deployer deployer status "$app"
else
	docker compose exec -T deployer deployer rollback "$app" "${2:-}"
fi
