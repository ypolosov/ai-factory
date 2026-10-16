#!/bin/sh
# persona-github-app-add.sh ПЕРСОНАЖ ["ИМЯ ПРИЛОЖЕНИЯ"] - мастер для человека: приложение GitHub
# (GitHub App) ИИ-персонажа, чтобы в видео-демо персонаж сам открывал PR, сливал их и ставил теги
# в репозитории цели под своим именем. Отдельная учётка GitHub не годится: условия GitHub дают
# человеку одну бесплатную служебную учётку, а приложений можно завести несколько.
# Приложение создаёт человек на github.com по готовому описанию (manifest): мастер открывает
# страницу на 127.0.0.1, GitHub возвращает код, мастер обменивает его на ключ приложения и кладёт
# в .state/github-app-ПЕРСОНАЖ.env и .pem (в аргументы и журнал ключ не попадает), затем просит
# установить приложение в репозиторий цели и проверяет доступ.
# Имя приложения уникально на всём GitHub; в интерфейсе оно видно строчными латинскими буквами
# через дефис, с пометкой bot. По умолчанию - "<Персонаж> AI Factory".
# Пример: scripts/persona-github-app-add.sh architect "Architect AI Factory"
set -eu

persona=${1:?использование: persona-github-app-add.sh ПЕРСОНАЖ [\"ИМЯ ПРИЛОЖЕНИЯ\"]}
case $persona in *[!a-z0-9-]* | "")
	echo "ПЕРСОНАЖ - латиница в нижнем регистре, цифры и дефис" >&2
	exit 2
	;;
esac
name=${2:-"$(printf '%s' "$persona" | cut -c1 | tr '[:lower:]' '[:upper:]')$(printf '%s' "$persona" | cut -c2-) AI Factory"}
port=${PORT:-8765}
env=.state/github-app-$persona.env
pem=.state/github-app-$persona.pem
base=.state/github-target.env
[ -f "$base" ] || {
	echo "нет $base - сначала доступ фабрики к репозиторию цели (docs/demo/platforms.md)" >&2
	exit 2
}
repo=$(sed -n 's/^GITHUB_TARGET_REPO=//p' "$base" | tr -d '\r"')
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# Описание приложения: доступ только к содержимому и PR, без вебхуков.
jq -n --arg name "$name" --arg url "https://github.com/$repo" --arg back "http://127.0.0.1:$port/done" '{
	name: $name, url: $url, redirect_url: $back, public: false,
	hook_attributes: {url: $url, active: false},
	default_events: [],
	default_permissions: {contents: "write", pull_requests: "write", checks: "read", statuses: "read", metadata: "read"}
}' >"$tmp/manifest.json"
state=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')

# Страница на 127.0.0.1: форма с описанием уходит на GitHub, GitHub возвращает код сюда же.
cat >"$tmp/serve.py" <<'PY'
import html, http.server, json, sys, urllib.parse
port, state, manifest, out = int(sys.argv[1]), sys.argv[2], open(sys.argv[3]).read(), sys.argv[4]
form = f"""<!doctype html><meta charset="utf-8"><title>Приложение GitHub</title>
<body style="font:18px system-ui;margin:40px">
<p>Приложение GitHub для персонажа: <b>{html.escape(json.loads(manifest)["name"])}</b></p>
<form action="https://github.com/settings/apps/new?state={state}" method="post">
<input type="hidden" name="manifest" value="{html.escape(manifest)}">
<button type="submit" style="font:18px system-ui;padding:8px 16px">Создать на GitHub</button></form>"""
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def page(self, body):
        self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers()
        self.wfile.write(body.encode())
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == "/done" and q.get("state") == [state] and q.get("code"):
            open(out, "w").write(q["code"][0])
            self.page("<p style='font:18px system-ui;margin:40px'>Готово - вернитесь в терминал.</p>")
            raise SystemExit
        self.page(form)
s = http.server.HTTPServer(("127.0.0.1", port), H)
try:
    s.serve_forever()
except SystemExit:
    pass
PY
python3 -I "$tmp/serve.py" "$port" "$state" "$tmp/manifest.json" "$tmp/code" &
srv=$!
cat <<EOF
Приложение GitHub для персонажа $persona ("$name"):
1. Откройте http://127.0.0.1:$port/ в браузере, где вы вошли на GitHub как владелец $repo.
2. Нажмите "Создать на GitHub", затем на GitHub - "Create GitHub App for ..."
   (имя занято - запустите мастер снова с другим именем вторым аргументом).
EOF
while [ ! -s "$tmp/code" ]; do
	kill -0 "$srv" 2>/dev/null || [ -s "$tmp/code" ] || {
		echo "страница мастера остановилась без кода от GitHub" >&2
		exit 2
	}
	sleep 1
done
wait "$srv" 2>/dev/null || true

# Обмен кода на ключ приложения (код живёт час и годится один раз).
code=$(cat "$tmp/code")
curl -fsS -X POST -H 'Accept: application/vnd.github+json' "https://api.github.com/app-manifests/$code/conversions" >"$tmp/app.json" || {
	echo "GitHub не обменял код на ключ - запустите мастер снова" >&2
	exit 2
}
jq -r .pem "$tmp/app.json" >"$pem"
id=$(jq -r .id "$tmp/app.json")
slug=$(jq -r .slug "$tmp/app.json")
printf 'GITHUB_APP_ID=%s\nGITHUB_APP_SLUG=%s\nGITHUB_TARGET_REPO=%s\n' "$id" "$slug" "$repo" >"$env"
echo "сохранено: $env и $pem (приложение $slug)"

cat <<EOF
3. Установите приложение в репозиторий: https://github.com/apps/$slug/installations/new
   -> Only select repositories -> $repo -> Install.
4. По желанию: на странице приложения (Settings -> Developer settings -> GitHub Apps -> $slug)
   загрузите картинку персонажа, как у его бота в Discord.
EOF
printf 'Установили? Нажмите Enter: ' >&2
read -r _

# Проверка: подписанный ключом запрос приложения -> установка в репозиторий -> токен -> репозиторий.
b64url() { base64 | tr -d '=\n' | tr '/+' '_-'; }
now=$(date +%s)
head=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
body=$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' $((now - 60)) $((now + 540)) "$id" | b64url)
sig=$(printf '%s.%s' "$head" "$body" | openssl dgst -sha256 -sign "$pem" -binary | b64url)
printf 'Authorization: Bearer %s.%s.%s\n' "$head" "$body" "$sig" >"$tmp/jwt"
inst=$(curl -fsS -H @"$tmp/jwt" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/installation" | jq -r .id) || {
	echo "приложение не установлено в $repo - установите (шаг 3) и запустите мастер снова" >&2
	exit 2
}
printf 'GITHUB_APP_INSTALLATION=%s\n' "$inst" >>"$env"
curl -fsS -X POST -H @"$tmp/jwt" -H 'Accept: application/vnd.github+json' \
	"https://api.github.com/app/installations/$inst/access_tokens" | jq -r '"Authorization: Bearer " + .token' >"$tmp/tok"
curl -fsS -H @"$tmp/tok" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo" |
	jq -r --arg s "$slug" '"GitHub: " + $s + "[bot] видит " + .full_name + ", права: " + (.permissions // {} | to_entries | map(select(.value)) | map(.key) | join(", "))'
