#!/bin/sh
# Выкладка вручную: scripts/deploy.sh ПРИЛОЖЕНИЕ [SHA] (по умолчанию - текущий main).
# Обычно не нужна: служба выкладки сама выкладывает новые коммиты main.
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need docker curl jq
load_env
app=${1:?использование: scripts/deploy.sh ПРИЛОЖЕНИЕ [SHA]}
sha=${2:-$(api GET "/repos/$FORGEJO_ADMIN_USER/$app/branches/main" | jq -r .commit.id)}
docker compose exec -T deployer deployer deploy "$app" "$sha"
