#!/bin/sh
# Проверка платформ демо (docs/demo/platforms.md): есть ли файлы .state/*.env с нужными
# именами и пускают ли токены на чтение. Значения не печатаются: токены и секретные адреса
# уходят в curl через файлы заголовков и конфигурации, а не через аргументы команд.
# Запуск из корня репозитория: scripts/platforms-check.sh
set -eu

state=${STATE_DIR:-.state}
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
fails=0
UA='User-Agent: DiscordBot (https://github.com/ypolosov/ai-factory, 1)'

ok() { printf '  ок   %s\n' "$*"; }
bad() {
	printf '  НЕТ  %s\n' "$*"
	fails=$((fails + 1))
}

# load ФАЙЛ ИМЯ... - читает файл окружения (без \r Windows) и проверяет, что имена заданы.
load() {
	_f="$state/$1"
	shift
	if [ ! -f "$_f" ]; then
		bad "$_f: файла нет"
		return 1
	fi
	_mode=$(stat -c %a "$_f")
	[ "$_mode" = 600 ] || bad "$_f: права $_mode, нужны 600"
	sed 's/\r$//' "$_f" >"$tmp/env"
	# shellcheck disable=SC1091
	. "$tmp/env"
	rm -f "$tmp/env"
	_missing=
	for _n in "$@"; do
		eval "_v=\${$_n:-}"
		[ -n "$_v" ] || _missing="$_missing $_n"
	done
	if [ -n "$_missing" ]; then
		bad "$_f: не заданы:$_missing"
		return 1
	fi
	ok "$_f: имена заданы, права 600"
}

# auth ЗНАЧЕНИЕ - заголовок авторизации в файл для curl -H @файл.
auth() { printf 'Authorization: %s\n' "$1" >"$tmp/h"; }
basic() { auth "Basic $(printf '%s:%s' "$1" "$2" | base64 | tr -d '\n')"; }

# get АДРЕС - GET с заголовком из $tmp/h; тело - в $tmp/body, заголовки - в $tmp/head,
# код ответа - в stdout. Адрес идёт через файл конфигурации curl: он может быть секретом.
get() {
	printf 'url = "%s"\n' "$1" >"$tmp/cfg"
	curl -sS -K "$tmp/cfg" -H @"$tmp/h" -H "$UA" -D "$tmp/head" -o "$tmp/body" -w '%{http_code}' 2>/dev/null || echo 000
}
field() { jq -r "$1" "$tmp/body" 2>/dev/null; }

echo "Jira и Confluence"
if load atlassian.env ATLASSIAN_SITE ATLASSIAN_EMAIL JIRA_API_TOKEN CONFLUENCE_API_TOKEN JIRA_PROJECT CONFLUENCE_SPACE; then
	site=${ATLASSIAN_SITE%/}
	cloud=$(curl -sS "$site/_edge/tenant_info" 2>/dev/null | jq -r '.cloudId // empty' 2>/dev/null || true)
	if [ -n "$cloud" ]; then
		ok "сайт $site, cloudId получен"
		basic "$ATLASSIAN_EMAIL" "$JIRA_API_TOKEN"
		code=$(get "https://api.atlassian.com/ex/jira/$cloud/rest/api/3/myself")
		if [ "$code" = 200 ]; then ok "Jira: вход как $(field .displayName)"; else bad "Jira: myself -> $code $(field '.message // .errorMessages[0] // empty')"; fi
		code=$(get "https://api.atlassian.com/ex/jira/$cloud/rest/api/3/project/$JIRA_PROJECT")
		if [ "$code" = 200 ]; then ok "Jira: проект $(field '.key + " - " + .name')"; else bad "Jira: проект $JIRA_PROJECT -> $code"; fi
		basic "$ATLASSIAN_EMAIL" "$CONFLUENCE_API_TOKEN"
		code=$(get "https://api.atlassian.com/ex/confluence/$cloud/wiki/rest/api/space/$CONFLUENCE_SPACE")
		if [ "$code" = 200 ]; then
			ok "Confluence: пространство $(field '.key + " - " + .name')"
		else
			code2=$(get "https://api.atlassian.com/ex/confluence/$cloud/wiki/api/v2/spaces?keys=$CONFLUENCE_SPACE")
			if [ "$code2" = 200 ] && [ -n "$(field '.results[0].key // empty')" ]; then
				ok "Confluence: пространство $(field '.results[0].key + " - " + .results[0].name')"
			else
				bad "Confluence: пространство $CONFLUENCE_SPACE -> v1 $code, v2 $code2 $(field '.message // empty')"
			fi
		fi
	else
		bad "сайт $site: cloudId не получен"
	fi
fi

echo "Bitbucket"
if load bitbucket.env BITBUCKET_WORKSPACE BITBUCKET_REPO BITBUCKET_TOKEN; then
	repo="https://api.bitbucket.org/2.0/repositories/$BITBUCKET_WORKSPACE/$BITBUCKET_REPO"
	auth "Bearer $BITBUCKET_TOKEN"
	code=$(get "$repo")
	if [ "$code" = 401 ] && [ -n "${ATLASSIAN_EMAIL:-}" ]; then
		basic "$ATLASSIAN_EMAIL" "$BITBUCKET_TOKEN"
		code=$(get "$repo")
	fi
	if [ "$code" = 200 ]; then
		ok "репозиторий $(field .full_name), закрытый: $(field .is_private)"
		ok "права токена: $(sed -n 's/^x-oauth-scopes: *//Ip' "$tmp/head" | tr -d '\r')"
		code=$(get "$repo/pipelines/?pagelen=1")
		if [ "$code" = 200 ]; then ok "Pipelines: список прогонов читается"; else bad "Pipelines: список прогонов -> $code $(field '.error.message // empty')"; fi
		code=$(get "$repo/pipelines_config/variables")
		if [ "$code" = 200 ]; then ok "Pipelines: переменные доступны"; else bad "Pipelines: переменные -> $code $(field '.error.message // empty')"; fi
	else
		bad "репозиторий $BITBUCKET_WORKSPACE/$BITBUCKET_REPO -> $code $(field '.error.message // empty')"
	fi
fi
load bitbucket-runner.env ACCOUNT_UUID REPOSITORY_UUID RUNNER_UUID OAUTH_CLIENT_ID OAUTH_CLIENT_SECRET || true

echo "GitHub"
if load github-target.env GITHUB_TARGET_REPO GITHUB_READ_TOKEN GITHUB_PUBLISH_TOKEN; then
	for kind in READ PUBLISH; do
		tok=$GITHUB_READ_TOKEN
		[ "$kind" = READ ] || tok=$GITHUB_PUBLISH_TOKEN
		auth "Bearer $tok"
		code=$(get "https://api.github.com/repos/$GITHUB_TARGET_REPO")
		exp=$(sed -n 's/^github-authentication-token-expiration: *//Ip' "$tmp/head" | tr -d '\r')
		if [ "$code" = 200 ]; then ok "токен $kind: доступ к $(field .full_name); истекает: ${exp:-не указано}"; else bad "токен $kind: $GITHUB_TARGET_REPO -> $code $(field '.message // empty')"; fi
	done
fi

echo "Discord"
if load discord.env DISCORD_APPLICATION_ID DISCORD_BOT_TOKEN DISCORD_GUILD_ID DISCORD_DRAW_WEBHOOK_URL; then
	auth "Bot $DISCORD_BOT_TOKEN"
	code=$(get "https://discord.com/api/v10/users/@me")
	if [ "$code" = 200 ]; then ok "бот: $(field .username)"; else bad "бот: users/@me -> $code $(field '.message // empty')"; fi
	code=$(get "https://discord.com/api/v10/applications/@me")
	if [ "$code" = 200 ]; then
		if [ "$(field .id)" = "$DISCORD_APPLICATION_ID" ]; then ok "приложение: $(field .name), ID совпадает"; else bad "приложение: ID в файле не совпадает с ID бота"; fi
		flags=$(field '.flags // 0')
		# 1<<18 - намерение Message Content одобрено, 1<<19 - включено (до 100 серверов).
		if [ $((flags & 786432)) -ne 0 ]; then ok "намерение Message Content включено"; else bad "намерение Message Content выключено"; fi
	else
		bad "приложение: applications/@me -> $code"
	fi
	code=$(get "https://discord.com/api/v10/guilds/$DISCORD_GUILD_ID")
	if [ "$code" = 200 ]; then ok "сервер: $(field .name), бот на нём"; else bad "сервер $DISCORD_GUILD_ID -> $code (бот не приглашён?)"; fi
	code=$(get "https://discord.com/api/v10/guilds/$DISCORD_GUILD_ID/channels")
	if [ "$code" = 200 ]; then
		ok "каналы: $(field '[.[] | select(.type == 0) | .name] | join(", ")')"
		cp "$tmp/body" "$tmp/channels"
	fi
	auth "X-Check: platforms"
	code=$(get "$DISCORD_DRAW_WEBHOOK_URL")
	if [ "$code" = 200 ]; then
		ch=$(field .channel_id)
		name=$(jq -r --arg id "$ch" '.[] | select(.id == $id) | .name' "$tmp/channels" 2>/dev/null || true)
		ok "вебхук: $(field .name), канал ${name:-$ch}"
	else
		bad "вебхук -> $code"
	fi
fi

echo "Figma"
if load figma.env FIGMA_TOKEN; then
	printf 'X-Figma-Token: %s\n' "$FIGMA_TOKEN" >"$tmp/h"
	code=$(get "https://api.figma.com/v1/me")
	case $code in
	200) ok "вход как $(field .handle)" ;;
	403) if field '.err // empty' | grep -qi 'invalid'; then bad "токен Figma не принят"; else ok "токен принят; /v1/me без области current_user:read недоступен - не нужен"; fi ;;
	*) bad "Figma: /v1/me -> $code $(field '.err // empty')" ;;
	esac
	[ -n "${FIGMA_FILE_KEY:-}" ] && ok "ключ файла задан; файл не читаю - бесплатный лимит 6-20 чтений в месяц"
fi

echo
if [ "$fails" -eq 0 ]; then echo "Итог: всё на месте."; else echo "Итог: проблем - $fails."; fi
[ "$fails" -eq 0 ]
