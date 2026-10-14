#!/bin/sh
# Контрактные тесты портов на облачных носителях - песочницах Jira (проект FCT) и GitHub
# (ypolosov/factory-contract-tests). Учётки - из .state/atlassian.env и .state/github-target.env;
# токены попадают в Node только через файл окружения, не через аргументы команд.
# Запуск из корня репозитория: scripts/port-contract-saas.sh [jira|github]
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
	files="$files images/ports/test/github.test.ts"
fi
rm -f "$tmp/env"

# shellcheck disable=SC2086
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --env-file "$tmp/test.env" \
	-v "$PWD":/w -w /w "$NODE_IMAGE" node --test $files
