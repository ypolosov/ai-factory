#!/bin/sh
# persona.sh ПЕРСОНАЖ КАНАЛ ТЕКСТ - реплика ИИ-персонажа в Discord от учётки его бота (видео-демо).
# Персонаж - держатель ролей в реестре цели (.factory/roles.yml), поэтому бот фабрики его слышит
# и проверяет права по роли. Токен бота - .state/discord-ПЕРСОНАЖ.env (DISCORD_BOT_TOKEN): в аргументы
# команд и журнал не попадает; у старых ботов - DISCORD_<ПЕРСОНАЖ>_TOKEN. Завести бота: scripts/persona-bot-add.sh.
# Запуск из корня репозитория: scripts/persona.sh pm продукт '!нарезка DRAW-11'
set -eu

persona=${1:?использование: persona.sh ПЕРСОНАЖ КАНАЛ ТЕКСТ}
channel=${2:?использование: persona.sh ПЕРСОНАЖ КАНАЛ ТЕКСТ}
text=${3:?использование: persona.sh ПЕРСОНАЖ КАНАЛ ТЕКСТ}
env=.state/discord-$persona.env
[ -f "$env" ] || {
	echo "нет $env - заведите бота: scripts/persona-bot-add.sh $persona" >&2
	exit 2
}
api=https://discord.com/api/v10
hdr=$(mktemp)
trap 'rm -f "$hdr"' EXIT
chmod 600 "$hdr"
(
	# shellcheck disable=SC1090
	. "./$env"
	var=DISCORD_$(printf '%s' "$persona" | tr 'a-z-' 'A-Z_')_TOKEN
	eval "tok=\${DISCORD_BOT_TOKEN:-\${$var:-}}"
	[ -n "$tok" ] || {
		echo "нет DISCORD_BOT_TOKEN или $var в $env" >&2
		exit 2
	}
	printf 'Authorization: Bot %s\n' "$tok"
) >"$hdr"
call() { curl -fsS -H @"$hdr" -H 'content-type: application/json' "$@"; }

guild=$(call "$api/users/@me/guilds" | jq -r '.[0].id // empty')
[ -n "$guild" ] || {
	echo "бот $persona не добавлен на сервер Discord" >&2
	exit 2
}
id=$(call "$api/guilds/$guild/channels" | jq -r --arg n "$channel" '[.[] | select(.name == $n)][0].id // empty')
[ -n "$id" ] || {
	echo "нет канала $channel" >&2
	exit 2
}
jq -n --arg c "$text" '{content: $c}' | call -X POST --data @- "$api/channels/$id/messages" | jq -r '"отправлено: " + .id'
