#!/bin/sh
# Настраивает базу знаний (Onyx) после scripts/kb-up.sh: администратор, личные токены
# (скрипты, загрузка из Forgejo, MCP агентов), модель ответов через шлюз (три пути kb-*,
# по умолчанию - KB_MODEL) и эмбеддинги kb-embed (bge-m3 через OpenRouter).
# Повторный запуск безопасен: готовое не трогает. Секреты - в .state/kb и .state/kbsync,
# в аргументы команд не попадают (тела запросов и заголовки - из файлов).
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need curl jq od
load_env
: "${KB_PORT:=8300}" "${KB_ADMIN_EMAIL:=admin@ai-factory.dev}" "${KB_MODEL:=kb-claude-cli}"
kb=http://127.0.0.1:$KB_PORT/api
st=.state/kb
mkdir -p $st .state/kbsync
chmod 700 $st .state/kbsync
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# onyx МЕТОД ПУТЬ [ФАЙЛ_ТЕЛА] - запрос от администратора по личному токену.
onyx() {
	if [ -n "${3:-}" ]; then
		curl -fsS -X "$1" -H @$st/admin.header -H 'content-type: application/json' --data @"$3" "$kb$2"
	else
		curl -fsS -X "$1" -H @$st/admin.header "$kb$2"
	fi
}

# 1. Администратор: первый зарегистрированный в Onyx - администратор. Почта - в домене
#    общего вида: Onyx не принимает служебные домены вроде .local.
[ -s $st/admin.password ] || printf 'Kb-%sA1!' "$(random_hex 12)" >$st/admin.password
if [ ! -s $st/admin.token ]; then
	jq -n --arg e "$KB_ADMIN_EMAIL" --rawfile p $st/admin.password '{email: $e, password: $p}' >"$tmp/reg.json"
	curl -sS -o /dev/null -H 'content-type: application/json' --data @"$tmp/reg.json" "$kb/auth/register" || true
	printf 'username=%s&password=%s' "$KB_ADMIN_EMAIL" "$(jq -rn --rawfile p $st/admin.password '$p | @uri')" >"$tmp/login"
	curl -fsS -o /dev/null -c "$tmp/cookies" --data @"$tmp/login" "$kb/auth/login" || die "Onyx: вход администратора не удался"
	# Личные токены: для скриптов и загрузки - без ограничений, для MCP агентов - только поиск.
	for spec in "kb-admin:null:$st/admin.token" "kbsync:null:.state/kbsync/onyx.token" 'kb-mcp:["read:search"]:'$st/mcp.token; do
		_name=${spec%%:*}
		_rest=${spec#*:}
		_file=${_rest##*:}
		[ ! -s "$_file" ] || continue
		jq -n --arg n "$_name" --argjson s "${_rest%:*}" '{name: $n, expiration_days: null, scopes: $s}' >"$tmp/pat.json"
		curl -fsS -b "$tmp/cookies" -H 'content-type: application/json' --data @"$tmp/pat.json" "$kb/user/pats" |
			jq -r '.token // empty' >"$_file"
		[ -s "$_file" ] || die "Onyx: токен $_name не выпущен"
	done
fi
printf 'Authorization: Bearer %s\n' "$(cat $st/admin.token)" >$st/admin.header

# 2. Модель ответов: шлюз фабрики в формате OpenAI, ключ kb - как Bearer (Onyx иначе не умеет).
if ! onyx GET /admin/llm/provider | jq -e '.providers[] | select(.name == "factory-gateway")' >/dev/null; then
	jq -n --rawfile k .state/gw-kb.key '{
		name: "factory-gateway", provider: "openai_compatible", api_key: ($k | rtrimstr("\n")),
		api_key_changed: true, api_base: "http://gateway:4000/v1", is_public: true,
		model_configurations: [
			{name: "kb-claude-cli", display_name: "Claude по подписке (claude -p)", is_visible: true, max_input_tokens: 200000},
			{name: "kb-claude-api", display_name: "Claude по API-кредитам Max", is_visible: true, max_input_tokens: 200000},
			{name: "kb-openrouter", display_name: "DeepSeek через OpenRouter", is_visible: true, max_input_tokens: 128000}
		]}' >"$tmp/llm.json"
	onyx PUT "/admin/llm/provider?is_creation=true" "$tmp/llm.json" >/dev/null
	log "Onyx: модели ответов через шлюз заведены"
fi
./scripts/kb-model.sh "$KB_MODEL"

# 3. Эмбеддинги: kb-embed через шлюз (Onyx шлёт {model, input} с Bearer на api_url).
if ! onyx GET /search-settings/get-current-search-settings | jq -e '.model_name == "kb-embed"' >/dev/null; then
	jq -n --rawfile k .state/gw-kb.key '{provider_type: "litellm", api_key: ($k | rtrimstr("\n")),
		api_key_changed: true, api_url: "http://gateway:4000/v1/embeddings"}' >"$tmp/emb.json"
	onyx PUT /admin/embedding/embedding-provider "$tmp/emb.json" >/dev/null
	jq -n '{model_name: "kb-embed", model_dim: 1024, normalize: true, query_prefix: "", passage_prefix: "",
		provider_type: "litellm", api_url: "http://gateway:4000/v1/embeddings", index_name: null,
		multipass_indexing: false, enable_contextual_rag: false, switchover_type: "instant"}' >"$tmp/search.json"
	onyx POST /search-settings/set-new-search-settings "$tmp/search.json" >/dev/null
	log "Onyx: эмбеддинги kb-embed (bge-m3, 1024) - переиндексация по новой модели"
fi

# 4. Загрузка из Forgejo: токен учётки эксплуатации (чтение репозиториев и задач).
cmp -s .state/ops.token .state/kbsync/forgejo.token || cp .state/ops.token .state/kbsync/forgejo.token
log "база знаний настроена: http://127.0.0.1:$KB_PORT, вход $KB_ADMIN_EMAIL, пароль в $st/admin.password"
