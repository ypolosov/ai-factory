// Адаптер базы знаний на документах в git: README.md, AGENTS.md и docs/**/*.md рабочей копии
// репозитория. Отрывок - раздел под заголовком; ссылка - на файл в коммите и якорь раздела.
// Поиск - по совпадению основ слов (text.ts); носитель для малого корпуса правил и
// решений, пока нет ядра базы знаний.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Knowledge, Passage } from './ports.ts';
import { stems } from './text.ts';

export interface GitDocsConfig {
  dir: string; // рабочая копия
  web: string; // https://github.com/<владелец>/<имя>
  ref(): string | Promise<string>; // коммит для ссылок
}

// Якорь заголовка, как его строит GitHub.
export const anchor = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');

function markdownFiles(dir: string): string[] {
  const out = ['README.md', 'AGENTS.md'].filter((f) => existsSync(join(dir, f)));
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.md')) out.push(relative(dir, p));
    }
  };
  walk(join(dir, 'docs'));
  return out;
}

export function sections(path: string, text: string): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  let cur: { title: string; lines: string[] } | undefined;
  for (const line of text.split('\n')) {
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    if (h?.[1]) {
      if (cur) out.push({ title: cur.title, text: cur.lines.join('\n').trim() });
      cur = { title: h[1].trim(), lines: [line] };
    } else {
      cur ??= { title: path, lines: [] };
      cur.lines.push(line);
    }
  }
  if (cur) out.push({ title: cur.title, text: cur.lines.join('\n').trim() });
  return out.filter((s) => s.text);
}

export function gitDocsKnowledge(cfg: GitDocsConfig): Knowledge {
  return {
    async search(query, limit = 8) {
      const ref = await cfg.ref();
      const q = stems(query);
      const scored: { p: Passage; score: number }[] = [];
      for (const path of markdownFiles(cfg.dir)) {
        for (const s of sections(path, readFileSync(join(cfg.dir, path), 'utf8'))) {
          const body = stems(s.text);
          const title = stems(s.title);
          let score = 0;
          for (const w of q) score += (body.has(w) ? 1 : 0) + (title.has(w) ? 1 : 0);
          if (score === 0) continue;
          const url = `${cfg.web.replace(/\/$/, '')}/blob/${ref}/${path}${s.title === path ? '' : `#${anchor(s.title)}`}`;
          scored.push({ p: { source: path, title: s.title, text: s.text, url }, score });
        }
      }
      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.p);
    },
  };
}
