#!/bin/sh
# demo-reset.sh [-n] - бережный сброс стенда перед дублем видео-демо: прошлые дубли уходят из кадра,
# ничего не удаляется. Всё, что создаёт съёмка, несёт метку film (images/camera/script.ts):
# - страницы Confluence с меткой film теряют метку story (сверщик их больше не берёт), получают
#   в заголовок пометку архива (заголовок снова свободен для дубля) и уходят под "Архив съёмок";
# - незакрытые задачи Jira с меткой film закрываются;
# - открытые PR агентов по задачам с меткой film закрываются, ветки остаются.
# -n - только показать, что будет сделано. Ключи - .state/atlassian.env и .state/github-target.env.
# Запуск из корня репозитория.
set -eu

dry=
[ "${1:-}" != -n ] || dry=1
label=film
archive="Архив съёмок"
state=${STATE_DIR:-.state}
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
for f in atlassian.env github-target.env; do sed 's/\r$//' "$state/$f" >>"$tmp/env"; done
# shellcheck disable=SC1091
. "$tmp/env"
rm -f "$tmp/env"
basic() { printf 'Authorization: Basic %s\n' "$(printf '%s:%s' "$ATLASSIAN_EMAIL" "$1" | base64 | tr -d '\n')"; }
basic "$JIRA_API_TOKEN" >"$tmp/jira"
basic "$CONFLUENCE_API_TOKEN" >"$tmp/wiki"
printf 'Authorization: Bearer %s\n' "$GITHUB_PUBLISH_TOKEN" >"$tmp/gh"
cloud=$(curl -fsS "${ATLASSIAN_SITE%/}/_edge/tenant_info" | jq -r .cloudId)
J=https://api.atlassian.com/ex/jira/$cloud/rest/api/3
C=https://api.atlassian.com/ex/confluence/$cloud/wiki/rest/api
G=https://api.github.com/repos/$GITHUB_TARGET_REPO
# api КЛЮЧ МЕТОД URL [ТЕЛО] - запрос с телом JSON; ответ не 2xx - ошибка с кодом, без тела.
api() {
	code=$(curl -sS -o "$tmp/out" -w '%{http_code}' -X "$2" -H @"$tmp/$1" -H 'Content-Type: application/json' \
		-H 'Accept: application/json' ${4:+--data "$4"} "$3")
	case $code in
	2??) cat "$tmp/out" ;;
	*)
		echo "сбой $2 ${3%%\?*}: $code" >&2
		return 1
		;;
	esac
}
uri() { jq -rn --arg q "$1" '$q | @uri'; }
# plan ЧТО - назвать действие; в проверке без изменений (-n) действие пропускается.
plan() {
	echo "$1"
	[ -n "$dry" ]
}

# Confluence: страница-архив и страницы прошлых дублей вне её.
space="space = \"$CONFLUENCE_SPACE\" and type = page"
parent=$(api wiki GET "$C/content/search?cql=$(uri "$space and title = \"$archive\"")&limit=1" | jq -r '.results[0].id // empty')
if [ -z "$parent" ] && ! plan "Confluence: создать страницу \"$archive\""; then
	body=$(jq -cn --arg t "$archive" --arg s "$CONFLUENCE_SPACE" \
		'{type: "page", title: $t, space: {key: $s}, body: {storage: {representation: "storage", value: "<p>Страницы прошлых дублей видео-демо: scripts/demo-reset.sh.</p>"}}}')
	parent=$(api wiki POST "$C/content" "$body" | jq -r .id)
fi
api wiki GET "$C/content/search?cql=$(uri "$space and label = \"$label\"")&expand=version,ancestors,body.storage&limit=100" |
	jq -c --arg p "${parent:-none}" '.results[] | select(all(.ancestors[]; .id != $p))' >"$tmp/pages"
while IFS= read -r p; do
	id=$(printf '%s' "$p" | jq -r .id)
	title="[архив $id] $(printf '%s' "$p" | jq -r .title)"
	plan "Confluence: $title - в архив" && continue
	curl -sS -o /dev/null -X DELETE -H @"$tmp/wiki" "$C/content/$id/label/story"
	body=$(printf '%s' "$p" | jq -c --arg t "$title" --arg p "$parent" \
		'{id, type: "page", title: $t, version: {number: (.version.number + 1)}, ancestors: [{id: $p}], body: {storage: {representation: "storage", value: .body.storage.value}}}')
	api wiki PUT "$C/content/$id" "$body" >/dev/null
done <"$tmp/pages"

# Jira: задачи прошлых дублей; незакрытые - закрыть.
api jira GET "$J/search/jql?jql=$(uri "project = $JIRA_PROJECT AND labels = $label")&fields=status&maxResults=100" |
	jq -r '.issues[] | [.key, .fields.status.statusCategory.key] | @tsv' >"$tmp/issues"
while IFS="$(printf '\t')" read -r key cat; do
	[ "$cat" != "done" ] || continue
	plan "Jira: $key - закрыть" && continue
	t=$(api jira GET "$J/issue/$key/transitions" | jq -r '[.transitions[] | select(.to.statusCategory.key == "done")][0].id')
	api jira POST "$J/issue/$key/transitions" "{\"transition\":{\"id\":\"$t\"}}" >/dev/null
done <"$tmp/issues"

# GitHub: открытые PR агентов по этим задачам (ветка agent/КЛЮЧ-...) - закрыть, ветки остаются.
cut -f1 "$tmp/issues" >"$tmp/keys"
api gh GET "$G/pulls?state=open&per_page=100" | jq -r '.[] | [.number, .head.ref] | @tsv' >"$tmp/prs"
while IFS="$(printf '\t')" read -r n ref; do
	key=$(printf '%s' "$ref" | sed -n 's#^agent/\([A-Z][A-Z0-9]*-[0-9]*\)-.*#\1#p')
	if [ -z "$key" ] || ! grep -qx "$key" "$tmp/keys"; then continue; fi
	plan "GitHub: PR $n ($ref) - закрыть" && continue
	api gh PATCH "$G/pulls/$n" '{"state":"closed"}' >/dev/null
done <"$tmp/prs"
echo "стенд готов к дублю${dry:+ (проверка без изменений)}"
