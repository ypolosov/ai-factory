// Учёт фабрики (DoD демо, п. 9): по каждой задаче агента - попытки, время агента, цена и токены
// из журнала шлюза (по номеру запуска в x-task-id), PR и вердикт стража. Цена подписок -
// теневая: шлюз считает её по каталогу цен.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Forge } from '../ports/ports.ts';
import { VERDICT_KEY } from './actions.ts';
import type { RunStore } from './runs.ts';

export interface Usage {
  requests: number;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  seconds: number;
}

// Журнал шлюза: запросы, у которых task_id начинается с префикса.
export type UsageSource = (taskPrefix: string) => Usage;

export function gatewayUsage(dbPath: string): UsageSource {
  return (prefix) => {
    const empty = { requests: 0, cost: 0, tokensIn: 0, tokensOut: 0, seconds: 0 };
    if (!existsSync(dbPath)) return empty;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const r = db
        .prepare(
          `select count(*) n, coalesce(sum(cost), 0) c, coalesce(sum(input_tokens), 0) i, coalesce(sum(output_tokens), 0) o,
            coalesce(sum(duration_ms), 0) ms from request_logs where json_extract(attributes_json, '$.task_id') like ?`,
        )
        .get(`${prefix}%`) as { n: number; c: number; i: number; o: number; ms: number };
      return { requests: r.n, cost: r.c, tokensIn: r.i, tokensOut: r.o, seconds: Math.round(r.ms / 1000) };
    } finally {
      db.close();
    }
  };
}

export interface AccountRow {
  issue: string;
  attempts: number;
  agentSeconds: number;
  usage: Usage;
  pull?: { number: number; url: string; state: string; verdict?: string };
}

export async function account(d: { runs: RunStore; forge: Forge; usage: UsageSource }): Promise<AccountRow[]> {
  const byIssue = new Map<string, AccountRow>();
  const pulls = await d.forge.listPulls({ state: 'all', limit: 100 });
  for (const meta of d.runs.list().filter((m) => !m.kind || m.kind === 'agent')) {
    const row = byIssue.get(meta.issue) ?? {
      issue: meta.issue,
      attempts: 0,
      agentSeconds: 0,
      usage: { requests: 0, cost: 0, tokensIn: 0, tokensOut: 0, seconds: 0 },
    };
    row.attempts++;
    const run = JSON.parse(d.runs.read(meta.runId, 'run.json')?.toString('utf8') ?? '{}') as { seconds?: number };
    row.agentSeconds += Number(run.seconds ?? 0);
    const u = d.usage(meta.runId);
    row.usage = {
      requests: row.usage.requests + u.requests,
      cost: row.usage.cost + u.cost,
      tokensIn: row.usage.tokensIn + u.tokensIn,
      tokensOut: row.usage.tokensOut + u.tokensOut,
      seconds: row.usage.seconds + u.seconds,
    };
    const p = pulls.find((x) => x.sourceBranch === `agent/${meta.runId}`);
    if (p) {
      const v = (await d.forge.statuses(p.headSha)).find((s) => s.key === VERDICT_KEY);
      row.pull = { number: p.number, url: p.url, state: p.state, ...(v ? { verdict: v.state } : {}) };
    }
    byIssue.set(meta.issue, row);
  }
  return [...byIssue.values()];
}

const STATE: Record<string, string> = { open: 'ждёт решения', merged: 'слит', closed: 'закрыт' };

export function accountText(rows: AccountRow[]): string {
  if (!rows.length) return 'Учёт фабрики: запусков агентов ещё не было.';
  const lines = rows.map((r) => {
    const pr = r.pull
      ? `PR ${r.pull.number} ${STATE[r.pull.state] ?? r.pull.state}, страж ${r.pull.verdict === 'success' ? 'зелёный' : r.pull.verdict ? 'красный' : '-'} ${r.pull.url}`
      : 'PR нет';
    return `- ${r.issue}: попыток ${r.attempts}; агент ${r.agentSeconds} с (модель ${r.usage.seconds} с, запросов ${r.usage.requests}); $${r.usage.cost.toFixed(3)}; токенов ${Math.round(r.usage.tokensIn / 1000)}k/${Math.round(r.usage.tokensOut / 1000)}k; ${pr}`;
  });
  const total = rows.reduce((s, r) => s + r.usage.cost, 0);
  const attempts = rows.reduce((s, r) => s + r.attempts, 0);
  return [`Учёт фабрики: задач ${rows.length}, попыток ${attempts}, $${total.toFixed(3)} (теневая цена подписки)`, ...lines].join('\n');
}
