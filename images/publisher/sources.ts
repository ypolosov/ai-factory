// Источник для руководств: факты о фабрике из её же файлов - справка бота, инструменты MCP,
// точки решения ролей, сценарий по ролям, описания элементов модели. Каждый факт - с
// идентификатором: писатель ссылается на него, судья сверяет с ним текст. Файлы читаются как
// данные (публикатор не зависит от кода координатора): сменился их вид - тест на настоящих
// файлах падает.

export interface SourceItem {
  id: string; // cmd:дейли, tool:kb_search, decision:deploy, step:4, prep:3, el:factory.coord
  text: string;
}

export interface Command {
  id: string;
  usage: string; // как набрать: "!ci [номер PR]"
  what: string;
}

export interface Tool {
  id: string;
  name: string;
  title: string;
  description: string;
}

export interface Step {
  id: string;
  n: string;
  role: string; // роль без инструмента: "Product Owner"
  where: string; // инструмент: "Discord #продукт"
  action: string;
  result: string;
}

export interface SourcePack {
  version: string;
  commands: Command[];
  tools: Tool[];
  decisions: SourceItem[];
  prep: SourceItem[];
  steps: Step[];
  elements: SourceItem[];
}

// Справка бота: строки "!команда ... - что делает" в шаблоне HELP; первая строка - о боте.
export function parseHelp(botTs: string): { about: SourceItem; commands: Command[] } {
  const help = /export const HELP = `([\s\S]*?)`;/.exec(botTs)?.[1];
  if (!help) throw new Error('bot.ts: нет справки HELP');
  const [about = '', ...lines] = help.split('\n');
  const commands = lines.flatMap((l) => {
    const m = /^(!\S+.*?) - (.+)$/.exec(l.trim());
    if (!m) return [];
    const usage = m[1] ?? '';
    return [{ id: `cmd:${usage.slice(1).split(/[\s;]/)[0]}`, usage, what: m[2] ?? '' }];
  });
  if (!commands.length) throw new Error('bot.ts: в справке нет команд');
  return { about: { id: 'bot:about', text: about.trim() }, commands };
}

// Инструменты MCP: registerTool('имя', { title: '...', description: '...' }).
export function parseTools(mcpTs: string): Tool[] {
  const tools = [...mcpTs.matchAll(/registerTool\(\s*'([^']+)',\s*\{\s*title:\s*'([^']*)',\s*description:\s*'([^']*)'/g)].map((m) => ({
    id: `tool:${m[1]}`,
    name: m[1] ?? '',
    title: m[2] ?? '',
    description: m[3] ?? '',
  }));
  if (!tools.length) throw new Error('mcp.ts: нет инструментов');
  return tools;
}

// Точки решения ролей: DECISIONS = { deploy: 'подтвердить выкладку', 'approve-slice': '...' }
// - ключ с кавычками или без.
export function parseDecisions(rolesTs: string): SourceItem[] {
  const body = /export const DECISIONS = \{([\s\S]*?)\n\}/.exec(rolesTs)?.[1];
  if (!body) throw new Error('roles.ts: нет DECISIONS');
  return [...body.matchAll(/^\s*(?:'([a-z-]+)'|([a-z][a-z-]*)):\s*'([^']*)'/gm)].map((m) => {
    const key = m[1] ?? m[2];
    return { id: `decision:${key}`, text: `${key} - ${m[3]}` };
  });
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

// Сценарий по ролям: нумерованная подготовка и таблица "# | Роль, инструмент | Действие | Итог".
export function parseScenario(md: string): { prep: SourceItem[]; steps: Step[] } {
  const prepBlock = /## Подготовка\n([\s\S]*?)\n## /.exec(md)?.[1] ?? '';
  const prep = [...prepBlock.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => ({ id: `prep:${m[1]}`, text: m[2] ?? '' }));
  const steps = md
    .split('\n')
    .filter((l) => /^\|\s*\d+[a-z]?\s*\|/.test(l))
    .map((l) => {
      const [n = '', who = '', action = '', result = ''] = cells(l);
      const [role = '', ...where] = who.split(',');
      return { id: `step:${n}`, n, role: role.trim(), where: where.join(',').trim(), action, result };
    });
  if (!steps.length) throw new Error('scenario.md: нет таблицы шагов');
  return { prep, steps };
}

// Текст факта для писателя и судьи.
export function items(p: SourcePack): SourceItem[] {
  return [
    ...p.commands.map((c) => ({ id: c.id, text: `${c.usage} - ${c.what}` })),
    ...p.tools.map((t) => ({ id: t.id, text: `${t.name} (${t.title}): ${t.description}` })),
    ...p.decisions,
    ...p.prep,
    ...p.steps.map((s) => ({ id: s.id, text: `${s.role}${s.where ? `, ${s.where}` : ''}: ${s.action} -> ${s.result}` })),
    ...p.elements,
  ];
}
