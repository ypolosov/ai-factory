#!/bin/sh
# Руководства "Как пользоваться фабрикой" (docs/publications/guides). Писатель (Claude Code) и
# судья (Codex) - программы владельца на этой машине по подписке, поэтому Node - тот, что на
# машине, а не в Docker. С --confluence - публикация подтверждённого руководства в пространство
# публикаций; учётка - из .state/atlassian.env, в Node попадает через окружение, писатель и
# судья её не получают. Запуск из корня репозитория: scripts/make-guides.sh [--confluence]
set -eu

LIKEC4_IMAGE=docker.io/likec4/likec4:1.59.4
state=${STATE_DIR:-.state}

mkdir -p .publications
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/docs/model":/model:ro -v "$PWD/.publications":/out \
	"$LIKEC4_IMAGE" export json -o /out/likec4.json /model

if [ "${1:-}" = --confluence ]; then
	umask 077
	tmp=$(mktemp -d)
	sed 's/\r$//' "$state/atlassian.env" >"$tmp/env"
	# shellcheck disable=SC1091
	. "$tmp/env"
	rm -f "$tmp/env"
	rmdir "$tmp"
	export ATLASSIAN_SITE ATLASSIAN_EMAIL CONFLUENCE_API_TOKEN CONFLUENCE_PUBLICATIONS_SPACE
	exec node --no-warnings images/publisher/make-guides.ts .publications/likec4.json docs/model docs/publications/guides --confluence
fi
exec node --no-warnings images/publisher/make-guides.ts .publications/likec4.json docs/model docs/publications/guides
