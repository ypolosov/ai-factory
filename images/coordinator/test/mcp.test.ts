import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KNOWLEDGE_DOCS } from '../../ports/test/contract.ts';
import { memoryKnowledge, memoryTracker } from '../../ports/test/memory.ts';
import { DEFAULT_GUARD } from '../guard.ts';
import { mcpHttp } from '../mcp.ts';

describe('MCP фабрики', () => {
  const tracker = memoryTracker();
  const srv = mcpHttp({
    knowledge: memoryKnowledge(KNOWLEDGE_DOCS),
    refreshKnowledge: async () => {},
    judge: {
      check: async (_s, ps) => ({
        verdict: 'conflict',
        summary: 'нарушает ADR-3',
        conflicts: [{ source: ps[0]?.source ?? '', url: 'u', quote: 'q', why: 'w' }],
        checked: ps,
      }),
    },
    tracker,
    targetFile: async (p) => (p === 'AGENTS.md' ? '# Правила для агентов' : undefined),
    guard: DEFAULT_GUARD,
    agentLabel: 'agent',
    token: () => 'test-mcp-key',
  });
  let url = '';
  let client: Client;
  beforeAll(async () => {
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
    client = new Client({ name: 'test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: 'Bearer test-mcp-key' } } }),
    );
  });
  afterAll(async () => {
    await client?.close();
    srv.close();
  });

  it('без ключа - 401', async () => {
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('инструменты фабрики видны экзокортексу', async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'check_requirement',
      'factory_rules',
      'kb_search',
      'submit_task',
    ]);
  });

  it('поиск по знанию - отрывки со ссылками', async () => {
    const r = (await client.callTool({ name: 'kb_search', arguments: { query: 'повторный розыгрыш заново' } })) as {
      content: { text: string }[];
    };
    expect(r.content[0]?.text).toContain('docs/adr/ADR-3-reproducible-draw.md');
  });

  it('сверка, правила стражей и передача задачи агенту', async () => {
    const check = (await client.callTool({ name: 'check_requirement', arguments: { title: 'Розыгрыш заново среди всех' } })) as {
      content: { text: string }[];
    };
    expect(check.content[0]?.text).toContain('Противоречие: нарушает ADR-3');
    const rules = (await client.callTool({ name: 'factory_rules', arguments: {} })) as { content: { text: string }[] };
    expect(rules.content[0]?.text).toContain('checks.lint');
    expect(rules.content[0]?.text).toContain('# Правила для агентов');
    const sub = (await client.callTool({ name: 'submit_task', arguments: { title: 'Тёмная тема', body: 'нужна' } })) as {
      content: { text: string }[];
    };
    const key = /Задача (\S+)/.exec(sub.content[0]?.text ?? '')?.[1] ?? '';
    expect((await tracker.getIssue(key)).labels).toEqual(['agent']);
  });
});
