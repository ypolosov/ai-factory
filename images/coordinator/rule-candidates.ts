// Знание -> правила-стражи (UC7): сверщик ищет замечание, повторённое людьми в разных PR, и
// предлагает правило PR-ом в цель - строка в AGENTS.md и, если правило проверяется шаблоном,
// правило-страж в .factory/config.yml. Слияние PR архитектором - утверждение правила; дальше
// страж применяет его ко всем изменениям.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Forge } from '../ports/ports.ts';
import { VERDICT_KEY } from './actions.ts';
import type { Git } from './git.ts';

export interface Remark {
  pr: number;
  url: string;
  text: string;
}

export interface Candidate {
  id: string;
  theme: string;
  rule: string; // строка для AGENTS.md
  prs: number[];
  guard?: { message: string; paths: string[]; forbid: string };
}

export interface RuleDeps {
  forge: Forge;
  git: Git;
  workDir: () => string; // свежий каталог для клона
  ask(prompt: string): Promise<string>; // модель сверщика через шлюз
  post(text: string): Promise<void>;
}

const FACTORY = /^(Вердикт стража фабрики|Изменение агента фабрики)/;

// Замечания людей к последним PR: комментарии, кроме собственных сообщений фабрики.
export async function remarks(forge: Forge, limit = 30): Promise<Remark[]> {
  const out: Remark[] = [];
  for (const p of await forge.listPulls({ state: 'all', limit })) {
    for (const c of await forge.listPullComments(p.number)) {
      if (!FACTORY.test(c.body.trim())) out.push({ pr: p.number, url: p.url, text: c.body.trim().slice(0, 500) });
    }
  }
  return out;
}

export function rulePrompt(rs: Remark[]): string {
  return `Ты - сверщик фабрики ПО. Ниже замечания людей к разным PR. Найди одно замечание по смыслу, повторённое
минимум в трёх РАЗНЫХ PR, и предложи правило для агентов, которое предотвратит его повтор.
Если правило можно проверить шаблоном в добавленных строках кода, дай и правило-страж: регулярное выражение
JavaScript, которое находит нарушение, и префиксы путей, где оно действует.

Замечания:
${rs.map((r) => `PR ${r.pr}: ${r.text}`).join('\n')}

Ответь только JSON:
{"found": true|false, "id": "латиница-через-дефис", "theme": "о чём замечания", "rule": "правило одним предложением по-русски",
 "prs": [номера PR], "guard": {"message": "что нарушено", "paths": ["api/src/"], "forbid": "regex"} или null}`;
}

export function parseCandidate(content: string, rs: Remark[]): Candidate | undefined {
  const raw = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)) as Record<string, unknown>;
  if (!raw.found) return undefined;
  const known = new Set(rs.map((r) => r.pr));
  const prs = [...new Set(((raw.prs as unknown[]) ?? []).map(Number))].filter((n) => known.has(n));
  const id = String(raw.id ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  if (prs.length < 3 || !id || !raw.rule) return undefined;
  const g = raw.guard as Record<string, unknown> | null | undefined;
  let guard: Candidate['guard'];
  if (g?.forbid) {
    try {
      new RegExp(String(g.forbid));
      guard = { message: String(g.message ?? raw.rule), paths: ((g.paths as unknown[]) ?? ['']).map(String), forbid: String(g.forbid) };
    } catch {
      guard = undefined;
    }
  }
  return { id, theme: String(raw.theme ?? ''), rule: String(raw.rule), prs, ...(guard ? { guard } : {}) };
}

const q = (s: string) => JSON.stringify(s);

// Правило-страж - добавкой в конец .factory/config.yml (комментарии файла не теряются).
export function withRule(config: string, c: Candidate): string {
  if (!c.guard) return config;
  const block = [
    `  - id: ${c.id}`,
    `    source: ${q(`замечания к PR ${c.prs.join(', ')}`)}`,
    `    message: ${q(c.guard.message)}`,
    `    paths: [${c.guard.paths.map(q).join(', ')}]`,
    `    forbid: ${q(c.guard.forbid)}`,
  ].join('\n');
  const base = config.endsWith('\n') ? config : `${config}\n`;
  return /^rules:\s*$/m.test(base) ? `${base}${block}\n` : `${base}\nrules:\n${block}\n`;
}

export async function proposeRule(d: RuleDeps): Promise<string> {
  const rs = await remarks(d.forge);
  if (rs.length < 3) return 'Сверщик: замечаний людей к PR пока меньше трёх - повторов искать не в чем.';
  const c = parseCandidate(await d.ask(rulePrompt(rs)), rs);
  if (!c) return 'Сверщик: повторяющихся замечаний минимум в трёх PR не нашлось.';
  const branch = `factory/rule-${c.id}`;
  const existing = await d.forge.findPullByBranch(branch);
  if (existing) return `Правило-кандидат "${c.rule}" уже предложено: ${existing.url}`;
  const base = (await d.forge.repo()).defaultBranch;
  const dir = d.workDir();
  await d.git.prepare(dir, base);
  const read = (p: string) => (existsSync(join(dir, 'repo', p)) ? readFileSync(join(dir, 'repo', p), 'utf8') : '');
  const evidence = c.prs.map((n) => `#${n}`).join(', ');
  const agents = read('AGENTS.md');
  const files: Record<string, string> = {
    'AGENTS.md': `${agents.endsWith('\n') ? agents : `${agents}\n`}- ${c.rule} (правило-кандидат из замечаний к PR ${evidence}).\n`,
  };
  if (c.guard) files['.factory/config.yml'] = withRule(read('.factory/config.yml'), c);
  const { headSha } = await d.git.commitFiles(dir, { branch, message: `Правило-кандидат: ${c.rule}`, files });
  const pull = await d.forge.openPull({
    title: `Правило-кандидат: ${c.theme}`.slice(0, 200),
    body: `Сверщик фабрики нашёл повторяющееся замечание людей в PR ${evidence}: ${c.theme}.\n\nПредлагаемое правило: ${c.rule}\n${c.guard ? `Правило-страж: шаблон ${c.guard.forbid} в ${c.guard.paths.join(', ')} - нарушение даёт красный вердикт стража.\n` : ''}\nСлияние этого PR - утверждение правила (решает архитектор).`,
    head: branch,
    base,
  });
  // Свой вердикт стража - "ждёт решения": изменение настроек фабрики утверждает человек.
  await d.forge.setStatus(headSha, { key: VERDICT_KEY, state: 'pending', description: 'правило-кандидат: решает архитектор' });
  await d.post(`Сверщик предлагает правило: ${c.rule}\nПовторы в PR ${evidence}. PR: ${pull.url}`);
  return `Правило-кандидат предложено: ${pull.url}`;
}
