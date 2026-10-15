#!/bin/sh
# demo-up.sh - экземпляр демо на Bitbucket + Pipelines: учётки координатора и выкладки
# (.state/coordinator, .state/cd), образ агента в реестре шагов, координатор и шлюз в сети
# шагов, выкладка цели из GHCR на стенд.
# Запуск из корня репозитория после scripts/stand-up.sh (образ factory/agent:stand и шлюз).
set -eu

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
mkdir -p "$state/cd"
chmod 700 "$state/cd"
# Ключ MCP фабрики для экзокортексов (Authorization: Bearer).
[ -s "$dst/mcp.token" ] || (umask 077 && od -An -tx1 -N24 /dev/urandom | tr -d ' \n' >"$dst/mcp.token")
cmp -s "$state/github-target.env" "$state/cd/github-target.env" || (umask 077 && cp "$state/github-target.env" "$state/cd/")

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

docker compose --profile bitbucket up -d bb-dind bb-registry bb-runner egress
# Шаг агента берёт образ из реестра шагов: Docker заданий в интернет не ходит.
scripts/bb-images.sh factory/agent:stand
# Шлюз входит в сеть шагов (172.31.250.30) - пересоздаётся, если настройки сети изменились.
docker compose up -d gateway
docker compose --profile bitbucket up -d --build coordinator cd
echo "координатор: docker compose --profile bitbucket logs -f coordinator"
echo "выкладка цели: docker compose --profile bitbucket logs -f cd; розыгрыш - http://127.0.0.1:8082"
