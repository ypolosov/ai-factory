#!/bin/sh
# Учёт задач разработки: по строке на PR агента-разработчика (заголовок "agent: ...") -
# исполнитель и модель, круги доработки, оценки ворот ИИ по кругам, признак "слит с первой
# попытки", время по участкам и цена из журнала шлюза.
#   - круги - коммиты бота в PR (без слияний); с первой попытки - слит за один круг;
#   - время: агент - работа модели по журналу шлюза (сумма прогонов); задача -> PR - от
#     первой метки agent до PR; PR -> слияние - проверки, ворота, доработки и решение человека;
#   - цена: агент - запросы задачи issue-N-run-*; ворота и ревью - судьи gate-pr-P-* и
#     совет pr-P-review. У подписок цена теневая (шлюз считает её по каталогу).
# Использование: scripts/task-report.sh РЕПОЗИТОРИЙ - таблица Markdown в стандартный вывод.
set -eu
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

need curl jq sqlite3
load_env
name=${1:?использование: scripts/task-report.sh РЕПОЗИТОРИЙ}
repo="$FORGEJO_ADMIN_USER/$name"
db=.state/gateway-db/gateway.sqlite
[ -f "$db" ] || die "нет журнала шлюза $db"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# sql ЗАПРОС - журнал шлюза только на чтение (шлюз пишет в него в это же время).
sql() { sqlite3 -readonly -separator ' ' "file:$db?mode=ro" "$1"; }
mins() { jq -rn --arg a "$1" --arg b "$2" 'if $a == "" or $b == "" then "-"
	else ((($b | fromdateiso8601) - ($a | fromdateiso8601)) / 60 | round | tostring) end'; }

api GET "/repos/$repo/pulls?state=all&limit=50" | jq -c 'sort_by(.number) | .[] | select(.title | startswith("agent:"))' >"$tmp/prs"

echo "| Задача | PR | Исполнитель, модель | Кругов | Оценки ворот по кругам | С первой попытки | Агент, мин | Задача -> PR, мин | PR -> слияние, мин | Агент, \$ | Ворота и ревью, \$ | Итого, \$ |"
echo "|---|---|---|---|---|---|---|---|---|---|---|---|"
while IFS= read -r pr; do
	n=$(printf '%s' "$pr" | jq -r .number)
	issue=$(printf '%s' "$pr" | jq -r '.body | capture("Closes #(?<n>[0-9]+)").n // empty')
	[ -n "$issue" ] || continue
	title=$(api GET "/repos/$repo/issues/$issue" | jq -r .title)
	who=$(printf '%s' "$pr" | jq -r '.body | (capture("исполнитель: (?<e>[^,]+)") | .e) // "?"')
	created=$(printf '%s' "$pr" | jq -r .created_at)
	merged=$(printf '%s' "$pr" | jq -r '.merged_at // ""')
	labeled=$(api GET "/repos/$repo/issues/$issue/timeline" |
		jq -r '[.[] | select(.type == "label" and .label.name == "agent")][0].created_at // ""')
	# Окно задачи в журнале шлюза: номера задач и PR в разных репозиториях совпадают,
	# поэтому запросы берутся только от первой метки agent до слияния (или до сих пор).
	from=${labeled:-$created}
	from=${from%Z}
	to=${merged:-9999}
	win="started_at >= '$from' and started_at <= '${to%Z}~'"
	# Модель - как её назвал провайдер в журнале шлюза (псевдоним шлюза ничего не говорит).
	model=$(sql "select group_concat(m, ' + ') from (select distinct gen_ai_request_model m from request_logs
		where $win and json_extract(attributes_json, '\$.task_id') like 'issue-$issue-run-%' and gen_ai_request_model is not null)")
	who="$who, ${model:-?}"

	# Круги и оценки ворот. Круг начинается коммитом бота; решение круга - последний статус
	# "factory / ai-gate" на его коммитах (в круг входят и слияния main, и повторы проверок).
	api GET "/repos/$repo/pulls/$n/commits?limit=50" |
		jq -r 'reverse | .[] | [.sha, (if ((.author.login // .commit.author.name) == "factory-bot") and (.parents | length < 2) then "bot" else "other" end)] | @tsv' >"$tmp/commits"
	rounds=0
	scores=""
	decision=""
	while read -r sha kind; do
		if [ "$kind" = bot ]; then
			[ "$rounds" -eq 0 ] || scores="${scores:+$scores; }${decision:-нет решения}"
			rounds=$((rounds + 1))
			decision=""
		fi
		d=$(api GET "/repos/$repo/commits/$sha/statuses?limit=50" |
			jq -r '[.[] | select(.context == "factory / ai-gate")] | sort_by(.id) | last | .description // ""')
		[ -n "$d" ] || continue
		sc=$(printf '%s' "$d" | sed -n 's/^оценки \([0-9, ]*[0-9]\).*/\1/p')
		case $d in
		*"доработк"*) decision="${sc:-красные проверки} -> доработка" ;;
		*"готово для человека"*) decision="$sc -> человеку" ;;
		*) decision="${sc:+$sc }-> решение человека" ;;
		esac
	done <"$tmp/commits"
	[ "$rounds" -eq 0 ] || scores="${scores:+$scores; }${decision:-нет решения}"
	first=$([ -n "$merged" ] && [ "$rounds" -eq 1 ] && echo да || echo нет)
	[ -n "$merged" ] || first="не слит"

	# Цена и время модели - из журнала шлюза.
	# shellcheck disable=SC2046 # два числа через пробел
	set -- $(sql "select coalesce(round(sum(c), 4), 0), coalesce(cast(round(sum(s) / 60) as integer), 0) from (
		select sum(cost) c, (julianday(max(completed_at)) - julianday(min(started_at))) * 86400 s
		from request_logs where $win and json_extract(attributes_json, '\$.task_id') like 'issue-$issue-run-%'
		group by json_extract(attributes_json, '\$.task_id'))")
	agent_usd=$1
	agent_min=$2
	gate_usd=$(sql "select coalesce(round(sum(cost), 4), 0) from request_logs where $win
		and (json_extract(attributes_json, '\$.task_id') like 'gate-pr-$n-%'
		or json_extract(attributes_json, '\$.task_id') = 'pr-$n-review')")
	total=$(jq -rn --argjson a "$agent_usd" --argjson g "$gate_usd" '$a + $g | . * 10000 | round / 10000')
	echo "| #$issue $title | #$n | $who | $rounds | $scores | $first | $agent_min | $(mins "$labeled" "$created") | $(mins "$created" "$merged") | $agent_usd | $gate_usd | $total |"
done <"$tmp/prs"
