// Доставка (UC4): задача агента (метка agent-review) закрывается сама, когда выложенный на стенд
// коммит ветки по умолчанию содержит её ключ, - со ссылками на коммит, PR и выкладку. Баги сбоев
// (метка incident) закрывает свой проход вместе с ошибкой в сборщике (incidents.ts).
import type { Forge, Tracker } from '../ports/ports.ts';
import { message } from './errors.ts';

export interface DeliveryDeps {
  forge: Forge;
  tracker: Tracker;
  review: string; // метка "PR агента ждёт человека"
  post?(text: string): Promise<void>;
  log(message: string): void;
}

export function deliveryLoop(d: DeliveryDeps) {
  let busy = false;
  async function close() {
    const tasks = (await d.tracker.listIssues({ label: d.review, state: 'open' })).filter((t) => !t.labels.includes('incident'));
    if (!tasks.length) return;
    const repo = await d.forge.repo();
    const head = await d.forge.branchHead(repo.defaultBranch);
    if (!head) return;
    const deployed = (await d.forge.statuses(head)).find((s) => s.key === 'factory/deploy' && s.state === 'success');
    if (!deployed) return;
    const commits = await d.forge.commits(undefined, head);
    for (const t of tasks) {
      const c = commits.findLast((x) => new RegExp(`\\b${t.key}\\b`).test(x.message));
      if (!c) continue;
      const title = c.message.split('\n')[0] ?? '';
      const n = /\(#(\d+)\)\s*$/.exec(title)?.[1];
      const pull = n ? await d.forge.getPull(Number(n)).catch(() => undefined) : undefined;
      await d.tracker.addComment(
        t.key,
        `Сделано и выложено: ${title} (${c.sha.slice(0, 7)})${pull ? `, PR ${pull.url}` : ''}; стенд - ${deployed.description}.`,
      );
      await d.tracker.removeLabel(t.key, d.review);
      await d.tracker.close(t.key);
      await d.post?.(`Задача ${t.key} закрыта: ${t.title} - на стенде (${c.sha.slice(0, 7)}).`);
      d.log(`доставка: ${t.key} закрыта (${c.sha.slice(0, 7)})`);
    }
  }
  return {
    async tick() {
      if (busy) return;
      busy = true;
      try {
        await close();
      } catch (e) {
        d.log(`доставка: ${message(e)}`);
      } finally {
        busy = false;
      }
    },
  };
}
