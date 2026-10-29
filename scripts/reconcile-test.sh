#!/bin/sh
# Регрессии публикации сверщика: настоящий скрипт в образе задания,
# ответ OpenCode и HTTP API - фикстуры, обращений к моделям нет.
set -eu

image="factory/agent:reconcile-test-$$"
tmp=$(mktemp -d)
cleanup() {
	docker image rm "$image" >/dev/null 2>&1 || true
	rm -rf "$tmp"
}
trap cleanup EXIT INT TERM
chmod 755 "$tmp"
cp package.json package-lock.json vitest.config.ts "$tmp/"
mkdir -p "$tmp/images/agent"
cp -R images/agent/. "$tmp/images/agent/"

docker build -t "$image" images/agent
docker run --rm --cpus 2 --memory 2g -u 0:0 \
	-e FACTORY_RECONCILE_TEST=1 -e HOME=/tmp \
	-v "$tmp:/src:ro" -w /tmp/reconcile --entrypoint sh "$image" -c '
	cp -R /src/. . && npm ci --no-audit --no-fund --silent &&
	npx vitest run images/agent/test/reconcile.test.ts
'
