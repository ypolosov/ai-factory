import assert from 'node:assert/strict';
import { test } from 'vitest';
import { type Config, type Fetch, isIndexed, repoDocs, splitFile, syncRepo } from '../kbsync.ts';

const cfg: Config = {
  forgejoUrl: 'http://forgejo:3000',
  publicUrl: 'http://127.0.0.1:3000',
  kbUrl: 'http://kb:8888',
  bankId: 'factory',
  forgejoToken: 'ft',
  hindsightToken: 'ht',
  repos: ['factory-admin/todo'],
};

test('какие файлы попадают в базу', () => {
  assert.ok(isIndexed('openspec/specs/todo-list/spec.md', 1000));
  assert.ok(isIndexed('src/server.ts', 1000));
  assert.ok(isIndexed('features/todo.feature', 10));
  assert.ok(isIndexed('Dockerfile', 10));
  assert.ok(!isIndexed('package-lock.json', 10));
  assert.ok(!isIndexed('node_modules/x/index.js', 10));
  assert.ok(!isIndexed('logo.png', 10));
  assert.ok(!isIndexed('src/big.ts', 300_000));
});

test('Markdown режется по заголовкам, ссылка - на строку заголовка', () => {
  const md = [
    '# Дизайн',
    'вступление',
    '',
    '### ADR-10. Проверка Origin',
    'решение',
    '```',
    '# не заголовок',
    '```',
    '## Риски',
    'риск',
  ].join('\n');
  const s = splitFile(md, 'design.md', 'http://x/f');
  assert.deepEqual(
    s.map((x) => x.link),
    ['http://x/f#L1', 'http://x/f#L4', 'http://x/f#L9'],
  );
  assert.match(s[1]!.text, /^### ADR-10[\s\S]*# не заголовок/);
});

test('код режется кусками по 60 строк', () => {
  const code = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join('\n');
  const s = splitFile(code, 'src/a.ts', 'http://x/a');
  assert.deepEqual(
    s.map((x) => x.link),
    ['http://x/a#L1', 'http://x/a#L61', 'http://x/a#L121'],
  );
  assert.equal(splitFile('\n\n', 'a.ts', 'u').length, 0);
});

interface Fixture {
  files?: Record<string, string>;
  wiki?: { title: string; sub_url: string }[];
  issues?: Record<string, Issue[]>;
  comments?: Record<string, Comment[]>;
  existing?: string[];
  sourceFailure?: string;
  retainFailure?: boolean;
  truncatedTree?: boolean;
}

interface Issue {
  number: number;
  title: string;
  body: string;
  html_url: string;
  updated_at: string;
  state: string;
}

interface Comment {
  body: string;
  html_url: string;
  user: { login: string };
}

function fake(fixture: Fixture = {}): { fetch: Fetch; calls: { method: string; url: string; body: unknown }[] } {
  const files = fixture.files ?? { 'README.md': '# todo\n## Usage\nRun it' };
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body });
    const u = new URL(url);
    const page = Number(u.searchParams.get('page') ?? 1);
    const limit = Number(u.searchParams.get('limit') ?? 50);
    const slicePage = <T>(items: T[]): T[] => items.slice((page - 1) * limit, page * limit);

    if (u.host === 'forgejo:3000') {
      assert.equal(new Headers(init?.headers).get('authorization'), 'token ft');
      const p = u.pathname;
      if (fixture.sourceFailure && url.includes(fixture.sourceFailure)) return new Response('source failure', { status: 500 });
      if (p.endsWith('/branches/main')) return Response.json({ commit: { id: 'abc123def', timestamp: '2026-10-12T10:00:00Z' } });
      if (p.includes('/git/trees/')) {
        return Response.json({
          tree: Object.entries(files).map(([path, text]) => ({ path, type: 'blob', size: text.length })),
          truncated: fixture.truncatedTree ?? false,
        });
      }
      if (p.includes('/raw/')) return new Response(files[decodeURI(p.split('/raw/')[1]!)] ?? '');
      if (p.endsWith('/wiki/pages')) return fixture.wiki ? Response.json(slicePage(fixture.wiki)) : new Response('нет', { status: 404 });
      if (p.includes('/wiki/page/')) {
        const title = decodeURI(p.split('/wiki/page/')[1]!);
        return Response.json({
          content_base64: Buffer.from(`# ${title}\nВики`).toString('base64'),
          html_url: `http://127.0.0.1:3000/factory-admin/todo/wiki/${encodeURIComponent(title)}`,
        });
      }
      if (p.endsWith('/comments')) {
        const number = p.split('/').at(-2)!;
        return Response.json(slicePage(fixture.comments?.[number] ?? []));
      }
      if (p.endsWith('/issues')) {
        const type = u.searchParams.get('type') ?? 'issues';
        return Response.json(slicePage(fixture.issues?.[type] ?? []));
      }
      return new Response('нет', { status: 404 });
    }

    assert.equal(u.origin, 'http://kb:8888');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ht');
    assert.match(u.pathname, /^\/v1\/default\/banks\/factory\//);
    if (method === 'GET' && u.pathname.endsWith('/documents')) {
      const docs = (fixture.existing ?? []).map((id) => ({ id }));
      return Response.json({
        items: docs.slice(Number(u.searchParams.get('offset')), Number(u.searchParams.get('offset')) + 100),
        total: docs.length,
      });
    }
    if (method === 'POST' && u.pathname.endsWith('/memories') && fixture.retainFailure) {
      return new Response('retain failure', { status: 500 });
    }
    return Response.json({ ok: true });
  }) as Fetch;
  return { fetch: fn, calls };
}

function issue(number: number, type = 'issues'): Issue {
  const kind = type === 'issues' ? 'issues' : 'pulls';
  return {
    number,
    title: `Запись ${number}`,
    body: `Текст ${number}`,
    html_url: `http://127.0.0.1:3000/factory-admin/todo/${kind}/${number}`,
    updated_at: '2026-10-12T11:00:00Z',
    state: 'closed',
  };
}

test('документы: ссылки на коммит, обсуждения и стратегии Hindsight', async () => {
  const { fetch } = fake({
    files: { 'decisions/design.md': '# Дизайн\n## Решение\nСодержание', 'src/server.ts': 'код' },
    issues: { issues: [issue(25)] },
    comments: {
      '25': [
        {
          body: 'Решение человека: Origin',
          html_url: 'http://127.0.0.1:3000/factory-admin/todo/issues/25#issuecomment-1',
          user: { login: 'factory-admin' },
        },
      ],
    },
  });
  const { sha, docs } = await repoDocs(cfg, fetch, 'factory-admin/todo');
  assert.equal(sha, 'abc123def');
  assert.deepEqual(
    docs.map((d) => d.id),
    [
      'forgejo:factory-admin/todo:file:decisions/design.md',
      'forgejo:factory-admin/todo:file:src/server.ts',
      'forgejo:factory-admin/todo:issue:25',
    ],
  );
  assert.equal(docs[0]!.sections[1]!.link, 'http://127.0.0.1:3000/factory-admin/todo/src/commit/abc123def/decisions/design.md#L2');
  assert.equal(docs[0]!.metadata.commit, 'abc123def');
  assert.equal(docs[0]!.strategy, 'discussions');
  assert.equal(docs[1]!.strategy, 'documents');
  assert.equal(docs[2]!.sections[1]!.text, 'factory-admin: Решение человека: Origin');
  assert.equal(docs[2]!.strategy, 'discussions');
});

test('вики получает все страницы и сохраняет ссылки на страницу', async () => {
  const wiki = Array.from({ length: 51 }, (_, i) => ({ title: `Страница ${i + 1}`, sub_url: `page-${i + 1}` }));
  const { fetch, calls } = fake({ wiki });
  const { docs } = await repoDocs(cfg, fetch, 'factory-admin/todo');
  assert.equal(docs.filter((doc) => doc.metadata.kind === 'wiki').length, 51);
  assert.equal(docs[1]!.sections[0]!.link, 'http://127.0.0.1:3000/factory-admin/todo/wiki/page-1#L1');
  assert.ok(calls.some((call) => call.url.includes('/wiki/pages?limit=50&page=2')));
});

test('постранично собирает задачи и комментарии', async () => {
  const issues = Array.from({ length: 51 }, (_, i) => issue(i + 1));
  const comments = Array.from({ length: 51 }, (_, i) => ({
    body: `Комментарий ${i + 1}`,
    html_url: `http://127.0.0.1:3000/factory-admin/todo/issues/1#comment-${i + 1}`,
    user: { login: 'user' },
  }));
  const { fetch, calls } = fake({ issues: { issues }, comments: { '1': comments } });
  const { docs } = await repoDocs(cfg, fetch, 'factory-admin/todo');
  assert.equal(docs.filter((doc) => doc.metadata.kind === 'issue').length, 51);
  assert.equal(docs.find((doc) => doc.id.endsWith(':issue:1'))!.sections.length, 52);
  assert.ok(calls.some((call) => call.url.includes('/issues?state=all&type=issues&limit=50&page=2')));
  assert.ok(calls.some((call) => call.url.includes('/issues/1/comments?limit=50&page=2')));
});

test('удаляет устаревший документ после первой страницы Hindsight, не трогая чужие', async () => {
  const old = 'forgejo:factory-admin/todo:file:old.md';
  const existing = [...Array.from({ length: 205 }, (_, i) => `forgejo:factory-admin/other:file:${i}`), old];
  const { fetch, calls } = fake({ existing });
  assert.deepEqual(await syncRepo(cfg, fetch, 'factory-admin/todo'), { upserted: 1, deleted: 1 });
  assert.deepEqual(
    calls.filter((call) => call.method === 'DELETE').map((call) => decodeURIComponent(new URL(call.url).pathname.split('/').at(-1)!)),
    [old],
  );
});

test('сбой неполной выгрузки источника не запускает retain или prune', async () => {
  const { fetch, calls } = fake({ existing: ['forgejo:factory-admin/todo:file:old.md'], sourceFailure: '/issues?state=all&type=pulls' });
  await assert.rejects(syncRepo(cfg, fetch, 'factory-admin/todo'), /Forgejo .*HTTP 500/);
  assert.equal(
    calls.some((call) => call.method === 'POST' || call.method === 'DELETE'),
    false,
  );
});

test('неполное дерево файлов не запускает запись и удаление корпуса', async () => {
  const { fetch, calls } = fake({ existing: ['forgejo:factory-admin/todo:file:old.md'], truncatedTree: true });
  await assert.rejects(syncRepo(cfg, fetch, 'factory-admin/todo'), /tree .* is incomplete/);
  assert.equal(
    calls.some((call) => call.method === 'POST' || call.method === 'DELETE'),
    false,
  );
});

test('сбой retain не запускает prune', async () => {
  const { fetch, calls } = fake({ existing: ['forgejo:factory-admin/todo:file:old.md'], retainFailure: true });
  await assert.rejects(syncRepo(cfg, fetch, 'factory-admin/todo'), /Hindsight POST .*HTTP 500/);
  assert.equal(
    calls.some((call) => call.method === 'DELETE'),
    false,
  );
});
