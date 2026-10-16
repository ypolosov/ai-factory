#!/bin/sh
# camera-login.sh ИМЯ [АДРЕС] - мастер для человека: сохранённый вход камеры видео-демо.
# - ИМЯ - ИИ-персонаж (есть .state/atlassian-ИМЯ.env): вход под его учёткой Atlassian, чтобы в кадре
#   Jira и Confluence был он, а не владелец; файл .state/camera/atlassian-ИМЯ.json. Мастер сохраняет
#   вход, только если учётка сессии совпала с учёткой API-токена персонажа.
# - ИМЯ - сайт (figma, glitchtip, bitbucket) и АДРЕС: вход человека на этом сайте для кадров камеры;
#   файл .state/camera/ИМЯ.json (ключ ИМЯ в film.browsers сценария съёмки).
# Человек сам входит в отдельном окне Chrome (WSLg, свой профиль на каждое ИМЯ); мастер забирает
# вход через порт отладки Chrome и закрывает окно. Пароль мастер не видит; куки - секрет, только в .state.
# Примеры: scripts/camera-login.sh po
#          scripts/camera-login.sh glitchtip http://127.0.0.1:8200
set -eu

name=${1:?использование: camera-login.sh ИМЯ [АДРЕС]}
case $name in *[!a-z0-9-]* | "")
	echo "ИМЯ - латиница в нижнем регистре, цифры и дефис" >&2
	exit 2
	;;
esac
here=$(cd "$(dirname "$0")/.." && pwd)
site=$(sed -n 's/^ATLASSIAN_SITE=//p' .state/atlassian.env | tr -d '\r"')
profile=.state/camera/profile-$name
if [ -s ".state/atlassian-$name.env" ]; then
	persona=1
	url=${2:-$site/jira}
	out=.state/camera/atlassian-$name.json
	email=$(sed -n 's/^ATLASSIAN_EMAIL=//p' ".state/atlassian-$name.env" | tr -d '\r"')
	what="в Atlassian под $email, затем откройте Jira и Confluence (страница пространства)"
elif [ -n "${2:-}" ]; then
	persona=
	url=$2
	out=.state/camera/$name.json
	what="на этом сайте той учёткой, которую камера покажет в кадре"
else
	echo "нет .state/atlassian-$name.env - такого персонажа нет (опечатка?); для входа на сайт дайте его адрес вторым аргументом" >&2
	exit 2
fi
mkdir -p "$profile"
chmod 700 .state/camera "$profile"
port=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
google-chrome --user-data-dir="$profile" --remote-debugging-port="$port" --remote-debugging-address=127.0.0.1 \
	--no-first-run --no-default-browser-check "$url" >/dev/null 2>&1 &
chrome=$!
trap 'kill "$chrome" 2>/dev/null || true' EXIT INT TERM
cat <<EOT
Вход камеры "$name":
1. В открывшемся окне Chrome войдите $what.
EOT
printf '2. Вошли? Нажмите Enter: ' >&2
read -r _ </dev/tty

# Вход из Chrome - через порт отладки; файл пишет только владелец. Вход персонажа сохраняется, только
# если учётка сессии совпала с учёткой его API-токена.
umask 077
node --input-type=module -e "
import { readFileSync, renameSync } from 'node:fs';
import { chromium } from '$here/images/camera/node_modules/playwright/index.mjs';
const b = await chromium.connectOverCDP('http://127.0.0.1:$port');
const ctx = b.contexts()[0];
let who = '';
if ('$persona') {
  const env = Object.fromEntries(readFileSync('.state/atlassian-$name.env', 'utf8').split(/\\r?\\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const cloud = (await (await fetch('$site/_edge/tenant_info')).json()).cloudId;
  const auth = 'Basic ' + Buffer.from(env.ATLASSIAN_EMAIL + ':' + env.JIRA_API_TOKEN).toString('base64');
  const want = await (await fetch('https://api.atlassian.com/ex/jira/' + cloud + '/rest/api/3/myself', { headers: { authorization: auth } })).json();
  const r = await ctx.request.get('$site/rest/api/3/myself');
  const me = r.ok() ? await r.json() : {};
  if (me.accountId !== want.accountId) {
    console.error('вход под ' + (me.displayName ?? 'никем') + ', а персонаж $name - ' + want.displayName + ': войдите под его учёткой и запустите мастер снова');
    await b.close();
    process.exit(3);
  }
  who = ' под ' + me.displayName;
}
const s = await ctx.storageState({ path: '$out.new' });
renameSync('$out.new', '$out');
console.log('сохранено: $out - вход камеры' + who + ', куки: ' + s.cookies.length);
await b.close();
" || {
	echo "вход не сохранён - проверьте учётку в окне Chrome и запустите мастер снова" >&2
	exit 2
}
