#!/bin/sh
# Помощник демо фабрики (сценарий - docs/demo.md).
#   scripts/demo.sh preflight            - всё ли готово к показу
#   scripts/demo.sh outage ПРИЛОЖЕНИЕ    - остановить приложение на стенде (Gatus заведёт задачу)
#   scripts/demo.sh restore ПРИЛОЖЕНИЕ   - запустить его снова (Gatus закроет задачу)
#   scripts/demo.sh crash ПРИЛОЖЕНИЕ     - падение процесса в контейнере приложения (GlitchTip -> задача)
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need docker curl jq
load_env
: "${KB_PORT:=8300}" "${PORTAL_PORT:=8400}"

# check ИМЯ АДРЕС - адрес отвечает 2xx или 3xx.
check() {
	if curl -fsS -o /dev/null -m 10 "$2" 2>/dev/null; then
		printf '  ок      %s\n' "$1"
	else
		printf '  НЕТ     %s (%s)\n' "$1" "$2"
		bad=1
	fi
}

container() { printf '%s-app-1' "${1:?ПРИЛОЖЕНИЕ}"; }

case ${1:-} in
preflight)
	bad=""
	log "службы:"
	check "Forgejo" "$FORGEJO_URL/api/healthz"
	if curl -fsS -o /dev/null -m 10 -H @.state/gw-owner.header "http://127.0.0.1:$GATEWAY_PORT/v1/models"; then
		printf '  ок      шлюз моделей\n'
	else
		printf '  НЕТ     шлюз моделей\n'
		bad=1
	fi
	for e in $DEPLOY_APPS; do check "стенд ${e%%=*} :${e#*=}" "http://127.0.0.1:${e#*=}/health"; done
	check "Gatus" "http://127.0.0.1:$GATUS_PORT/"
	check "GlitchTip" "http://127.0.0.1:$GLITCHTIP_PORT/_health/"
	check "база знаний (Hindsight)" "http://127.0.0.1:$KB_PORT/health"
	check "портал" "http://127.0.0.1:$PORTAL_PORT/"
	log "исполнители и учёт:"
	for f in codex/auth.json gw-agent-sub.key kb/api.header kb/mcp.token; do
		if [ -s ".state/$f" ]; then printf '  ок      .state/%s\n' "$f"; else printf '  НЕТ     .state/%s\n' "$f" && bad=1; fi
	done
	printf '  модель ответов базы: kb-openrouter (DeepSeek V4.1 Flash)\n'
	running=$(api GET "/repos/$FORGEJO_ADMIN_USER/todo/actions/runs?limit=10" | jq '[.workflow_runs[] | select(.status == "running" or .status == "waiting")] | length')
	printf '  прогонов Actions сейчас: %s\n' "$running"
	printf '  открытых PR в todo: %s\n' "$(api GET "/repos/$FORGEJO_ADMIN_USER/todo/pulls?state=open" | jq length)"
	[ -z "$bad" ] || die "не всё готово - см. строки НЕТ"
	log "готово к показу"
	;;
outage)
	dind deploy stop "$(container "${2:-}")" >/dev/null
	log "${2}: остановлено; Gatus заведёт задачу после трёх неудачных проверок (около 45 с)"
	;;
restore)
	dind deploy start "$(container "${2:-}")" >/dev/null
	log "${2}: запущено; Gatus закроет задачу после двух удачных проверок (около 30 с)"
	;;
crash)
	# Падение процесса с тем же перехватчиком ошибок и адресом сбора, что у самого приложения.
	dind deploy exec "$(container "${2:-}")" node --import /factory/errors.ts \
		-e "function demoCrash() { throw new Error('демо: необработанное исключение на стенде') } demoCrash()" 2>/dev/null || true
	log "${2}: падение отправлено в GlitchTip; задача появится примерно через минуту"
	;;
*)
	echo "команды: preflight, outage ПРИЛОЖЕНИЕ, restore ПРИЛОЖЕНИЕ, crash ПРИЛОЖЕНИЕ" >&2
	exit 2
	;;
esac
