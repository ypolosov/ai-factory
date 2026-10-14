#!/bin/sh
# Контрактные тесты портов на живом носителе: одноразовый Forgejo в своей сети,
# учётка и токен внутри контейнера, тесты в Node 24, затем всё удаляется.
# Токен не попадает в аргументы команд: только в файл окружения во временном каталоге.
set -eu

FORGEJO_IMAGE=codeberg.org/forgejo/forgejo:15.0.9
NODE_IMAGE=docker.io/library/node:24.21.0-alpine3.24
name="port-contract-$$"
tmp=$(mktemp -d)

cleanup() {
	docker rm -f "$name" >/dev/null 2>&1 || true
	docker network rm "$name" >/dev/null 2>&1 || true
	rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

docker network create "$name" >/dev/null
docker run -d --name "$name" --network "$name" \
	-e USER_UID=1000 -e USER_GID=1000 \
	-e FORGEJO__database__DB_TYPE=sqlite3 \
	-e FORGEJO__security__INSTALL_LOCK=true \
	-e FORGEJO__server__ROOT_URL="http://$name:3000/" \
	-e FORGEJO__server__DISABLE_SSH=true \
	-e FORGEJO__repository__DEFAULT_BRANCH=main \
	"$FORGEJO_IMAGE" >/dev/null

i=0
until docker exec "$name" wget -qO- http://127.0.0.1:3000/api/healthz >/dev/null 2>&1; do
	i=$((i + 1))
	[ "$i" -le 60 ] || {
		echo "Forgejo не поднялся за 120 с" >&2
		exit 1
	}
	sleep 2
done

docker exec -u git "$name" forgejo admin user create --admin --username contract \
	--email contract@example.org --random-password --must-change-password=false >/dev/null
umask 077
{
	printf 'FORGEJO_TEST_URL=http://%s:3000\n' "$name"
	printf 'FORGEJO_TEST_TOKEN='
	docker exec -u git "$name" forgejo admin user generate-access-token --username contract \
		--token-name contract --scopes all --raw
} >"$tmp/env"

docker run --rm --network "$name" -u "$(id -u):$(id -g)" -e HOME=/tmp --env-file "$tmp/env" \
	-v "$PWD":/w -w /w "$NODE_IMAGE" sh -c 'npm ci --no-audit --no-fund --silent && npx vitest run images/ports/test/forgejo.test.ts'
