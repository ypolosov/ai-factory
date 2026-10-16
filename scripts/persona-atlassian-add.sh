#!/bin/sh
# persona-atlassian-add.sh ПЕРСОНАЖ ПОЧТА - мастер для человека: API-токены учётки Atlassian
# ИИ-персонажа, чтобы в видео-демо персонаж сам комментировал и двигал задачи в Jira и писал
# страницы в Confluence под своим именем. Токены создаёт только сама учётка на id.atlassian.com;
# мастер сохраняет их в .state/atlassian-ПЕРСОНАЖ.env (ввод скрыт, в аргументы и журнал не
# попадает) и проверяет: кто это для Jira и может ли учётка создавать страницы в пространстве.
# Сайт, проект и пространство берутся из .state/atlassian.env фабрики.
# Пример: scripts/persona-atlassian-add.sh po ypolosov+po@gmail.com
set -eu

persona=${1:?использование: persona-atlassian-add.sh ПЕРСОНАЖ ПОЧТА}
email=${2:?использование: persona-atlassian-add.sh ПЕРСОНАЖ ПОЧТА}
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
API-токены учётки $email:
1. Откройте окно инкогнито и войдите в https://id.atlassian.com под $email.
2. Profile -> Full name - имя персонажа, как у его бота в Discord (например "PO (ИИ)").
3. Security -> API tokens -> Create API token with scopes, два токена:
   - продукт Jira, области read:jira-work, write:jira-work, read:jira-user;
   - продукт Confluence, области read:confluence-content.all,
     read:confluence-space.summary, write:confluence-content, search:confluence.
EOF
ask() {
	printf '%s (ввод скрыт): ' "$1" >&2
	stty -echo 2>/dev/null || true
	read -r v
	stty echo 2>/dev/null || true
	echo >&2
	# Скрытый ввод не видно: токен, вставленный дважды подряд, берётся один раз.
	n=${#v}
	if [ "$n" -gt 0 ] && [ $((n % 2)) -eq 0 ]; then
		h=$(printf '%s' "$v" | cut -c1-$((n / 2)))
		if [ "$h$h" = "$v" ]; then
			v=$h
			echo "вставлено дважды - беру одну копию" >&2
		fi
	fi
	printf '%s' "$v"
}
jira=$(ask '4. Токен Jira')
conf=$(ask '5. Токен Confluence')
if [ -z "$jira" ] || [ -z "$conf" ]; then
	echo "нужны оба токена - учётка не заведена" >&2
	exit 2
fi

site=$(sed -n 's/^ATLASSIAN_SITE=//p' "$base" | tr -d '\r"')
space=$(sed -n 's/^CONFLUENCE_SPACE=//p' "$base" | tr -d '\r"')
umask 077
{
	printf 'ATLASSIAN_SITE=%s\n' "$site"
	printf 'ATLASSIAN_EMAIL=%s\n' "$email"
	printf 'JIRA_API_TOKEN=%s\n' "$jira"
	printf 'CONFLUENCE_API_TOKEN=%s\n' "$conf"
	sed -n 's/^\(JIRA_PROJECT=.*\)/\1/p; s/^\(CONFLUENCE_SPACE=.*\)/\1/p' "$base" | tr -d '\r'
} >"$env"
echo "сохранено: $env"

# Проверка (токен с областями ходит через api.atlassian.com): кто эта учётка для Jira и может ли
# она создавать страницы в пространстве Confluence.
cloud=$(curl -fsS "$site/_edge/tenant_info" | jq -r .cloudId)
auth=$(mktemp)
trap 'rm -f "$auth"' EXIT
chmod 600 "$auth"
header() { printf 'Authorization: Basic %s\n' "$(printf '%s:%s' "$email" "$1" | base64 | tr -d '\n')" >"$auth"; }
header "$jira"
me=$(curl -fsS -H @"$auth" "https://api.atlassian.com/ex/jira/$cloud/rest/api/3/myself") || {
	echo "Jira не приняла токен - проверьте почту, продукт и области токена и запустите мастер снова" >&2
	exit 2
}
printf '%s' "$me" | jq -r '"Jira: " + .displayName + ", accountId " + .accountId'
header "$conf"
ops=$(curl -fsS -H @"$auth" "https://api.atlassian.com/ex/confluence/$cloud/wiki/rest/api/space/$space?expand=operations") || {
	echo "Confluence не приняла токен или не пускает в пространство $space - проверьте продукт и области токена и доступ учётки к Confluence" >&2
	exit 2
}
if printf '%s' "$ops" | jq -e 'any(.operations[]; .operation == "create" and .targetType == "page")' >/dev/null; then
	echo "Confluence: создаёт страницы в пространстве $space"
else
	echo "Confluence: учётка видит $space, но не может создавать страницы - дайте ей права в пространстве (Space settings -> Permissions)" >&2
	exit 2
fi
