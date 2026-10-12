// Отчёт фабрики - четыре числа учёта по репозиторию приложения:
//   1. цена принятого изменения (агент, ворота, ревью; у подписок - теневая цена);
//   2. время от задачи до стенда по участкам: задача -> PR, PR -> слияние, слияние -> стенд;
//   3. доля PR, слитых с первой попытки, по исполнителю и модели;
//   4. DORA выкладок: частота, доля неудачных выкладок, время восстановления;
// и сравнение исполнителей. Источники: API Forgejo (PR, коммиты, статусы, история задач) и
// журнал шлюза (SQLite: модель, токены, цена по метке задачи x-task-id).
//
// Окружение: FORGEJO_URL, REPOS ("владелец/имя ..."), DB (журнал шлюза), SECRETS_DIR
// (admin.token - токен администратора Forgejo). Вывод - Markdown в стандартный вывод.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export type Fetch = typeof fetch;

export interface LogRow {
  taskId: string;
  model: string;
  startedAt: string;
  completedAt: string;
  input: number;
  cacheRead: number;
  output: number;
  cost: number | null;
}

export interface Task {
  repo: string;
  issue: number;
  title: string;
  pr: number;
  executor: string;
  model: string;
  rounds: number;
  decisions: string[];
  merged: boolean;
  firstAttempt: boolean;
  agentUsd: number;
  gateUsd: number;
  agentMin: number;
  labeledAt: string | null;
  prAt: string;
  mergedAt: string | null;
  standAt: string | null;
}

export interface DeployEvent {
  sha: string;
  at: string;
  ok: boolean;
}

// Теневые цены за 1 млн токенов для записей журнала без цены (до появления цены в каталоге
// шлюза): вход без кэша, чтение кэша, выход. Источник - прайс API вендора на 12.10.2026.
export const SHADOW_RATES: Record<string, { input: number; cacheRead: number; output: number }> = {
  'gpt-6.1-sol': { input: 2.0, cacheRead: 0.1, output: 10.0 },
};

export function rowCost(r: LogRow): number {
  if (r.cost !== null) return r.cost;
  const rate = SHADOW_RATES[r.model];
  if (!rate) return 0;
  const fresh = Math.max(0, r.input - r.cacheRead);
  return (fresh * rate.input + r.cacheRead * rate.cacheRead + r.output * rate.output) / 1e6;
}

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

// Минуты с точностью до десятых.
export function minutes(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return Math.round((Date.parse(to) - Date.parse(from)) / 6000) / 10;
}

// Записи задачи в журнале шлюза: метки с репозиторием и старые без него (окно - время задачи).
export function taskRows(rows: LogRow[], repo: string, issue: number, pr: number, from: string, to: string | null) {
  const name = repo.split('/')[1]!;
  const inWindow = (r: LogRow) => r.startedAt >= from && (to === null || r.startedAt <= to);
  const agent = rows.filter(
    (r) => r.taskId.startsWith(`${name}-issue-${issue}-run-`) || (r.taskId.startsWith(`issue-${issue}-run-`) && inWindow(r)),
  );
  const gate = rows.filter(
    (r) =>
      r.taskId.startsWith(`${name}-gate-pr-${pr}-`) ||
      ((r.taskId.startsWith(`gate-pr-${pr}-`) || r.taskId === `pr-${pr}-review`) && inWindow(r)),
  );
  return { agent, gate };
}

// Время работы модели: по каждому прогону - от первого до последнего запроса, в сумме.
export function agentMinutes(rows: LogRow[]): number {
  const runs = new Map<string, { a: number; b: number }>();
  for (const r of rows) {
    const a = Date.parse(r.startedAt);
    const b = Date.parse(r.completedAt);
    const cur = runs.get(r.taskId);
    runs.set(r.taskId, cur ? { a: Math.min(cur.a, a), b: Math.max(cur.b, b) } : { a, b });
  }
  let ms = 0;
  for (const { a, b } of runs.values()) ms += b - a;
  return Math.round(ms / 6000) / 10;
}

// Модели задачи - по частоте в записях агента; исполнитель - по семейству модели.
export function models(rows: LogRow[]): string[] {
  const n = new Map<string, number>();
  for (const r of rows) n.set(r.model, (n.get(r.model) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

export function executorOf(model: string): string {
  if (model.startsWith('gpt-')) return 'codex';
  if (model.startsWith('claude-')) return 'claude';
  return 'opencode';
}

// DORA по статусам "deploy / stand" на коммитах main: итог каждой попытки выкладки.
export function dora(events: DeployEvent[]): { deploys: number; failed: number; days: number; restoreMin: number | null } {
  const ev = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const ok = ev.filter((e) => e.ok);
  const failed = ev.filter((e) => !e.ok);
  // Дни - календарные (UTC) от первой попытки до последней включительно.
  const day = (at: string) => Math.floor(Date.parse(at) / 86400000);
  const days = ev.length === 0 ? 1 : day(ev.at(-1)!.at) - day(ev[0]!.at) + 1;
  const restores: number[] = [];
  for (const f of failed) {
    const next = ok.find((e) => e.at > f.at);
    if (next) restores.push(minutes(f.at, next.at)!);
  }
  return { deploys: ok.length, failed: failed.length, days, restoreMin: median(restores) };
}

const usd = (x: number) => x.toFixed(2);
const fmt = (x: number | null) => (x === null ? '-' : x >= 10 ? String(Math.round(x)) : x.toFixed(1));
const pct = (a: number, b: number) => (b === 0 ? '-' : `${Math.round((100 * a) / b)}%`);

export function render(repos: string[], tasks: Task[], deploys: Map<string, DeployEvent[]>, date: string): string {
  const out: string[] = [];
  out.push(`# Отчёт фабрики: ${repos.map((r) => r.split('/')[1]).join(', ')}`, '', `На ${date}. Задачи разработки (PR "agent: ...").`, '');
  const merged = tasks.filter((t) => t.merged);
  const total = (t: Task) => t.agentUsd + t.gateUsd;
  out.push('## 1. Цена принятого изменения', '');
  out.push(
    `Слито изменений: ${merged.length}. Цена одного: медиана ${usd(median(merged.map(total)) ?? 0)} $, ` +
      `всего ${usd(merged.reduce((s, t) => s + total(t), 0))} $ (агент ${usd(merged.reduce((s, t) => s + t.agentUsd, 0))}, ` +
      `ворота и ревью ${usd(merged.reduce((s, t) => s + t.gateUsd, 0))}). У подписок цена теневая - по прайсу API вендора.`,
    '',
  );
  out.push('## 2. Время от задачи до стенда, мин (медиана)', '');
  const seg = (f: (t: Task) => number | null) => fmt(median(merged.map(f).filter((x): x is number => x !== null)));
  out.push('| Участок | Медиана |', '|---|---|');
  out.push(`| работа модели (агент) | ${seg((t) => t.agentMin)} |`);
  out.push(`| задача -> PR | ${seg((t) => minutes(t.labeledAt, t.prAt))} |`);
  out.push(`| PR -> слияние (проверки, ворота, доработки, человек) | ${seg((t) => minutes(t.prAt, t.mergedAt))} |`);
  out.push(`| слияние -> стенд (сборка, Trivy, проверка здоровья) | ${seg((t) => minutes(t.mergedAt, t.standAt))} |`);
  out.push(`| всего: задача -> стенд | ${seg((t) => minutes(t.labeledAt, t.standAt))} |`, '');
  out.push('## 3. Слиты с первой попытки - по исполнителю и модели', '');
  out.push(
    '| Исполнитель | Модель | Задач | С первой попытки | Работа модели, мин (медиана) | Задача -> стенд, мин (медиана) | Цена, $ (медиана) |',
    '|---|---|---|---|---|---|---|',
  );
  const groups = new Map<string, Task[]>();
  for (const t of merged) groups.set(`${t.executor}|${t.model}`, [...(groups.get(`${t.executor}|${t.model}`) ?? []), t]);
  for (const [k, g] of [...groups.entries()].sort()) {
    const [ex, model] = k.split('|');
    out.push(
      `| ${ex} | ${model} | ${g.length} | ${pct(g.filter((t) => t.firstAttempt).length, g.length)} | ${fmt(median(g.map((t) => t.agentMin)))} | ` +
        `${fmt(median(g.map((t) => minutes(t.labeledAt, t.standAt)).filter((x): x is number => x !== null)))} | ${usd(median(g.map(total)) ?? 0)} |`,
    );
  }
  out.push(`| все | | ${merged.length} | ${pct(merged.filter((t) => t.firstAttempt).length, merged.length)} | | | |`, '');
  out.push('## 4. DORA выкладок', '');
  out.push('| Приложение | Выкладок | В сутки | Неудачных попыток | Доля неудачных | Восстановление, мин (медиана) |', '|---|---|---|---|---|---|');
  for (const r of repos) {
    const d = dora(deploys.get(r) ?? []);
    out.push(
      `| ${r.split('/')[1]} | ${d.deploys} | ${(d.deploys / d.days).toFixed(1)} | ${d.failed} | ${pct(d.failed, d.deploys + d.failed)} | ${fmt(d.restoreMin)} |`,
    );
  }
  out.push('', '## Задачи', '');
  out.push('| Задача | PR | Исполнитель, модель | Кругов | Решения ворот по кругам | С первой попытки | Задача -> стенд, мин | Цена, $ |', '|---|---|---|---|---|---|---|---|');
  for (const t of tasks) {
    out.push(
      `| ${t.title} | #${t.pr} | ${t.executor}, ${t.model} | ${t.rounds} | ${t.decisions.join('; ') || '-'} | ${t.merged ? (t.firstAttempt ? 'да' : 'нет') : 'не слит'} | ` +
        `${fmt(minutes(t.labeledAt, t.standAt))} | ${usd(total(t))} |`,
    );
  }
  return out.join('\n') + '\n';
}

// --- сбор данных ---

export function loadLog(dbPath: string): LogRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare(
      `select json_extract(attributes_json, '$.task_id') t, gen_ai_request_model m, started_at s, completed_at c,
        coalesce(input_tokens, 0) i, coalesce(json_extract(attributes_json, '$."gen_ai.usage.cache_read.input_tokens"'), 0) cr,
        coalesce(output_tokens, 0) o, cost from request_logs
       where gen_ai_request_model is not null and json_extract(attributes_json, '$.task_id') is not null`,
    )
    .all() as { t: string; m: string; s: string; c: string; i: number; cr: number; o: number; cost: number | null }[];
  db.close();
  return rows.map((r) => ({ taskId: r.t, model: r.m, startedAt: r.s, completedAt: r.c, input: r.i, cacheRead: r.cr, output: r.o, cost: r.cost }));
}

export async function collect(base: string, token: string, repo: string, log: LogRow[], fetchFn: Fetch = fetch) {
  const get = async (p: string) => {
    const res = await fetchFn(`${base}/api/v1${p}`, { headers: { authorization: `token ${token}` } });
    if (!res.ok) throw new Error(`Forgejo ${p}: HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  const gateDecision = async (sha: string) => {
    const st = (await get(`/repos/${repo}/commits/${sha}/statuses?limit=50`)) as { id: number; context: string; description: string; created_at: string }[];
    return st.filter((s) => s.context === 'factory / ai-gate').sort((a, b) => a.id - b.id).at(-1);
  };
  const pulls = (await get(`/repos/${repo}/pulls?state=all&limit=50`)) as {
    number: number;
    title: string;
    body: string;
    created_at: string;
    merged_at: string | null;
    closed_at: string | null;
    merged: boolean;
    merge_commit_sha: string | null;
  }[];
  const tasks: Task[] = [];
  for (const p of pulls.filter((x) => x.title.startsWith('agent:')).sort((a, b) => a.number - b.number)) {
    const issue = Number(/Closes #(\d+)/.exec(p.body ?? '')?.[1]);
    if (!issue) continue;
    const it = (await get(`/repos/${repo}/issues/${issue}`)) as { title: string };
    const timeline = (await get(`/repos/${repo}/issues/${issue}/timeline`)) as { type: string; label?: { name: string }; created_at: string }[];
    const labeledAt = timeline.find((e) => e.type === 'label' && e.label?.name === 'agent')?.created_at ?? null;
    const commits = ((await get(`/repos/${repo}/pulls/${p.number}/commits?limit=50`)) as {
      sha: string;
      author: { login: string } | null;
      commit: { author: { name: string } };
      parents: unknown[];
    }[]).reverse();
    let rounds = 0;
    let decision = '';
    let gated = false;
    const decisions: string[] = [];
    for (const c of commits) {
      const bot = (c.author?.login ?? c.commit.author.name) === 'factory-bot' && c.parents.length < 2;
      if (bot) {
        if (rounds > 0) decisions.push(decision || 'нет решения');
        rounds++;
        decision = '';
      }
      const g = await gateDecision(c.sha);
      if (!g) continue;
      gated = true;
      const sc = /^оценки ([0-9, ]*[0-9])/.exec(g.description)?.[1];
      decision = g.description.includes('решение человека')
        ? `${sc ?? g.description.split(' - ')[0]} -> решение человека`
        : g.description.includes('готово для человека')
          ? `${sc} -> человеку`
          : `${sc ?? 'красные проверки'} -> доработка`;
    }
    if (rounds > 0) decisions.push(decision || 'нет решения');
    const from = (labeledAt ?? p.created_at).replace(/Z$/, '');
    // Окно задачи заканчивается слиянием или закрытием PR: старые метки без репозитория
    // иначе подхватили бы прогоны задач с тем же номером в другом репозитории.
    const { agent, gate } = taskRows(log, repo, issue, p.number, from, p.merged_at ?? p.closed_at);
    let standAt: string | null = null;
    if (p.merged && p.merge_commit_sha) {
      const st = (await get(`/repos/${repo}/commits/${p.merge_commit_sha}/statuses?limit=50`)) as { context: string; status: string; created_at: string }[];
      standAt = st.filter((s) => s.context === 'deploy / stand' && s.status === 'success').map((s) => s.created_at).sort()[0] ?? null;
    }
    const executor = /исполнитель: ([^,]+)/.exec(p.body ?? '')?.[1] ?? '?';
    const ms = models(agent);
    tasks.push({
      repo,
      issue,
      title: `#${issue} ${it.title}`,
      pr: p.number,
      executor: ms.length ? [...new Set(ms.map(executorOf))].join(' + ') : executor,
      model: ms.length ? ms.join(' + ') : '?',
      rounds,
      decisions: gated ? decisions : [],
      merged: p.merged,
      firstAttempt: p.merged && rounds === 1,
      agentUsd: agent.reduce((s, r) => s + rowCost(r), 0),
      gateUsd: gate.reduce((s, r) => s + rowCost(r), 0),
      agentMin: agentMinutes(agent),
      labeledAt,
      prAt: p.created_at,
      mergedAt: p.merged_at,
      standAt,
    });
  }
  // Выкладки: итог статуса "deploy / stand" на каждом коммите main.
  const main = (await get(`/repos/${repo}/commits?sha=main&limit=100&stat=false`)) as { sha: string }[];
  const deploys: DeployEvent[] = [];
  for (const c of main) {
    const st = ((await get(`/repos/${repo}/commits/${c.sha}/statuses?limit=50`)) as { id: number; context: string; status: string; created_at: string }[])
      .filter((s) => s.context === 'deploy / stand' && s.status !== 'pending')
      .sort((a, b) => a.id - b.id);
    const last = st.at(-1);
    if (last) deploys.push({ sha: c.sha, at: last.created_at, ok: last.status === 'success' });
  }
  return { tasks, deploys };
}

if (import.meta.main) {
  const repos = (process.env['REPOS'] ?? '').split(/\s+/).filter(Boolean);
  const token = readFileSync(`${process.env['SECRETS_DIR'] ?? '/secrets'}/admin.token`, 'utf-8').trim();
  const log = loadLog(process.env['DB'] ?? '/db/gateway.sqlite');
  const all: Task[] = [];
  const deploys = new Map<string, DeployEvent[]>();
  for (const r of repos) {
    const { tasks, deploys: d } = await collect(process.env['FORGEJO_URL'] ?? 'http://forgejo:3000', token, r, log);
    all.push(...tasks);
    deploys.set(r, d);
  }
  process.stdout.write(render(repos, all, deploys, new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'));
}
