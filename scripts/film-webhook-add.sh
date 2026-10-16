#!/bin/sh
# film-webhook-add.sh КАНАЛ - мастер для человека: вебхук канала Discord для шага съёмки "самозванец"
# (docs/demo/film.yml, do.webhook): сообщение вебхука идёт без учётки, и фабрика отказывает ему в
# решении по реестру ролей. Вебхук заводит человек в настройках канала; адрес - секрет, мастер
# кладёт его в .state/discord-webhook-КАНАЛ.env (ввод скрыт) и проверяет, что вебхук живой.
# Пример: scripts/film-webhook-add.sh релизы
set -eu

channel=${1:?использование: film-webhook-add.sh КАНАЛ}
env=.state/discord-webhook-$channel.env
cat <<EOT
Вебхук канала #$channel:
1. Discord -> сервер фабрики -> канал #$channel -> шестерёнка (Изменить канал) -> Интеграции -> Вебхуки.
2. Новый вебхук, имя film-webhook, канал #$channel -> Копировать URL вебхука.
EOT
printf '3. URL вебхука (ввод скрыт): ' >&2
stty -echo </dev/tty 2>/dev/null || true
read -r url </dev/tty
stty echo </dev/tty 2>/dev/null || true
echo >&2
case $url in https://discord.com/api/webhooks/* | https://discordapp.com/api/webhooks/*) ;; *)
	echo "это не адрес вебхука Discord" >&2
	exit 2
	;;
esac
umask 077
printf 'DISCORD_WEBHOOK_URL=%s\n' "$url" >"$env"
echo "сохранено: $env"
# Проверка: GET адреса вебхука отвечает его именем и каналом, без учётки.
curl -fsS "$url" | jq -r '"Discord: вебхук " + .name + ", канал " + .channel_id' || {
	echo "Discord не узнал вебхук - проверьте адрес и запустите мастер снова" >&2
	exit 2
}
