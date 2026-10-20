#!/bin/sh
# Контрактные тесты портов на облачных носителях - песочницах Jira (проект FCT) и GitHub
# (ypolosov/factory-contract-tests) и на Bitbucket Pipelines репозитория фабрики (свой раннер
# стенда должен работать: docker compose --profile bitbucket up -d). Учётки - из
# .state/atlassian.env, .state/github-target.env и .state/bitbucket.env; токены попадают
# в Node только через файл окружения, не через аргументы команд.
# Доска Miro - песочница MIRO_TEST_BOARD из .state/miro.env.
# Запуск из корня репозитория: scripts/port-contract-saas.sh [jira|github|confluence|bitbucket|miro]
set -eu

NODE_IMAGE=docker.io/library/node:24.21.0-alpine3.24
state=${STATE_DIR:-.state}
only=${1:-all}
umask 077
tmp=$(mktemp -d)
cleanup() {
	rm -f "$tmp/env" "$tmp/test.env"
	rmdir "$tmp"
}
trap cleanup EXIT INT TERM

: >"$tmp/test.env"
files=
if [ "$only" = all ] || [ "$only" = jira ]; then
	sed 's/\r$//' "$state/atlassian.env" >"$tmp/env"
	# shellcheck disable=SC1091
	. "$tmp/env"
	{
		printf 'JIRA_TEST_SITE=%s\n' "$ATLASSIAN_SITE"
		printf 'JIRA_TEST_EMAIL=%s\n' "$ATLASSIAN_EMAIL"
		printf 'JIRA_TEST_TOKEN=%s\n' "$JIRA_API_TOKEN"
		printf 'JIRA_TEST_PROJECT=%s\n' "${JIRA_TEST_PROJECT:-FCT}"
	} >>"$tmp/test.env"
	files="$files images/ports/test/jira.test.ts"
fi
if [ "$only" = all ] || [ "$only" = github ]; then
	sed 's/\r$//' "$state/github-target.env" >"$tmp/env"
	# shellcheck disable=SC1091
	. "$tmp/env"
	{
		printf 'GITHUB_TEST_REPO=%s\n' "${GITHUB_CONTRACT_REPO:-ypolosov/factory-contract-tests}"
		printf 'GITHUB_TEST_TOKEN=%s\n' "$GITHUB_PUBLISH_TOKEN"
	} >>"$tmp/test.env"
	files="$files images/ports/test/github.test.ts images/ports/test/github-ci.test.ts"
fi
if [ "$only" = all ] || [ "$only" = confluence ]; then
	sed 's/\r$//' "$state/atlassian.env" >"$tmp/env"
	# shellcheck disable=SC1091
	. "$tmp/env"
	{
		printf 'CONFLUENCE_TEST_SITE=%s\n' "$ATLASSIAN_SITE"
		printf 'CONFLUENCE_TEST_EMAIL=%s\n' "$ATLASSIAN_EMAIL"
		printf 'CONFLUENCE_TEST_TOKEN=%s\n' "$CONFLUENCE_API_TOKEN"
		printf 'CONFLUENCE_TEST_SPACE=%s\n' "$CONFLUENCE_SPACE"
	} >>"$tmp/test.env"
	files="$files images/ports/test/confluence.test.ts"
fi
if [ "$only" = all ] || [ "$only" = bitbucket ]; then
	sed 's/\r$//' "$state/bitbucket.env" >"$tmp/env"
	# shellcheck disable=SC1091
	. "$tmp/env"
	{
		printf 'BITBUCKET_TEST_WORKSPACE=%s\n' "$BITBUCKET_WORKSPACE"
		printf 'BITBUCKET_TEST_REPO=%s\n' "$BITBUCKET_REPO"
		printf 'BITBUCKET_TEST_TOKEN=%s\n' "$BITBUCKET_TOKEN"
	} >>"$tmp/test.env"
	files="$files images/ports/test/bitbucket.test.ts"
fi
if [ "$only" = all ] || [ "$only" = miro ]; then
	sed 's/\r$//' "$state/miro.env" >"$tmp/env"
	# shellcheck disable=SC1091
	. "$tmp/env"
	{
		printf 'MIRO_TEST_TOKEN=%s\n' "$MIRO_TOKEN"
		printf 'MIRO_TEST_BOARD=%s\n' "$MIRO_TEST_BOARD"
	} >>"$tmp/test.env"
	files="$files images/ports/test/miro.test.ts"
fi
rm -f "$tmp/env"

docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --env-file "$tmp/test.env" \
	-v "$PWD":/w -w /w "$NODE_IMAGE" sh -c "npm ci --no-audit --no-fund --silent && npx vitest run$files"
