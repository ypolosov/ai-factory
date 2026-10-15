// MCP фабрики: любой экзокортекс (Claude Code, Codex, своя обвязка) получает знание проекта,
// правила стражей, сверку требования и передаёт задачу агенту фабрики. Протокол - MCP
// Streamable HTTP без сессий на /mcp; доступ - по ключу "Authorization: Bearer". Ключ называет
// учётку (инструмент mcp в реестре ролей): по ней фабрика решает, можно ли передать задачу агенту.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Knowledge, Passage, Tracker } from '../ports/ports.ts';
import type { GuardOptions } from './guard.ts';
import type { Judge } from './judge.ts';
import { type RoleRegistry, refusal } from './roles.ts';

export interface McpDeps {
  knowledge: Knowledge;
  refreshKnowledge(): Promise<void>;
  judge: Judge;
  tracker: Tracker;
  // Файл цели из ветки по умолчанию; undefined - файла нет.
  targetFile(path: string): Promise<string | undefined>;
  guard: GuardOptions;
  agentLabel: string;
  // Ключи: строки "учётка ключ"; один ключ без учётки - учётка default.
  token(): string;
  roles?(): Promise<RoleRegistry>;
}

export function mcpKeys(text: string): [key: string, account: string][] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l): [string, string] => {
      const [first = '', second] = l.split(/\s+/);
      return second ? [second, first] : [first, 'default'];
    });
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const passages = (ps: Passage[]) =>
  ps.map((p, i) => `[${i + 1}] ${p.title} (${p.source})\n${p.url}\n${p.text}`).join('\n\n') || 'ничего не найдено';

export function factoryMcp(d: McpDeps, account = 'default'): McpServer {
  const s = new McpServer({ name: 'ai-factory', version: '0.1.0' });
  s.registerTool(
    'kb_search',
    {
      title: 'Поиск по знанию проекта',
      description: 'Отрывки правил, решений (ADR) и описаний проекта со ссылками на источник в git.',
      inputSchema: { query: z.string().describe('вопрос или ключевые слова'), limit: z.number().int().min(1).max(20).optional() },
    },
    async ({ query, limit }) => {
      await d.refreshKnowledge();
      return text(passages(await d.knowledge.search(query, limit ?? 8)));
    },
  );
  s.registerTool(
    'check_requirement',
    {
      title: 'Сверка требования со знанием проекта',
      description: 'Сверщик фабрики: противоречит ли требование правилам и решениям проекта; с цитатами и ссылками.',
      inputSchema: { title: z.string(), body: z.string().optional() },
    },
    async ({ title, body }) => {
      await d.refreshKnowledge();
      const st = { issue: 'MCP', title, body: body ?? '' };
      const j = await d.judge.check(st, await d.knowledge.search(`${title}\n${body ?? ''}`, 8));
      const list = j.conflicts.map((c) => `- ${c.source}: "${c.quote}" - ${c.why}\n  ${c.url}`).join('\n');
      return text(`${j.verdict === 'ok' ? 'Противоречий нет' : 'Противоречие'}: ${j.summary}${list ? `\n${list}` : ''}`);
    },
  );
  s.registerTool(
    'factory_rules',
    {
      title: 'Правила стражей фабрики',
      description: 'Что проверит фабрика у любого изменения: правила для агентов цели, команды проверок и пределы стража.',
      inputSchema: {},
    },
    async () => {
      const agents = (await d.targetFile('AGENTS.md')) ?? '(нет AGENTS.md)';
      const config = (await d.targetFile('.factory/config.yml')) ?? '(нет .factory/config.yml - страж не пропустит изменение)';
      const g = d.guard;
      return text(
        `Страж фабрики: защищённые пути ${g.protectedPaths.join(', ')}; патч до ${g.maxBytes} байт без файлов блокировки; до ${g.maxFiles} файлов; цель обязана объявить checks.lint и checks.format.\n\n--- AGENTS.md ---\n${agents}\n\n--- .factory/config.yml ---\n${config}`,
      );
    },
  );
  s.registerTool(
    'submit_task',
    {
      title: 'Передать задачу агенту фабрики',
      description: 'Заводит задачу в трекере с меткой агента: фабрика сама отдаст её агенту и откроет PR.',
      inputSchema: { title: z.string().min(3), body: z.string() },
    },
    async ({ title, body }) => {
      const c = (await d.roles?.())?.check('submit-task', 'mcp', account);
      if (c && !c.ok) return text(refusal('submit-task', c));
      const by = c?.holder?.name ?? account;
      const i = await d.tracker.createIssue({ title, body: `${body}\n\nИз MCP: ${by}`.trim(), labels: [d.agentLabel] });
      return text(`Задача ${i.key} заведена: ${i.url}`);
    },
  );
  return s;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function mcpHttp(d: McpDeps): Server {
  return createServer(async (req, res) => {
    if (new URL(req.url ?? '/', 'http://mcp').pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const account = token ? mcpKeys(d.token()).find(([k]) => same(token, k))?.[1] : undefined;
    if (!account) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }).end('нужен ключ MCP фабрики');
      return;
    }
    const server = factoryMcp(d, account);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
}
