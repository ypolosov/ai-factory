// Сбой на стенде -> баг (UC6): ошибка из сбора ошибок заводит баг в трекере со ссылкой на
// событие, без дублей - баг помечен отпечатком ошибки; повторы - комментариями; повтор после
// исправления открывает баг снова. Баг закрывается сам, когда коммит с его ключом выложен на
// стенд, и ошибка закрывается в сборе ошибок.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Forge, Incidents, Tracker } from '../ports/ports.ts';
import { message } from './errors.ts';

export interface IncidentDeps {
  incidents: Incidents;
  tracker: Tracker;
  forge: Forge;
  post(text: string): Promise<void>; // канал эксплуатации
  stateFile: string; // сколько событий уже сообщено по каждой ошибке
  log(message: string): void;
}

const LABEL = 'incident';
const mark = (id: string) => `incident-${id}`;
const REPEAT_MS = 10 * 60 * 1000; // повтор сбоя - не чаще раза в 10 минут

// seen - сколько событий сообщено по ошибке; fixed - каким коммитом закрыт баг (тем же коммитом
// баг, открытый повтором сбоя, заново не закрывается).
type State = { seen: Record<string, { count: number; at: number }>; fixed: Record<string, string> };

export function incidentLoop(d: IncidentDeps) {
  let busy = false;
  const load = (): State => (existsSync(d.stateFile) ? (JSON.parse(readFileSync(d.stateFile, 'utf8')) as State) : { seen: {}, fixed: {} });
  const save = (s: State) => writeFileSync(d.stateFile, JSON.stringify(s));

  async function report() {
    const state = load();
    const seen = state.seen;
    for (const i of await d.incidents.open()) {
      const [bug] = await d.tracker.listIssues({ label: mark(i.id), state: 'all', limit: 1 });
      const now = Date.now();
      if (!bug) {
        const b = await d.tracker.createIssue({
          title: `Сбой на стенде: ${i.title}`.slice(0, 200),
          body: `Ошибка на стенде: ${i.title}\nГде: ${i.culprit}\nСобытий: ${i.count}, последнее ${i.lastSeen}\nСобытие: ${i.url}\n\nОтпечаток ошибки ${i.id}: повторы приходят комментариями сюда. Исправление - PR с ключом этой задачи; после выкладки баг закроется сам.`,
          labels: ['bug', LABEL, mark(i.id)],
        });
        await d.post(`Сбой на стенде: ${i.title} (${i.culprit}). Баг ${b.key}: ${b.url}\nСобытие: ${i.url}`);
        seen[i.id] = { count: i.count, at: now };
        d.log(`сбой ${i.id} -> ${b.key}`);
      } else if (bug.state === 'closed') {
        await d.tracker.reopen(bug.key);
        await d.tracker.addComment(bug.key, `Сбой повторился после исправления: событий ${i.count}, последнее ${i.lastSeen}. ${i.url}`);
        await d.post(`Сбой вернулся: ${bug.key} ${i.title}. ${bug.url}`);
        seen[i.id] = { count: i.count, at: now };
      } else if (i.count > (seen[i.id]?.count ?? 0) && now - (seen[i.id]?.at ?? 0) >= REPEAT_MS) {
        await d.tracker.addComment(bug.key, `Повтор сбоя: событий ${i.count}, последнее ${i.lastSeen}.`);
        seen[i.id] = { count: i.count, at: now };
      }
    }
    save(state);
  }

  // Баг закрыт, когда выложенный на стенд коммит ветки по умолчанию содержит исправление с его ключом.
  async function close() {
    const bugs = await d.tracker.listIssues({ label: LABEL, state: 'open' });
    if (!bugs.length) return;
    const repo = await d.forge.repo();
    const head = await d.forge.branchHead(repo.defaultBranch);
    if (!head) return;
    const deployed = (await d.forge.statuses(head)).find((s) => s.key === 'factory/deploy' && s.state === 'success');
    if (!deployed) return;
    const commits = await d.forge.commits(undefined, head);
    const state = load();
    for (const b of bugs) {
      const fix = commits.findLast((c) => new RegExp(`\\b${b.key}\\b`).test(c.message));
      if (!fix || state.fixed[b.key] === fix.sha) continue;
      state.fixed[b.key] = fix.sha;
      save(state);
      await d.tracker.addComment(
        b.key,
        `Исправлено: ${fix.message.split('\n')[0]} (${fix.sha.slice(0, 7)}), выложено на стенд - ${deployed.description}.`,
      );
      await d.tracker.close(b.key);
      const id = b.labels.find((l) => l.startsWith('incident-'))?.slice('incident-'.length);
      if (id) await d.incidents.resolve(id);
      await d.post(`Баг ${b.key} закрыт: исправление ${fix.sha.slice(0, 7)} на стенде.`);
    }
  }

  return {
    async tick() {
      if (busy) return;
      busy = true;
      try {
        await report();
        await close();
      } catch (e) {
        d.log(`проход сбоев: ${message(e)}`);
      } finally {
        busy = false;
      }
    },
  };
}
