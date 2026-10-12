#!/bin/sh
# Портал документации из git (Zensical): спецификации, записи решений, изменения и вики
# репозиториев приложений - сайтом для людей. Источник правды - git: страница ведёт на свой
# файл в Forgejo, правка - через PR. Раз в PORTAL_INTERVAL секунд сайт собирается заново,
# если сменилась основная ветка или вики; отдаёт его встроенный сервер Python.
#
# Окружение: FORGEJO_URL (внутренний адрес), FORGEJO_PUBLIC_URL (адрес для ссылок),
# KB_REPOS ("владелец/имя ..."), PORTAL_INTERVAL (с, по умолчанию 300), PORT (8000).
set -eu
: "${FORGEJO_URL:?}" "${FORGEJO_PUBLIC_URL:?}" "${KB_REPOS:?}" "${PORTAL_INTERVAL:=300}" "${PORT:=8000}"
site=/srv/portal/site
work=/tmp/portal
mkdir -p "$site"
[ -f "$site/index.html" ] || printf '<p>Портал собирается...</p>\n' >"$site/index.html"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# page ИСТОЧНИК ССЫЛКА ЦЕЛЬ - копия страницы с пометкой источника в начале.
page() {
	mkdir -p "$(dirname "$3")"
	{
		printf '> Источник: [%s](%s). Правка - через PR в репозиторий.\n\n' "$1" "$2"
		cat "$1"
	} >"$3"
}

build() {
	rm -rf "$work"
	mkdir -p "$work/docs"
	{
		printf '# Портал фабрики\n\nДокументация приложений стенда, собранная из git.\n\n'
		for r in $KB_REPOS; do printf -- '- [%s](%s/index.md)\n' "${r#*/}" "${r#*/}"; done
	} >"$work/docs/index.md"
	for r in $KB_REPOS; do
		n=${r#*/}
		src=$work/src/$n
		git clone -q --depth 1 "$FORGEJO_URL/$r.git" "$src"
		sha=$(git -C "$src" rev-parse HEAD)
		blob="$FORGEJO_PUBLIC_URL/$r/src/commit/$sha"
		d=$work/docs/$n
		mkdir -p "$d"
		if [ -f "$src/README.md" ]; then
			page "$src/README.md" "$blob/README.md" "$d/index.md"
		else
			printf '# %s\n' "$n" >"$d/index.md"
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

# Отпечаток источников: головы main и вики всех репозиториев.
state() {
	for r in $KB_REPOS; do
		git ls-remote "$FORGEJO_URL/$r.git" refs/heads/main 2>/dev/null
		git ls-remote "$FORGEJO_URL/$r.wiki.git" 2>/dev/null | head -n 1
	done | cksum
}

(cd / && python3 -m http.server "$PORT" --bind 0.0.0.0 --directory "$site" >/dev/null 2>&1) &
log "портал: $KB_REPOS, раз в $PORTAL_INTERVAL с, порт $PORT"
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
