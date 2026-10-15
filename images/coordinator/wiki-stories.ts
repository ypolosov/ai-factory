// Стори из вики (UC1): продукт пишет стори страницей Confluence с меткой story. Фабрика заводит
// по ней стори в трекере (с меткой-триггером сверщика и ссылкой на страницу), правка страницы
// обновляет стори и запускает сверку заново; итог сверки - комментарием на странице.
// Отдать стори на сверку - решение роли (реестр ролей): проверяется автор версии страницы.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Tracker, Wiki, WikiPage } from '../ports/ports.ts';
import { message } from './errors.ts';
import { type RoleRegistry, refusal } from './roles.ts';
import type { StoryLabels } from './story.ts';

export interface WikiStoryDeps {
  wiki: Wiki;
  tracker: Tracker;
  labels: StoryLabels;
  pageLabel: string; // метка стори в вики
  stateFile: string;
  roles?(): Promise<RoleRegistry>;
  wikiTool?: string; // инструмент учёток вики в реестре ролей
  log(message: string): void;
}

// По странице: какая версия передана в трекер, какой итог сверки уже сообщён на странице и какой
// версии отказано (у автора нет роли).
type State = Record<string, { issue?: string; version: number; told?: string; refused?: number }>;

const mark = (pageId: string) => `wiki-${pageId}`;

export function wikiStories(d: WikiStoryDeps) {
  let busy = false;
  const load = (): State => (existsSync(d.stateFile) ? (JSON.parse(readFileSync(d.stateFile, 'utf8')) as State) : {});
  const save = (s: State) => writeFileSync(d.stateFile, JSON.stringify(s));
  const body = (p: { body: string; url: string; version: number }) => `${p.body}\n\nИсточник: ${p.url} (версия ${p.version})`;
  const gate = async (p: WikiPage): Promise<string | undefined> => {
    const c = (await d.roles?.())?.check('story', d.wikiTool ?? 'confluence', p.author);
    return c && !c.ok ? refusal('story', c) : undefined;
  };

  async function sync() {
    const state = load();
    for (const p of await d.wiki.pagesByLabel(d.pageLabel)) {
      const known = state[p.id];
      if (known && p.version <= Math.max(known.version, known.refused ?? 0)) continue;
      const denied = await gate(p);
      if (denied) {
        await d.wiki.comment(p.id, denied);
        state[p.id] = { ...(known ?? { version: 0 }), refused: p.version };
        d.log(`стори из вики ${p.id}: версия ${p.version} не взята - у автора нет роли`);
        continue;
      }
      if (!known?.issue) {
        const [old] = await d.tracker.listIssues({ label: mark(p.id), state: 'all', limit: 1 });
        const issue = old ?? (await d.tracker.createIssue({ title: p.title, body: body(p), labels: [d.labels.trigger, mark(p.id)] }));
        state[p.id] = { issue: issue.key, version: p.version };
        await d.wiki.comment(p.id, `Фабрика взяла стори на сверку со знаниями проекта: ${issue.key} ${issue.url}`);
        d.log(`стори из вики ${p.id} -> ${issue.key}`);
      } else {
        await d.tracker.updateIssue(known.issue, { title: p.title, body: body(p) });
        for (const l of [d.labels.ok, d.labels.conflict]) await d.tracker.removeLabel(known.issue, l);
        await d.tracker.addLabel(known.issue, d.labels.trigger);
        await d.tracker.addComment(known.issue, `Стори изменена в вики (версия ${p.version}) - сверка заново.`);
        state[p.id] = { issue: known.issue, version: p.version };
      }
    }
    // Итог сверки - на страницу, по разу на итог.
    for (const [pageId, s] of Object.entries(state)) {
      if (!s.issue) continue;
      const i = await d.tracker.getIssue(s.issue);
      const verdict = i.labels.includes(d.labels.ok) ? 'ok' : i.labels.includes(d.labels.conflict) ? 'conflict' : undefined;
      const key = verdict && `${verdict}@${s.version}`;
      if (!key || s.told === key) continue;
      const last = (await d.tracker.listComments(s.issue)).at(-1)?.body ?? '';
      const head =
        verdict === 'ok'
          ? 'Сверщик фабрики: стори согласована со знаниями проекта.'
          : 'Сверщик фабрики: стори противоречит знаниям проекта - нужно решение.';
      await d.wiki.comment(pageId, `${head}\n${last.slice(0, 1500)}\nПодробности: ${i.url}`);
      state[pageId] = { ...s, told: key };
    }
    save(state);
  }

  return {
    async tick() {
      if (busy) return;
      busy = true;
      try {
        await sync();
      } catch (e) {
        d.log(`стори из вики: ${message(e)}`);
      } finally {
        busy = false;
      }
    },
  };
}
