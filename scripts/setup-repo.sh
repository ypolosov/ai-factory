#!/bin/sh
# Готовит целевой репозиторий в Forgejo стенда: создаёт его из examples/ИМЯ,
# даёт боту право записи в ветки, защищает main, заводит метку agent, секреты
# и переменные исполнителя.
# Использование: scripts/setup-repo.sh ИМЯ [opencode|claude|codex] [модель]
# Модель по умолчанию: default (OpenCode - псевдоним шлюза, Codex - своя модель), sonnet (Claude Code).
# Повторный запуск безопасен: обновляет процессные файлы фабрики (.forgejo/),
# защиту, секреты и переменные; код проекта не трогает.
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need curl jq git mktemp
load_env
name=${1:?использование: scripts/setup-repo.sh ИМЯ [исполнитель] [модель]}
executor=${2:-opencode}
case $executor in
opencode | codex) model=${3:-default} ;;
claude) model=${3:-sonnet} ;;
*) die "исполнитель - opencode, claude или codex" ;;
esac
[ -d "examples/$name" ] || die "нет шаблона examples/$name"
[ -s .state/admin.token ] || die "сначала scripts/stand-up.sh"
case $executor in
claude) [ -s .state/claude-oauth.token ] || die "нет .state/claude-oauth.token: см. README, раздел о подписках" ;;
codex) [ -s .state/codex/auth.json ] || die "нет входа Codex в .state/codex: см. README, раздел о подписках" ;;
esac
owner=$FORGEJO_ADMIN_USER
repo="$owner/$name"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Тело запроса с секретом собирается из файла: секрет не попадает в аргументы команд.
secret_body() {
	jq -n --rawfile d "$1" '{data: ($d | rtrimstr("\n"))}' >"$tmp/body.json"
	chmod 600 "$tmp/body.json"
}

if ! api GET "/repos/$repo" >/dev/null 2>&1; then
	api POST /user/repos --data "{\"name\":\"$name\",\"private\":false,\"default_branch\":\"main\"}" >/dev/null
	log "репозиторий $repo создан"
fi

# Учётные данные для git - во временном файле хранилища, не в командной строке.
printf 'http://%s:%s@127.0.0.1:%s\n' "$owner" "$(cat .state/admin.token)" "$FORGEJO_HTTP_PORT" >"$tmp/creds"
chmod 600 "$tmp/creds"
g() {
	git -c credential.helper="store --file=$tmp/creds" \
		-c user.name="$owner" -c user.email="$FORGEJO_ADMIN_EMAIL" "$@"
}
if api GET "/repos/$repo/branches/main" >/dev/null 2>&1; then
	# Процессные файлы принадлежат фабрике: .forgejo/ приводится к шаблону.
	g clone -q --depth 1 "$FORGEJO_URL/$repo.git" "$tmp/src"
	rm -rf "$tmp/src/.forgejo"
	cp -R "examples/$name/.forgejo" "$tmp/src/"
	g -C "$tmp/src" add -A .forgejo
	if ! g -C "$tmp/src" diff --cached --quiet; then
		g -C "$tmp/src" commit -q -m "процессные файлы фабрики из шаблона ai-factory"
		g -C "$tmp/src" push -q origin main
		log "процессные файлы (.forgejo/) обновлены из шаблона"
	fi
else
	mkdir -p "$tmp/src"
	cp -R "examples/$name/." "$tmp/src/"
	g -C "$tmp/src" init -q -b main
	g -C "$tmp/src" add -A
	g -C "$tmp/src" commit -q -m "начальное содержимое из шаблона ai-factory"
	g -C "$tmp/src" push -q "$FORGEJO_URL/$repo.git" main
	log "начальное содержимое отправлено"
fi

api PUT "/repos/$repo/collaborators/$FORGEJO_BOT_USER" --data '{"permission":"write"}' >/dev/null
log "бот $FORGEJO_BOT_USER: право записи в ветки"

# main пишет и сливает только человек (администратор стенда), и только при зелёных проверках.
jq -n --arg u "$owner" '{enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: [$u],
	enable_merge_whitelist: true, merge_whitelist_usernames: [$u],
	enable_status_check: true, status_check_contexts: ["ci / test (pull_request)"],
	required_approvals: 0, block_on_rejected_reviews: true, dismiss_stale_approvals: true}' >"$tmp/protect.json"
if api GET "/repos/$repo/branch_protections/main" >/dev/null 2>&1; then
	api PATCH "/repos/$repo/branch_protections/main" --data @"$tmp/protect.json" >/dev/null
else
	jq '. + {rule_name: "main"}' "$tmp/protect.json" >"$tmp/protect-new.json"
	api POST "/repos/$repo/branch_protections" --data @"$tmp/protect-new.json" >/dev/null
fi
log "main защищена: пишет и сливает только $owner, нужна зелёная проверка ci / test"

if ! api GET "/repos/$repo/labels" | jq -e '.[] | select(.name == "agent")' >/dev/null; then
	api POST "/repos/$repo/labels" \
		--data '{"name":"agent","color":"#bf4520","description":"задачу берёт агент фабрики"}' >/dev/null
	log "метка agent заведена"
fi

# put_secret ИМЯ ФАЙЛ - секрет репозитория из файла.
put_secret() {
	secret_body "$2"
	api PUT "/repos/$repo/actions/secrets/$1" --data @"$tmp/body.json" >/dev/null
	secrets="${secrets:+$secrets, }$1"
}
put_secret AGENT_GATEWAY_KEY .state/gw-agent-api.key
put_secret AGENT_SUB_GATEWAY_KEY .state/gw-agent-sub.key
put_secret BOT_TOKEN .state/bot.token
# Входы подписок владельца - если есть; задание отдаёт их только своему исполнителю.
[ ! -s .state/claude-oauth.token ] || put_secret CLAUDE_CODE_OAUTH_TOKEN .state/claude-oauth.token
[ ! -s .state/codex/auth.json ] || put_secret CODEX_AUTH_JSON .state/codex/auth.json
log "секреты: $secrets"

for pair in "FACTORY_EXECUTOR=$executor" "FACTORY_MODEL=$model"; do
	var=${pair%%=*}
	val=${pair#*=}
	jq -n --arg v "$val" '{value: $v}' >"$tmp/body.json"
	api PUT "/repos/$repo/actions/variables/$var" --data @"$tmp/body.json" >/dev/null 2>&1 ||
		api POST "/repos/$repo/actions/variables/$var" --data @"$tmp/body.json" >/dev/null
done
log "исполнитель: $executor, модель: $model"
log "готово: $FORGEJO_URL/$repo"
