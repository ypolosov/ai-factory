// База знаний поверх трекера (Jira, Forgejo): задачи и их описания как отрывки со ссылкой на
// задачу; и сборка нескольких носителей знаний в один поиск.
import type { Issue, Knowledge, Passage, Tracker } from './ports.ts';
import { stem, words } from './text.ts';

// Основы самых длинных слов вопроса с "*": трекеры ищут по словам, а не по смыслу фразы.
const queries = (q: string) =>
  [...new Set(words(q).filter((w) => w.length >= 5))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 4)
    .map((w) => `${stem(w, false)}*`);

// Запрос на слово, выше - задачи, где совпало больше слов.
// skip - задачи, которые не считаются знанием (например, служебные задачи фабрики).
export function trackerKnowledge(tracker: Tracker, skip: (i: Issue) => boolean = () => false): Knowledge {
  return {
    async search(query, limit = 8) {
      const found = await Promise.all(queries(query).map((w) => tracker.listIssues({ text: w, state: 'all', limit })));
      const hits = new Map<string, { i: Issue; n: number }>();
      for (const i of found.flat().filter((x) => !skip(x))) hits.set(i.key, { i, n: (hits.get(i.key)?.n ?? 0) + 1 });
      return [...hits.values()]
        .sort((a, b) => b.n - a.n)
        .slice(0, limit)
        .map(({ i }) => ({ source: i.key, title: i.title, text: `${i.title}\n${i.body}`.trim(), url: i.url }));
    },
  };
}

// Несколько носителей - один поиск: отрывки по очереди от каждого, до предела.
export function compositeKnowledge(parts: Knowledge[]): Knowledge {
  return {
    async search(query, limit = 8) {
      const lists = await Promise.all(parts.map((k) => k.search(query, limit)));
      const out: Passage[] = [];
      for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++) {
        for (const l of lists) {
          const p = l[i];
          if (p && out.length < limit) out.push(p);
        }
      }
      return out;
    },
  };
}
