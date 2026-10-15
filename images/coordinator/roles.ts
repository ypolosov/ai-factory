// Реестр ролей команды (.factory/roles.yml цели): кто держит какие роли и каким ролям какие
// решения разрешены. Фабрика видит в инструменте только учётку; цепочка учётка -> держатель ->
// роль отвечает, можно ли этому действию случиться в точке решения (FPF A.2.1).
// Нет файла - открытый режим: решения разрешены всем, как до реестра.
import { parse } from 'yaml';
import type { Tracker } from '../ports/ports.ts';
import { message } from './errors.ts';

export type HolderKind = 'human' | 'human-ai' | 'ai';

export interface Holder {
  id: string;
  kind: HolderKind;
  name: string;
  accounts: Record<string, string[]>; // инструмент -> учётки
}

// Точки решения, которые проверяет фабрика.
export const DECISIONS = {
  deploy: 'подтвердить выкладку',
  'approve-slice': 'утвердить нарезку',
  slice: 'предложить нарезку',
  'submit-task': 'передать задачу агенту',
  story: 'отдать стори на сверку',
  'propose-rule': 'предложить правило',
  'rerun-checks': 'перезапустить проверки',
  'design-check': 'сверить макет',
} as const;

export type Decision = keyof typeof DECISIONS;

export interface Check {
  ok: boolean;
  holder?: Holder;
  roles: string[]; // роли действующего
  need: string[]; // роли, которым решение разрешено
}

export interface RoleRegistry {
  open: boolean;
  holder(tool: string, account: string): Holder | undefined;
  rolesOf(holderId: string): string[];
  check(decision: Decision, tool: string, account: string | undefined): Check;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

export function parseRoles(text: string | undefined): RoleRegistry {
  if (!text?.trim()) {
    return { open: true, holder: () => undefined, rolesOf: () => [], check: () => ({ ok: true, roles: [], need: [] }) };
  }
  const raw = (parse(text) ?? {}) as {
    holders?: Record<string, Record<string, unknown>>;
    roles?: Record<string, unknown>;
    decisions?: Record<string, unknown>;
  };
  const holders: Holder[] = Object.entries(raw.holders ?? {}).map(([id, h]) => ({
    id,
    kind: (['human', 'human-ai', 'ai'].includes(String(h.kind)) ? String(h.kind) : 'human') as HolderKind,
    name: String(h.name ?? id),
    accounts: Object.fromEntries(Object.entries((h.accounts as Record<string, unknown>) ?? {}).map(([tool, a]) => [tool, list(a)])),
  }));
  const roles = Object.entries(raw.roles ?? {}).map(([role, ids]) => ({ role, ids: list(ids) }));
  const decisions = raw.decisions ?? {};
  const rolesOf = (id: string) => roles.filter((r) => r.ids.includes(id)).map((r) => r.role);
  const holder = (tool: string, account: string) => holders.find((h) => (h.accounts[tool] ?? []).includes(account));
  return {
    open: false,
    holder,
    rolesOf,
    check(decision, tool, account) {
      const need = list(decisions[decision]);
      const h = account ? holder(tool, account) : undefined;
      const mine = h ? rolesOf(h.id) : [];
      return { ok: mine.some((r) => need.includes(r)), ...(h ? { holder: h } : {}), roles: mine, need };
    },
  };
}

// Отказ человеку: какое решение, какие роли нужны и какие у него есть.
export function refusal(decision: Decision, c: Check, viaWebhook = false): string {
  const who = c.holder
    ? `${c.holder.name} (роли: ${c.roles.join(', ') || 'нет'})`
    : viaWebhook
      ? 'сообщение вебхука без учётки'
      : 'учётка не в реестре ролей';
  return `Нельзя ${DECISIONS[decision]}: это решение ролей ${c.need.join(', ') || '(никому не разрешено)'}, а здесь ${who}. Реестр ролей - .factory/roles.yml цели.`;
}

// Кто попросил: учётка, что последней поставила метку, а если метка стоит с создания - автор задачи.
export async function requester(tracker: Tracker, key: string, label: string): Promise<string | undefined> {
  const ev = (await tracker.labelEvents(key)).filter((e) => e.label === label && e.action === 'added').at(-1);
  return ev?.author ?? (await tracker.getIssue(key)).author;
}

// Задача с меткой-триггером от учётки без нужной роли: метка снимается, причина - в комментарии.
// Метку от учётки самой фабрики (задача из чата или MCP, нарезка, стори из вики) проверили там,
// где решение приняли, - второй раз не проверяем. Поэтому у фабрики своя учётка, не человека.
export async function admitIssue(
  d: { tracker: Tracker; roles?: () => Promise<RoleRegistry>; trackerTool?: string; log(m: string): void },
  key: string,
  label: string,
  decision: Decision,
): Promise<boolean> {
  if (!d.roles) return true;
  const registry = await d.roles();
  if (registry.open) return true;
  const who = await requester(d.tracker, key, label);
  const self = await d.tracker.me().catch((e) => {
    d.log(`своя учётка трекера не известна: ${message(e)}`);
    return undefined;
  });
  if (who !== undefined && who === self) return true;
  const c = registry.check(decision, d.trackerTool ?? 'jira', who);
  if (c.ok) return true;
  await d.tracker.removeLabel(key, label);
  await d.tracker.addComment(key, refusal(decision, c));
  d.log(`${key}: метка ${label} снята - нет роли для решения ${decision}`);
  return false;
}
