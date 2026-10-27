#!/bin/sh
# Публикация видов модели (docs/model) на доску Miro публикаций. Токен и доска - из
# .state/miro.env (MIRO_TOKEN, MIRO_BOARD); в Node попадают только через файл окружения.
# Карта "элемент модели -> элемент доски" - docs/publications/miro.json (в git).
# Запуск из корня репозитория: scripts/publish-miro.sh
set -eu

NODE_IMAGE=docker.io/library/node:24.21.0-alpine3.24
LIKEC4_IMAGE=docker.io/likec4/likec4:1.59.4
state=${STATE_DIR:-.state}
umask 077
tmp=$(mktemp -d)
cleanup() {
	rm -f "$tmp/env" "$tmp/run.env"
	rmdir "$tmp"
}
trap cleanup EXIT INT TERM

sed 's/\r$//' "$state/miro.env" >"$tmp/env"
# shellcheck disable=SC1091
. "$tmp/env"
{
	printf 'MIRO_TOKEN=%s\n' "$MIRO_TOKEN"
	printf 'MIRO_BOARD=%s\n' "$MIRO_BOARD"
} >"$tmp/run.env"
rm -f "$tmp/env"

mkdir -p .publications
docker run --rm -u "$(scripts/host-user.sh)" -e HOME=/tmp -v "$PWD/docs/model":/model:ro -v "$PWD/.publications":/out \
	"$LIKEC4_IMAGE" export json -o /out/likec4.json /model
docker run --rm -u "$(scripts/host-user.sh)" --env-file "$tmp/run.env" -v "$PWD":/w -w /w "$NODE_IMAGE" \
	node --no-warnings images/publisher/publish.ts .publications/likec4.json docs/model miro docs/publications/miro.json
