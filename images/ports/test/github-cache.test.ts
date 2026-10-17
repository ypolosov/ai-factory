import { describe, expect, it } from 'vitest';
import { githubForge } from '../github.ts';
import { PortError } from '../ports.ts';

const PULL = {
  number: 7,
  title: 'PR',
  body: '',
  state: 'open',
  head: { ref: 'agent/x', sha: 'abc' },
  base: { ref: 'main' },
  user: { login: 'bot' },
  html_url: 'https://github.com/o/r/pull/7',
};

describe('адаптер GitHub: лимит запросов', () => {
  it('повторный GET - условный запрос: ответ 304 отдаёт прежние данные и не расходует лимит', async () => {
    const seen: (string | undefined)[] = [];
    const forge = githubForge({
      repo: 'o/r',
      token: 't',
      fetch: async (_url, init) => {
        const etag = (init?.headers as Record<string, string> | undefined)?.['if-none-match'];
        seen.push(etag);
        return etag === '"v1"'
          ? new Response(null, { status: 304 })
          : new Response(JSON.stringify(PULL), { status: 200, headers: { etag: '"v1"', 'content-type': 'application/json' } });
      },
    });
    expect((await forge.getPull(7)).headSha).toBe('abc');
    expect((await forge.getPull(7)).headSha).toBe('abc');
    expect(seen).toEqual([undefined, '"v1"']);
  });

  it('исчерпанный лимит - временная недоступность до сброса, а не отказ в доступе', async () => {
    const forge = githubForge({
      repo: 'o/r',
      token: 't',
      fetch: async () =>
        new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.UTC(2026, 9, 17, 13, 5) / 1000) },
        }),
    });
    const e = await forge.getPull(7).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PortError);
    expect((e as PortError).code).toBe('unavailable');
    expect((e as PortError).message).toContain('лимит запросов GitHub исчерпан до 13:05 UTC');
  });
});
