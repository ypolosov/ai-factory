#!/bin/sh
# camera-login.sh ПЕРСОНАЖ [АДРЕС] - мастер для человека: вход камеры видео-демо под учёткой
# Atlassian ИИ-персонажа, чтобы в кадре Jira и Confluence был виден он, а не владелец. Камера
# (Playwright без окна) берёт сохранённый вход .state/camera/atlassian-ПЕРСОНАЖ.json (куки сессии -
# секрет, только в .state). Человек сам входит в учётку персонажа в отдельном окне Chrome (WSLg);
# мастер забирает вход через порт отладки Chrome и закрывает окно. Пароль мастер не видит.
# Пример: scripts/camera-login.sh po
set -eu

persona=${1:?использование: camera-login.sh ПЕРСОНАЖ [АДРЕС]}
case $persona in *[!a-z0-9-]* | "")
	echo "ПЕРСОНАЖ - латиница в нижнем регистре, цифры и дефис" >&2
	exit 2
	;;
esac
here=$(cd "$(dirname "$0")/.." && pwd)
site=$(sed -n 's/^ATLASSIAN_SITE=//p' .state/atlassian.env | tr -d '\r"')
url=${2:-$site/jira}
profile=.state/camera/profile-$persona
out=.state/camera/atlassian-$persona.json
# Персонаж должен быть заведён (scripts/persona-atlassian-add.sh): его учётка - эталон для проверки.
[ -s ".state/atlassian-$persona.env" ] || {
	echo "нет .state/atlassian-$persona.env - такого персонажа нет (опечатка?) или его учётка не заведена" >&2
	exit 2
}
email=$(sed -n 's/^ATLASSIAN_EMAIL=//p' ".state/atlassian-$persona.env" | tr -d '\r"')
mkdir -p "$profile"
chmod 700 .state/camera "$profile"
port=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
google-chrome --user-data-dir="$profile" --remote-debugging-port="$port" --remote-debugging-address=127.0.0.1 \
	--no-first-run --no-default-browser-check "$url" >/dev/null 2>&1 &
chrome=$!
trap 'kill "$chrome" 2>/dev/null || true' EXIT INT TERM
cat <<EOT
Вход камеры для персонажа $persona:
1. В открывшемся окне Chrome войдите в Atlassian${email:+ под $email}.
2. Откройте Jira и Confluence (страница пространства) - чтобы обе сессии сохранились.
EOT
printf '3. Вошли? Нажмите Enter: ' >&2
read -r _ </dev/tty

# Вход из Chrome - через порт отладки; файл пишет только владелец. Сохраняется, только если вход -
# под учёткой этого персонажа: учётка сессии сверяется с учёткой его API-токена.
umask 077
node --input-type=module -e "
import { readFileSync, renameSync } from 'node:fs';
import { chromium } from '$here/images/camera/node_modules/playwright/index.mjs';
const env = Object.fromEntries(readFileSync('.state/atlassian-$persona.env', 'utf8').split(/\\r?\\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const cloud = (await (await fetch('$site/_edge/tenant_info')).json()).cloudId;
const auth = 'Basic ' + Buffer.from(env.ATLASSIAN_EMAIL + ':' + env.JIRA_API_TOKEN).toString('base64');
const want = await (await fetch('https://api.atlassian.com/ex/jira/' + cloud + '/rest/api/3/myself', { headers: { authorization: auth } })).json();
const b = await chromium.connectOverCDP('http://127.0.0.1:$port');
const ctx = b.contexts()[0];
const r = await ctx.request.get('$site/rest/api/3/myself');
const me = r.ok() ? await r.json() : {};
if (me.accountId !== want.accountId) {
  console.error('вход под ' + (me.displayName ?? 'никем') + ', а персонаж $persona - ' + want.displayName + ': войдите под его учёткой и нажмите Enter снова');
  await b.close();
  process.exit(3);
}
await ctx.storageState({ path: '$out.new' });
renameSync('$out.new', '$out');
console.log('сохранено: $out - вход камеры под ' + me.displayName);
await b.close();
" || {
	echo "вход не сохранён - проверьте учётку в окне Chrome и запустите мастер снова" >&2
	exit 2
}
