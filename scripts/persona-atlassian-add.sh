#!/bin/sh
# persona-atlassian-add.sh ПЕРСОНАЖ ПОЧТА [confluence] - мастер для человека: API-токен учётки
# Atlassian ИИ-персонажа, чтобы в видео-демо персонаж сам комментировал и двигал задачи под своим
# именем. Токен создаёт только сама учётка на id.atlassian.com; мастер сохраняет его в
# .state/atlassian-ПЕРСОНАЖ.env (ввод скрыт, в аргументы и журнал не попадает) и проверяет.
# Сайт, проект и пространство берутся из .state/atlassian.env фабрики.
# Пример: scripts/persona-atlassian-add.sh po ypolosov+po@gmail.com confluence
set -eu

persona=${1:?использование: persona-atlassian-add.sh ПЕРСОНАЖ ПОЧТА [confluence]}
email=${2:?использование: persona-atlassian-add.sh ПЕРСОНАЖ ПОЧТА [confluence]}
wiki=${3:-}
case $persona in *[!a-z0-9-]* | "")
	echo "ПЕРСОНАЖ - латиница в нижнем регистре, цифры и дефис" >&2
	exit 2
	;;
esac
env=.state/atlassian-$persona.env
base=.state/atlassian.env
[ -f "$base" ] || {
	echo "нет $base - сначала учётка фабрики (docs/demo/platforms.md)" >&2
	exit 2
}

cat <<EOF
API-токен учётки $email:
1. Откройте окно инкогнито и войдите в https://id.atlassian.com под $email.
2. Profile -> Full name - имя персонажа, как у его бота в Discord (например "PO (ИИ)").
3. Security -> API tokens -> Create API token with scopes:
   - продукт Jira, области read:jira-work, write:jira-work, read:jira-user;
EOF
[ "$wiki" != confluence ] || cat <<'EOF'
   - второй токен: продукт Confluence, области read:confluence-content.all,
     read:confluence-space.summary, write:confluence-content, search:confluence;
EOF
ask() {
	printf '%s (ввод скрыт): ' "$1" >&2
	stty -echo 2>/dev/null || true
	read -r v
	stty echo 2>/dev/null || true
	echo >&2
	printf '%s' "$v"
}
jira=$(ask '4. Токен Jira')
conf=
[ "$wiki" != confluence ] || conf=$(ask '5. Токен Confluence')
[ -n "$jira" ] || {
	echo "токена нет - учётка не заведена" >&2
	exit 2
}

site=$(sed -n 's/^ATLASSIAN_SITE=//p' "$base" | tr -d '\r"')
umask 077
{
	printf 'ATLASSIAN_SITE=%s\n' "$site"
	printf 'ATLASSIAN_EMAIL=%s\n' "$email"
	printf 'JIRA_API_TOKEN=%s\n' "$jira"
	[ -z "$conf" ] || printf 'CONFLUENCE_API_TOKEN=%s\n' "$conf"
	sed -n 's/^\(JIRA_PROJECT=.*\)/\1/p; s/^\(CONFLUENCE_SPACE=.*\)/\1/p' "$base" | tr -d '\r'
} >"$env"
echo "сохранено: $env"

# Проверка: кто эта учётка для Jira (токен с областями ходит через api.atlassian.com).
cloud=$(curl -fsS "$site/_edge/tenant_info" | jq -r .cloudId)
auth=$(mktemp)
trap 'rm -f "$auth"' EXIT
chmod 600 "$auth"
printf 'Authorization: Basic %s\n' "$(printf '%s:%s' "$email" "$jira" | base64 | tr -d '\n')" >"$auth"
me=$(curl -fsS -H @"$auth" "https://api.atlassian.com/ex/jira/$cloud/rest/api/3/myself") || {
	echo "Jira не приняла токен - проверьте почту, продукт и области токена и запустите мастер снова" >&2
	exit 2
}
printf '%s' "$me" | jq -r '"Jira: " + .displayName + ", accountId " + .accountId'
