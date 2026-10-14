import { test } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  createServer,
  formatStack,
  issueBody,
  issueIdFromLink,
  parseAlerts,
  report,
  type Alert,
  type Config,
  type Fetch,
} from '../errbridge.ts';

// Тело вебхука GlitchTip 6 (apps/alerts/webhooks.py, send_issue_as_webhook).
const payload = {
  text: 'GlitchTip Alert',
  attachments: [
    {
      mrkdown_in: ['text'],
      title: 'Error: упало при старте',
      title_link: 'http://127.0.0.1:8200/factory/issues/42',
      text: 'file:///app/src/server.ts',
      color: '#e52b50',
      fields: [
        { title: 'Project', value: 'todo', short: true },
        { title: 'Environment', value: 'stand', short: true },
        { title: 'Release', value: 'abc123def456', short: false },
      ],
    },
  ],
};

const cfg: Config = {
  forgejoUrl: 'http://forgejo',
  forgejoToken: 'ft',
  opsUser: 'factory-ops',
  glitchtipUrl: 'http://glitchtip',
  glitchtipToken: 'gt',
  hookToken: 'hook-secret',
  repos: new Set(['factory-admin/todo']),
};

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string;
}

// Поддельные Forgejo и GlitchTip: открытые задачи и последнее событие задаются в тесте.
function fakeFetch(open: { number: number; body: string }[], event: unknown = null): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.get('authorization') ?? '' });
    if (url.startsWith('http://glitchtip/')) {
      return event ? Response.json(event) : new Response('no', { status: 404 });
    }
    if (method === 'GET') return Response.json(open);
    return Response.json({ number: 99 }, { status: 201 });
  }) as Fetch;
  return { fetch: fn, calls };
}

const alert: Alert = parseAlerts(payload)[0]!;

test('вебхук GlitchTip -> оповещение', () => {
  assert.deepEqual(alert, {
    title: 'Error: упало при старте',
    link: 'http://127.0.0.1:8200/factory/issues/42',
    culprit: 'file:///app/src/server.ts',
    project: 'todo',
    release: 'abc123def456',
    environment: 'stand',
  });
});

test('мусор во вебхуке не даёт оповещений', () => {
  assert.deepEqual(parseAlerts(null), []);
  assert.deepEqual(parseAlerts({ attachments: 'x' }), []);
  assert.deepEqual(parseAlerts({ attachments: [null, 1, { title: 'без ссылки' }] }), []);
  assert.deepEqual(parseAlerts({ attachments: [{ title: 'x', title_link: 'javascript:alert(1)' }] }), []);
});

test('номер ошибки GlitchTip - из ссылки', () => {
  assert.equal(issueIdFromLink('http://h/factory/issues/42'), 42);
  assert.equal(issueIdFromLink('http://h/factory/issues/42/'), 42);
  assert.equal(issueIdFromLink('http://h/factory/'), null);
});

test('стек события - место ошибки первым, обратные кавычки убраны', () => {
  const stack = formatStack({
    entries: [
      { type: 'breadcrumbs', data: {} },
      {
        type: 'exception',
        data: {
          values: [
            {
              type: 'Error',
              value: 'упало `x`',
              stacktrace: {
                frames: [
                  { function: 'main', filename: 'file:///app/src/server.ts', lineNo: 20, colNo: 1 },
                  { function: 'start', filename: 'file:///app/src/server.ts', lineno: 10, colno: 5 },
                ],
              },
            },
          ],
        },
      },
    ],
  });
  assert.equal(
    stack,
    [
      "Error: упало 'x'",
      '    at start (file:///app/src/server.ts:10:5)',
      '    at main (file:///app/src/server.ts:20:1)',
    ].join('\n'),
  );
  assert.equal(formatStack({}), '');
});

test('новая ошибка - новая задача со ссылкой, версией и стеком', async () => {
  const event = { entries: [{ type: 'exception', data: { values: [{ type: 'Error', value: 'упало при старте' }] } }] };
  const { fetch, calls } = fakeFetch([{ number: 5, body: 'другая задача' }], event);
  assert.equal(await report(cfg, fetch, 'factory-admin/todo', alert), 'created');
  const list = calls[0]!;
  assert.equal(list.method, 'GET');
  assert.match(list.url, /\/repos\/factory-admin\/todo\/issues\?state=open&type=issues&created_by=factory-ops/);
  assert.equal(list.auth, 'token ft');
  assert.equal(calls[1]!.url, 'http://glitchtip/api/0/issues/42/events/latest/');
  assert.equal(calls[1]!.auth, 'Bearer gt');
  const create = calls[2]!;
  assert.equal(create.method, 'POST');
  assert.equal(create.url, 'http://forgejo/api/v1/repos/factory-admin/todo/issues');
  const body = create.body as { title: string; body: string };
  assert.equal(body.title, 'Ошибка на стенде: Error: упало при старте');
  assert.ok(body.body.includes('](http://127.0.0.1:8200/factory/issues/42)'));
  assert.ok(body.body.includes('версия (коммит): abc123def456'));
  assert.ok(body.body.includes('Error: упало при старте\n```'));
});

test('повтор той же ошибки - комментарий в открытой задаче', async () => {
  const { fetch, calls } = fakeFetch([{ number: 7, body: issueBody(alert, '') }]);
  assert.equal(await report(cfg, fetch, 'factory-admin/todo', alert), 'commented');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.url, 'http://forgejo/api/v1/repos/factory-admin/todo/issues/7/comments');
  assert.match((calls[1]!.body as { body: string }).body, /повторилась.*abc123def456/);
});

test('нет события в GlitchTip - задача без стека', async () => {
  const { fetch, calls } = fakeFetch([]);
  assert.equal(await report(cfg, fetch, 'factory-admin/todo', alert), 'created');
  assert.ok(!(calls[2]!.body as { body: string }).body.includes('```'));
});

async function serve(fetchFn: Fetch): Promise<{ base: string; close: () => void }> {
  const server = createServer(cfg, fetchFn, () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

function post(url: string, body: string): Promise<Response> {
  return fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
}

test('служба: вебхук с верным токеном заводит задачу', async () => {
  const { fetch: fake, calls } = fakeFetch([]);
  const { base, close } = await serve(fake);
  try {
    const res = await post(`${base}/glitchtip?repo=factory-admin/todo&token=hook-secret`, JSON.stringify(payload));
    assert.equal(res.status, 200);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  } finally {
    close();
  }
});

test('служба: чужой токен, чужой репозиторий, плохое тело - отказ без задач', async () => {
  const { fetch: fake, calls } = fakeFetch([]);
  const { base, close } = await serve(fake);
  try {
    const body = JSON.stringify(payload);
    assert.equal((await post(`${base}/glitchtip?repo=factory-admin/todo&token=wrong`, body)).status, 403);
    assert.equal((await post(`${base}/glitchtip?repo=factory-admin/todo`, body)).status, 403);
    assert.equal((await post(`${base}/glitchtip?repo=other/repo&token=hook-secret`, body)).status, 403);
    assert.equal((await post(`${base}/glitchtip?repo=factory-admin/todo&token=hook-secret`, '{')).status, 400);
    assert.equal((await fetch(`${base}/glitchtip`)).status, 404);
    assert.equal(await (await fetch(`${base}/health`)).text(), 'ok');
    assert.equal(calls.length, 0);
  } finally {
    close();
  }
});

test('служба: сбой Forgejo - 502', async () => {
  const failing = (async () => new Response('down', { status: 500 })) as Fetch;
  const { base, close } = await serve(failing);
  try {
    const res = await post(`${base}/glitchtip?repo=factory-admin/todo&token=hook-secret`, JSON.stringify(payload));
    assert.equal(res.status, 502);
  } finally {
    close();
  }
});
