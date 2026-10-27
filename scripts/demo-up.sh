#!/bin/sh
# demo-up.sh - экземпляр демо на Bitbucket + Pipelines: учётки координатора и выкладки
# (.state/coordinator, .state/cd), образ агента в реестре шагов, координатор и шлюз в сети
# шагов, выкладка цели из GHCR на стенд, проверки стенда цели в Gatus и цель в портале.
# Запуск из корня репозитория после scripts/stand-up.sh (образ factory/agent:stand и шлюз).
set -eu
. ./scripts/lib.sh
load_env

state=${STATE_DIR:-.state}
dst=$state/coordinator
mkdir -p "$dst"
chmod 700 "$dst"
for f in atlassian.env bitbucket.env github-target.env claude-oauth.token gw-agent-sub.key gw-kb.key discord.env; do
	[ -s "$state/$f" ] || {
		echo "нет $state/$f: см. docs/demo/platforms.md" >&2
		exit 1
	}
	cmp -s "$state/$f" "$dst/$f" || (umask 077 && cp "$state/$f" "$dst/$f")
done
# Вход Codex по подписке - судье PR и сверке макета (другое семейство моделей, чем агент).
[ -s "$state/codex/auth.json" ] || {
	echo "нет $state/codex/auth.json: вход Codex фабрики (README, раздел о подписках)" >&2
	exit 1
}
cmp -s "$state/codex/auth.json" "$dst/codex-auth.json" || (umask 077 && cp "$state/codex/auth.json" "$dst/codex-auth.json")
# Макеты Figma - по желанию: без figma.env сверка макета берёт картинки из чата.
[ ! -s "$state/figma.env" ] || cmp -s "$state/figma.env" "$dst/figma.env" || (umask 077 && cp "$state/figma.env" "$dst/figma.env")
mkdir -p "$state/cd"
chmod 700 "$state/cd"
# Ключ MCP фабрики для экзокортексов (Authorization: Bearer).
[ -s "$dst/mcp.token" ] || (umask 077 && od -An -tx1 -N24 /dev/urandom | tr -d ' \n' >"$dst/mcp.token")
cmp -s "$state/github-target.env" "$state/cd/github-target.env" || (umask 077 && cp "$state/github-target.env" "$state/cd/")
# Свои учётки фабрики, по желанию: в Atlassian (scripts/persona-atlassian-add.sh factory) и в GitHub
# - приложение (scripts/persona-github-app-add.sh factory). Без них фабрика ходит учётками из
# atlassian.env и github-target.env.
[ ! -s "$state/atlassian-factory.env" ] || cmp -s "$state/atlassian-factory.env" "$dst/atlassian-factory.env" ||
	(umask 077 && cp "$state/atlassian-factory.env" "$dst/atlassian-factory.env")
for f in github-app-factory.env github-app-factory.pem; do
	[ ! -s "$state/$f" ] || for d in "$dst" "$state/cd"; do
		cmp -s "$state/$f" "$d/$f" || (umask 077 && cp "$state/$f" "$d/$f")
	done
done

# GlitchTip: проект цели и токен координатора; DSN - приложению на стенде (через службу выкладки).
{
	printf 'APP = "prize-draw"\n'
	cat config/glitchtip/demo-setup.py
} | docker compose exec -T glitchtip python manage.py shell 2>/dev/null | while read -r kind a b; do
	case $kind in
	dsn) (umask 077 && printf 'SENTRY_DSN=http://%s@glitchtip:8000/%s\n' "$a" "$b" >"$state/cd/app.env") ;;
	token) (umask 077 && printf '%s\n' "$a" >"$dst/glitchtip.token") ;;
	esac
done
[ -s "$dst/glitchtip.token" ] || {
	echo "GlitchTip: нет токена координатора (стенд поднят? scripts/stand-up.sh)" >&2
	exit 1
}

share_mounts
docker compose --profile bitbucket up -d bb-dind bb-registry bb-runner egress
# Шаг агента берёт образ из реестра шагов: Docker заданий в интернет не ходит.
docker build -q -t factory/e2e:stand images/e2e >/dev/null
scripts/bb-images.sh factory/agent:stand factory/e2e:stand
# Шлюз входит в сеть шагов (172.31.250.30) - пересоздаётся, если настройки сети изменились.
docker compose up -d gateway
docker compose --profile bitbucket up -d --build coordinator cd

# Gatus: учётка цели теперь у службы cd - ensure_gatus дописывает проверки стенда цели демо.
ensure_gatus
share_mounts
[ -z "${GATUS_CHANGED:-}" ] || docker compose restart gatus >/dev/null
# Портал документации: репозиторий цели на GitHub (открытый) и пространство Confluence. Из
# файлов учёток берутся только эти имена, без печати; токены не читаются.
repo=$(sed -n 's/^GITHUB_TARGET_REPO=//p' "$state/github-target.env" | tr -d '\r"')
site=$(sed -n 's/^ATLASSIAN_SITE=//p' "$state/atlassian.env" | tr -d '\r"')
space=$(sed -n 's/^CONFLUENCE_SPACE=//p' "$state/atlassian.env" | tr -d '\r"')
mkdir -p "$state/portal"
chmod 700 "$state/portal"
{
	printf 'PORTAL_GITHUB_REPOS=%s\n' "$repo"
	[ -z "$site" ] || [ -z "$space" ] || printf 'PORTAL_CONFLUENCE_URL=%s/wiki/spaces/%s\n' "${site%/}" "$space"
} | put_if_changed "$state/portal/env" || true
docker compose --profile kb up -d --build portal

echo "координатор: docker compose --profile bitbucket logs -f coordinator"
echo "выкладка цели: docker compose --profile bitbucket logs -f cd; розыгрыш - http://127.0.0.1:8082"
echo "проверки стенда демо - Gatus http://127.0.0.1:$GATUS_PORT; документация цели - портал http://127.0.0.1:${PORTAL_PORT:-8400}"
