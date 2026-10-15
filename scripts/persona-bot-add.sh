#!/bin/sh
# persona-bot-add.sh ПЕРСОНАЖ "ИМЯ" РОЛЬ - мастер для человека: завести бота Discord ИИ-персонажа.
# Учётку бота создаёт только человек на портале разработчиков Discord: автоматизировать
# пользовательские учётки правила Discord запрещают. Мастер ведёт по шагам, сохраняет токен в
# .state/discord-ПЕРСОНАЖ.env (вводится скрыто, в аргументы и журнал не попадает), даёт ссылку
# приглашения на сервер и строки для реестра ролей цели (.factory/roles.yml, PR - решение владельца).
# Пример: scripts/persona-bot-add.sh qa "QA (ИИ)" qa
set -eu

persona=${1:?использование: persona-bot-add.sh ПЕРСОНАЖ "ИМЯ" РОЛЬ}
name=${2:?использование: persona-bot-add.sh ПЕРСОНАЖ "ИМЯ" РОЛЬ}
role=${3:?использование: persona-bot-add.sh ПЕРСОНАЖ "ИМЯ" РОЛЬ}
case $persona in *[!a-z0-9-]* | "")
	echo "ПЕРСОНАЖ - латиница в нижнем регистре, цифры и дефис" >&2
	exit 2
	;;
esac
env=.state/discord-$persona.env
api=https://discord.com/api/v10

cat <<EOF
Бот персонажа "$name" (роль $role):
1. Откройте https://discord.com/developers/applications -> New Application -> имя "$name".
2. Раздел Bot -> Reset Token -> скопируйте токен (он показывается один раз).
EOF
if [ -f "$env" ]; then
	echo "Токен уже сохранён в $env - шаги 1-2 пропустите, Enter - оставить его."
fi
printf '3. Вставьте токен (ввод скрыт): '
stty -echo 2>/dev/null || true
read -r token
stty echo 2>/dev/null || true
echo
if [ -n "$token" ]; then
	umask 077
	printf 'DISCORD_BOT_TOKEN=%s\n' "$token" >"$env"
	echo "сохранено: $env"
fi
[ -f "$env" ] || {
	echo "токена нет - бот не заведён" >&2
	exit 2
}

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
me=$(curl -fsS -H @"$hdr" "$api/users/@me") || {
	echo "Discord не принял токен - проверьте его и запустите мастер снова" >&2
	exit 2
}
id=$(printf '%s' "$me" | jq -r .id)
# Права бота на сервере: видеть каналы, писать, читать историю (1024 + 2048 + 65536).
cat <<EOF
4. Пригласите бота на сервер фабрики (откроется выбор сервера):
   https://discord.com/oauth2/authorize?client_id=$id&scope=bot&permissions=68608
5. Строки для реестра ролей цели (.factory/roles.yml), PR сливает владелец:
   holders:
     $persona-bot:
       kind: ai
       name: $name
       accounts:
         discord: "$id"
   roles:
     $role: [..., $persona-bot]
Проверка после слияния: scripts/persona.sh $persona основной 'Привет, я $name'
EOF
