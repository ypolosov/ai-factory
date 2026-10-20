#!/bin/sh
# Портал документации из git (Zensical): спецификации, записи решений, изменения и вики
# репозиториев приложений - сайтом для людей. Источник правды - git: страница ведёт на свой
# файл в Forgejo или GitHub, правка - через PR. Раз в PORTAL_INTERVAL секунд сайт собирается
# заново, если сменилась основная ветка или вики; отдаёт его встроенный сервер Python.
#
# Окружение: FORGEJO_URL (внутренний адрес), FORGEJO_PUBLIC_URL (адрес для ссылок),
# KB_REPOS ("владелец/имя ..." в Forgejo), PORTAL_GITHUB_REPOS ("владелец/имя ..." - открытые
# репозитории GitHub, клон без токена; вики у них не в git, а в Confluence: PORTAL_CONFLUENCE_URL -
# адрес пространства, если известен), PORTAL_INTERVAL (с, по умолчанию 300), PORT (8000).
set -eu
: "${FORGEJO_URL:?}" "${FORGEJO_PUBLIC_URL:?}" "${KB_REPOS:=}" "${PORTAL_GITHUB_REPOS:=}" "${PORTAL_CONFLUENCE_URL:=}"
: "${PORTAL_INTERVAL:=300}" "${PORT:=8000}"
[ -n "$KB_REPOS$PORTAL_GITHUB_REPOS" ] || {
	echo "нет репозиториев: KB_REPOS или PORTAL_GITHUB_REPOS" >&2
	exit 1
}
site=/srv/portal/site
work=/tmp/portal
mkdir -p "$site"
[ -f "$site/index.html" ] || printf '<p>Портал собирается...</p>\n' >"$site/index.html"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# page ИСТОЧНИК ССЫЛКА ЦЕЛЬ [ПОМЕТКА] - копия страницы с пометкой источника в начале.
page() {
	mkdir -p "$(dirname "$3")"
	{
		printf '> Источник: [%s](%s). Правка - через PR в репозиторий.\n\n' "$1" "$2"
		[ -z "${4:-}" ] || printf '%s\n\n' "$4"
		cat "$1"
	} >"$3"
}

# pages КЛОН ССЫЛКА КАТАЛОГ [ПОМЕТКА] - страницы репозитория из его рабочей копии: README
# (с пометкой), спецификация, решения и изменения. ССЫЛКА - начало адреса файла на этом
# коммите в git-хостинге.
pages() {
	src=$1
	blob=$2
	d=$3
	n=$(basename "$d")
	mkdir -p "$d"
	if [ -f "$src/README.md" ]; then
		page "$src/README.md" "$blob/README.md" "$d/index.md" "${4:-}"
	else
		printf '# %s\n\n%s\n' "$n" "${4:-}" >"$d/index.md"
	fi
	# Действующая спецификация.
	if [ -d "$src/openspec/specs" ]; then
		(cd "$src" && find openspec/specs -name '*.md') | while read -r f; do
			page "$src/$f" "$blob/$f" "$d/specs/${f#openspec/specs/}"
		done
	fi
	# Записи решений: docs/adr и design.md изменений (в работе и в архиве).
	for f in $(cd "$src" && find docs/adr -name '*.md' 2>/dev/null) $(cd "$src" && find openspec/changes -name design.md 2>/dev/null); do
		case $f in
		docs/adr/*) t=$d/decisions/$(basename "$f") ;;
		*) t=$d/decisions/$(basename "$(dirname "$f")").md ;;
		esac
		page "$src/$f" "$blob/$f" "$t"
	done
	# Изменения: замысел и задачи.
	for f in $(cd "$src" && find openspec/changes -name proposal.md -o -name tasks.md 2>/dev/null); do
		c=$(basename "$(dirname "$f")")
		page "$src/$f" "$blob/$f" "$d/changes/$c/$(basename "$f")"
	done
}

build() {
	rm -rf "$work"
	mkdir -p "$work/docs"
	{
		printf '# Портал фабрики\n\nДокументация приложений стенда, собранная из git.\n\n'
		for r in $KB_REPOS $PORTAL_GITHUB_REPOS; do printf -- '- [%s](%s/index.md)\n' "${r#*/}" "${r#*/}"; done
	} >"$work/docs/index.md"
	for r in $KB_REPOS; do
		n=${r#*/}
		src=$work/src/$n
		git clone -q --depth 1 "$FORGEJO_URL/$r.git" "$src"
		sha=$(git -C "$src" rev-parse HEAD)
		d=$work/docs/$n
		pages "$src" "$FORGEJO_PUBLIC_URL/$r/src/commit/$sha" "$d"
		# Вики: файлы в git названы с процентным кодированием - в портале имена по порядку.
		if git clone -q --depth 1 "$FORGEJO_URL/$r.wiki.git" "$work/wiki-$n" 2>/dev/null; then
			i=0
			for f in "$work/wiki-$n"/*.md; do
				[ -f "$f" ] || continue
				i=$((i + 1))
				name=$(basename "$f" .md)
				page "$f" "$FORGEJO_PUBLIC_URL/$r/wiki/$name" "$d/wiki/page-$i.md"
			done
		fi
	done
	# Открытые репозитории GitHub: клон без токена, ссылка - на файл на этом коммите. Вики
	# у них не в git, а в Confluence: на главной странице репозитория - ссылка на пространство.
	wiki=""
	[ -z "$PORTAL_CONFLUENCE_URL" ] || wiki="> Вики проекта - в Confluence: [пространство]($PORTAL_CONFLUENCE_URL)."
	for r in $PORTAL_GITHUB_REPOS; do
		n=${r#*/}
		src=$work/src/$n
		git clone -q --depth 1 "https://github.com/$r.git" "$src" || {
			log "GitHub: не клонируется $r"
			return 1
		}
		sha=$(git -C "$src" rev-parse HEAD)
		pages "$src" "https://github.com/$r/blob/$sha" "$work/docs/$n" "$wiki"
	done
	cat >"$work/mkdocs.yml" <<EOF
site_name: Портал фабрики
docs_dir: docs
site_dir: site
theme:
  language: ru
EOF
	(cd "$work" && zensical build >"$work/build.log" 2>&1) || {
		log "сборка не удалась: $(tail -n 5 "$work/build.log" | tr '\n' ' ')"
		return 1
	}
	# Подмена готового сайта целиком: сервер не отдаёт наполовину собранное.
	rm -rf "$site.new" "$site.old"
	cp -R "$work/site" "$site.new" && mv "$site" "$site.old" && mv "$site.new" "$site" && rm -rf "$site.old"
}

# Отпечаток источников: головы main и вики всех репозиториев Forgejo, головы ветки по
# умолчанию репозиториев GitHub.
state() {
	{
		for r in $KB_REPOS; do
			git ls-remote "$FORGEJO_URL/$r.git" refs/heads/main 2>/dev/null
			git ls-remote "$FORGEJO_URL/$r.wiki.git" 2>/dev/null | head -n 1
		done
		for r in $PORTAL_GITHUB_REPOS; do
			git ls-remote "https://github.com/$r.git" HEAD 2>/dev/null
		done
	} | cksum
}

(cd / && python3 -m http.server "$PORT" --bind 0.0.0.0 --directory "$site" >/dev/null 2>&1) &
log "портал: $KB_REPOS $PORTAL_GITHUB_REPOS, раз в $PORTAL_INTERVAL с, порт $PORT"
last=""
while :; do
	now=$(state)
	if [ "$now" != "$last" ]; then
		if build; then
			last=$now
			log "собран: $(find "$site" -name '*.html' | wc -l) страниц"
		fi
	fi
	sleep "$PORTAL_INTERVAL"
done
