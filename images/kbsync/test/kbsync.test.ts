import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIndexed, loop, repoDocs, splitFile, syncRepo, type Config, type Fetch } from '../kbsync.ts';

const cfg: Config = {
  forgejoUrl: 'http://forgejo:3000',
  publicUrl: 'http://127.0.0.1:3000',
  kbUrl: 'http://kb',
  forgejoToken: 'ft',
  onyxToken: 'ot',
  repos: ['factory-admin/todo'],
  ccPairId: null,
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
  const md = ['# Дизайн', 'вступление', '', '### ADR-10. Проверка Origin', 'решение', '```', '# не заголовок', '```', '## Риски', 'риск'].join('\n');
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

// Поддельные Forgejo и Onyx.
function fake(files: Record<string, string>, ingested: string[] = []): { fetch: Fetch; calls: { method: string; url: string; body: unknown }[] } {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const u = new URL(url);
    if (u.host === 'forgejo:3000') {
      assert.equal(new Headers(init?.headers).get('authorization'), 'token ft');
      const p = u.pathname;
      if (p.endsWith('/branches/main')) return Response.json({ commit: { id: 'abc123def', timestamp: '2026-10-12T10:00:00Z' } });
      if (p.includes('/git/trees/')) {
        return Response.json({ tree: Object.entries(files).map(([path, t]) => ({ path, type: 'blob', size: t.length })) });
      }
      if (p.includes('/raw/')) return new Response(files[decodeURI(p.split('/raw/')[1]!)] ?? '');
      if (p.endsWith('/issues') && u.searchParams.get('type') === 'issues') {
        return Response.json([{ number: 25, title: 'Спецификация', body: 'текст задачи', html_url: 'http://127.0.0.1:3000/factory-admin/todo/issues/25', updated_at: '2026-10-12T11:00:00Z', state: 'closed' }]);
      }
      if (p.endsWith('/issues')) return Response.json([]);
      if (p.endsWith('/comments')) return Response.json([{ body: 'Решение человека: Origin', html_url: 'http://127.0.0.1:3000/factory-admin/todo/issues/25#issuecomment-1', user: { login: 'factory-admin' } }]);
      return new Response('нет', { status: 404 });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ot');
    if (method === 'GET' && (u.pathname === '/api/onyx-api/ingestion' || u.pathname.startsWith('/api/onyx-api/connector-docs/'))) {
      return Response.json(ingested.map((document_id) => ({ document_id })));
    }
    return Response.json({ document_id: 'x', already_existed: false });
  }) as Fetch;
  return { fetch: fn, calls };
}

test('документы репозитория: файлы с кусками и ссылками на коммит, задачи с обсуждением', async () => {
  const { fetch } = fake({ 'openspec/design.md': '# Дизайн\n### ADR-10\nрешение', 'logo.png': 'x', 'src/server.ts': 'код' });
  const { sha, docs } = await repoDocs(cfg, fetch, 'factory-admin/todo');
  assert.equal(sha, 'abc123def');
  assert.deepEqual(
    docs.map((d) => d.id),
    ['forgejo:factory-admin/todo:file:openspec/design.md', 'forgejo:factory-admin/todo:file:src/server.ts', 'forgejo:factory-admin/todo:issue:25'],
  );
  const design = docs[0]!;
  assert.equal(design.semantic_identifier, 'todo: openspec/design.md');
  assert.equal(design.sections[1]!.link, 'http://127.0.0.1:3000/factory-admin/todo/src/commit/abc123def/openspec/design.md#L2');
  assert.equal(design.metadata['commit'], 'abc123def');
  const issue = docs[2]!;
  assert.equal(issue.semantic_identifier, 'todo задача #25: Спецификация');
  assert.equal(issue.sections[1]!.text, 'factory-admin: Решение человека: Origin');
});

test('проход: загрузка всего и удаление пропавшего из этого репозитория', async () => {
  const { fetch, calls } = fake({ 'README.md': '# todo' }, [
    'forgejo:factory-admin/todo:file:README.md',
    'forgejo:factory-admin/todo:file:old.md',
    'forgejo:factory-admin/hello:file:README.md',
  ]);
  const res = await syncRepo(cfg, fetch, 'factory-admin/todo');
  assert.deepEqual(res, { upserted: 2, deleted: 1 });
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal((posts[0]!.body as { document: { id: string } }).document.id, 'forgejo:factory-admin/todo:file:README.md');
  const del = calls.filter((c) => c.method === 'DELETE');
  assert.deepEqual(del.map((c) => c.url), ['http://kb/api/onyx-api/ingestion/forgejo%3Afactory-admin%2Ftodo%3Afile%3Aold.md']);
});

test('своя связка Onyx: номер в теле загрузки, список - по связке', async () => {
  const { fetch, calls } = fake({ 'README.md': '# todo' });
  await syncRepo({ ...cfg, ccPairId: 2 }, fetch, 'factory-admin/todo');
  const post = calls.find((c) => c.method === 'POST')!;
  assert.equal((post.body as { cc_pair_id: number }).cc_pair_id, 2);
  assert.ok(calls.some((c) => c.method === 'GET' && c.url === 'http://kb/api/onyx-api/connector-docs/2'));
});

test('цикл: без изменений main второй раз не загружает; сбой Onyx - в журнал', async () => {
  const { fetch, calls } = fake({ 'README.md': '# todo' });
  const log: string[] = [];
  await loop(cfg, fetch, 1, (m) => log.push(m), 2);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 2);
  assert.match(log[0]!, /factory-admin\/todo@abc123d: загружено 2, удалено 0/);
  const failing = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith('http://kb') ? new Response('нет', { status: 500 }) : fake({ 'a.md': '# a' }).fetch(input, init)) as Fetch;
  const log2: string[] = [];
  await loop(cfg, failing, 1, (m) => log2.push(m), 1);
  assert.match(log2[0]!, /сбой - Error: Onyx POST/);
});
