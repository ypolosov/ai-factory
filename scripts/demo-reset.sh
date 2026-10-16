#!/bin/sh
# demo-reset.sh [-n] - бережный сброс стенда перед дублем видео-демо: прошлые дубли уходят из кадра,
# ничего не удаляется. Всё, что создаёт съёмка, несёт метку film (images/camera/script.ts):
# - страницы Confluence с меткой film теряют метку story (сверщик их больше не берёт), получают
#   в заголовок пометку архива (заголовок снова свободен для дубля) и уходят под "Архив съёмок";
# - сбои стенда в GlitchTip решаются, открытые баги сбоев (метка incident) и незакрытые задачи
#   Jira с меткой film закрываются - следующий дубль покажет сбой заново;
# - открытые PR агентов по задачам с меткой film, PR участников съёмки (ветки film/...) и
#   правила-кандидаты (ветки factory/rule-...) закрываются, ветки остаются;
# - код и правила цели возвращаются к последнему тегу demo-baseline[-N] (реестр ролей - как в main):
#   PR открывает и сливает DevOps (ИИ) своим приложением GitHub, служба выкладки выкладывает main;
#   вершина main получает служебный тег выпуска (следующий патч), чтобы заметки выпуска в дубле
#   показывали только его работу;
# - схема базы стенда уходит в архив take_ВРЕМЯ, API стенда заводит её заново: таблицы агентов
#   прошлых дублей не спорят с кодом нового;
# -n - только показать, что будет сделано. Ключи - .state/atlassian.env, .state/github-target.env
# и .state/github-app-devops.env (.pem); нет приложения или тега - возврат кода пропускается;
# GlitchTip - .state/coordinator/glitchtip.token (нет - сбои не трогаются).
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

# GlitchTip: нерешённые сбои стенда - решить раньше, чем закрыть их баги: иначе фабрика откроет баг
# снова, увидев нерешённый сбой.
gt=$state/coordinator/glitchtip.token
if [ -s "$gt" ]; then
	printf 'Authorization: Bearer %s\n' "$(cat "$gt")" >"$tmp/gt"
	GTA=${GLITCHTIP_URL:-http://127.0.0.1:8200}/api/0
	GTO=${GLITCHTIP_ORG:-factory}
	api gt GET "$GTA/projects/$GTO/${GLITCHTIP_PROJECT:-prize-draw}/issues/?query=$(uri is:unresolved)" | jq -r '.[].id' >"$tmp/gtids"
	while IFS= read -r id; do
		plan "GlitchTip: сбой $id - решён" && continue
		api gt PUT "$GTA/organizations/$GTO/issues/?id=$id" '{"status":"resolved"}' >/dev/null
	done <"$tmp/gtids"
fi

# Jira: открытые баги сбоев (метка incident) - закрыть.
api jira GET "$J/search/jql?jql=$(uri "project = $JIRA_PROJECT AND labels = incident AND statusCategory != Done")&fields=status" |
	jq -r '.issues[].key' >"$tmp/bugs"
while IFS= read -r key; do
	plan "Jira: баг сбоя $key - закрыть" && continue
	t=$(api jira GET "$J/issue/$key/transitions" | jq -r '[.transitions[] | select(.to.statusCategory.key == "done")][0].id')
	api jira POST "$J/issue/$key/transitions" "{\"transition\":{\"id\":\"$t\"}}" >/dev/null
done <"$tmp/bugs"

# Jira: задачи прошлых дублей; незакрытые - закрыть.
api jira GET "$J/search/jql?jql=$(uri "project = $JIRA_PROJECT AND labels = $label")&fields=status&maxResults=100" |
	jq -r '.issues[] | [.key, .fields.status.statusCategory.key] | @tsv' >"$tmp/issues"
while IFS="$(printf '\t')" read -r key cat; do
	[ "$cat" != "done" ] || continue
	plan "Jira: $key - закрыть" && continue
	t=$(api jira GET "$J/issue/$key/transitions" | jq -r '[.transitions[] | select(.to.statusCategory.key == "done")][0].id')
	api jira POST "$J/issue/$key/transitions" "{\"transition\":{\"id\":\"$t\"}}" >/dev/null
done <"$tmp/issues"

# GitHub: открытые PR агентов по этим задачам (ветка agent/КЛЮЧ-...) и PR участников съёмки
# (ветка film/...) - закрыть, ветки остаются.
cut -f1 "$tmp/issues" >"$tmp/keys"
api gh GET "$G/pulls?state=open&per_page=100" | jq -r '.[] | [.number, .head.ref] | @tsv' >"$tmp/prs"
while IFS="$(printf '\t')" read -r n ref; do
	key=$(printf '%s' "$ref" | sed -n 's#^agent/\([A-Z][A-Z0-9]*-[0-9]*\)-.*#\1#p')
	case $ref in film/* | factory/rule-*) ;; *) if [ -z "$key" ] || ! grep -qx "$key" "$tmp/keys"; then continue; fi ;; esac
	plan "GitHub: PR $n ($ref) - закрыть" && continue
	api gh PATCH "$G/pulls/$n" '{"state":"closed"}' >/dev/null
done <"$tmp/prs"

# Код цели: дерево тега demo-baseline с реестром ролей из main. Совпадает с main - делать нечего.
app=$state/github-app-devops
if [ ! -f "$app.env" ]; then
	echo "код цели: у DevOps нет приложения GitHub (scripts/persona-github-app-add.sh devops) - возврат к базе пропущен"
else
	b64url() { base64 | tr -d '=\n' | tr '/+' '_-'; }
	id=$(sed -n 's/^GITHUB_APP_ID=//p' "$app.env" | tr -d '\r"')
	inst=$(sed -n 's/^GITHUB_APP_INSTALLATION=//p' "$app.env" | tr -d '\r"')
	now=$(date +%s)
	jwt="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url).$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' $((now - 60)) $((now + 540)) "$id" | b64url)"
	printf 'Authorization: Bearer %s.%s\n' "$jwt" "$(printf '%s' "$jwt" | openssl dgst -sha256 -sign "$app.pem" -binary | b64url)" >"$tmp/jwt"
	api jwt POST "https://api.github.com/app/installations/$inst/access_tokens" | jq -r '"Authorization: Bearer " + .token' >"$tmp/app"
	# База демо - последний тег demo-baseline[-N]: новая база (например, с часами стенда) - новый тег.
	base=$(api app GET "$G/tags?per_page=100" | jq -r '[.[] | select(.name | test("^demo-baseline(-[0-9]+)?$"))
		| {n: ((.name | capture("-(?<n>[0-9]+)$").n) // "1" | tonumber), sha: .commit.sha}] | sort_by(.n) | last | .sha // empty') || base=
	if [ -z "$base" ]; then
		echo "код цели: нет тега demo-baseline - возврат к базе пропущен"
	else
		main=$(api app GET "$G/git/ref/heads/main" | jq -r .object.sha)
		mtree=$(api app GET "$G/git/commits/$main" | jq -r .tree.sha)
		btree=$(api app GET "$G/git/commits/$base" | jq -r .tree.sha)
		roles=$(api app GET "$G/contents/.factory/roles.yml?ref=$main" | jq -r .sha)
		tree=$(api app POST "$G/git/trees" "$(jq -cn --arg b "$btree" --arg r "$roles" \
			'{base_tree: $b, tree: [{path: ".factory/roles.yml", mode: "100644", type: "blob", sha: $r}]}')" | jq -r .sha)
		if [ "$tree" = "$mtree" ]; then
			echo "код цели: уже на базе демо"
		elif ! plan "GitHub: код цели - вернуть к demo-baseline (PR и слияние - DevOps)"; then
			title="Возврат к базе демо перед дублем"
			commit=$(api app POST "$G/git/commits" "$(jq -cn --arg t "$title" --arg tr "$tree" --arg p "$main" \
				'{message: ($t + "\n\nКод и правила - как в теге demo-baseline, реестр ролей - как в main (scripts/demo-reset.sh)."), tree: $tr, parents: [$p]}')" | jq -r .sha)
			branch=film/reset-$(date +%m%d-%H%M%S)
			api app POST "$G/git/refs" "{\"ref\":\"refs/heads/$branch\",\"sha\":\"$commit\"}" >/dev/null
			n=$(api app POST "$G/pulls" "$(jq -cn --arg t "$title" --arg h "$branch" \
				'{title: $t, head: $h, base: "main", body: "Сброс стенда перед дублем видео-демо: код и правила цели - как в теге demo-baseline, реестр ролей - как в main."}')" | jq -r .number)
			api app PUT "$G/pulls/$n/merge" "{\"merge_method\":\"squash\",\"commit_title\":\"$title (#$n)\"}" >/dev/null
			echo "код цели: PR $n слит - служба выкладки выложит main"
		fi
		# Служебный тег выпуска на базе дубля: заметки выпуска в дубле считаются от него и не тянут
		# работу прошлых дублей. Вершина main уже с тегом - ничего не делать.
		head=$(api app GET "$G/git/ref/heads/main" | jq -r .object.sha)
		api app GET "$G/tags?per_page=100" >"$tmp/tags"
		# Считаются только теги выпусков vX.Y.Z: тег базы demo-baseline-N заметки выпуска не отсчитывает.
		if ! jq -e --arg h "$head" 'any(.[]; .commit.sha == $h and (.name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")))' "$tmp/tags" >/dev/null; then
			next=$(jq -r '[.[].name | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) | ltrimstr("v") | split(".") | map(tonumber)]
				| sort | last // [1, 0, -1] | "v\(.[0]).\(.[1]).\(.[2] + 1)"' "$tmp/tags")
			if ! plan "GitHub: служебный тег $next на базе дубля - заметки выпуска начнутся с него"; then
				api app POST "$G/git/refs" "{\"ref\":\"refs/tags/$next\",\"sha\":\"$head\"}" >/dev/null
				echo "код цели: тег $next на базе дубля"
			fi
		fi
	fi
fi

# Данные стенда: таблицы, заведённые агентами прошлых дублей, остаются в базе и спорят со схемой
# нового дубля (CREATE TABLE IF NOT EXISTS их не меняет). Схема public уходит в архив take_ВРЕМЯ,
# API стенда перезапускается и заводит схему заново. Нет службы выкладки или стенда - пропуск.
cd_svc=$(docker ps -q -f label=com.docker.compose.project=ai-factory -f label=com.docker.compose.service=cd)
stand=${STAND_PROJECT:-prize-draw}
# in_cd КОМАНДА - команда в службе выкладки: там Docker стенда.
in_cd() { docker exec -i "$cd_svc" "$@"; }
# stand_ctr СЛУЖБА - имя контейнера службы стенда (по имени: выкладка может пересоздать контейнер).
stand_ctr() {
	in_cd docker ps --format '{{.Names}}' -f "label=com.docker.compose.project=$stand" -f "label=com.docker.compose.service=$1" </dev/null
}
db=$([ -z "$cd_svc" ] || stand_ctr db)
api_ctr=$([ -z "$cd_svc" ] || stand_ctr api)
# shellcheck disable=SC2016 # переменные базы раскрывает оболочка в контейнере базы
psql='psql -q -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
if [ -z "$db" ] || [ -z "$api_ctr" ]; then
	echo "данные стенда: нет базы или API стенда $stand - пропуск"
elif [ "$(echo "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" | in_cd docker exec -i "$db" sh -c "$psql")" = 0 ]; then
	echo "данные стенда: схема базы пуста"
else
	arch=take_$(date +%m%d_%H%M%S)
	if ! plan "стенд: схема базы - в архив $arch, API заводит схему заново"; then
		echo "ALTER SCHEMA public RENAME TO $arch; CREATE SCHEMA public;" | in_cd docker exec -i "$db" sh -c "$psql"
		in_cd docker restart "$api_ctr" </dev/null >/dev/null || echo "данные стенда: API не перезапущен - его перезапустит выкладка"
		echo "данные стенда: схема прошлых дублей - в $arch, API перезапущен"
	fi
fi
echo "стенд готов к дублю${dry:+ (проверка без изменений)}"
