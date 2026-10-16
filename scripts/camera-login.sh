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
email=$(sed -n 's/^ATLASSIAN_EMAIL=//p' ".state/atlassian-$persona.env" 2>/dev/null | tr -d '\r"')
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

# Вход из Chrome - через порт отладки; файл пишет только владелец.
umask 077
node --input-type=module -e "
import { chromium } from '$here/images/camera/node_modules/playwright/index.mjs';
const b = await chromium.connectOverCDP('http://127.0.0.1:$port');
const s = await b.contexts()[0].storageState({ path: '$out' });
const n = s.cookies.filter((c) => c.domain.includes('atlassian')).length;
console.log('сохранено: $out, куки Atlassian: ' + n);
await b.close();
" || {
	echo "вход не забран - окно Chrome закрыто раньше времени? Запустите мастер снова" >&2
	exit 2
}
