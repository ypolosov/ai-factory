import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { buildEvent, parseDsn, parseStack } from '../runtime/errors.ts';

const errorsTs = fileURLToPath(new URL('../runtime/errors.ts', import.meta.url));

test('DSN -> адрес store API и ключ', () => {
  assert.deepEqual(parseDsn('http://abc@glitchtip:8000/3'), {
    storeUrl: 'http://glitchtip:8000/api/3/store/',
    publicKey: 'abc',
  });
  assert.equal(parseDsn('https://k@host/prefix/7')?.storeUrl, 'https://host/prefix/api/7/store/');
});

test('плохой DSN не принимается', () => {
  assert.equal(parseDsn(''), null);
  assert.equal(parseDsn('not a url'), null);
  assert.equal(parseDsn('http://glitchtip:8000/3'), null);
  assert.equal(parseDsn('http://k@glitchtip:8000/'), null);
  assert.equal(parseDsn('http://k@glitchtip:8000/abc'), null);
});

test('стек V8 -> кадры, место ошибки последним', () => {
  const frames = parseStack(
    [
      'Error: boom',
      '    at start (file:///app/src/server.ts:10:5)',
      '    at file:///app/src/server.ts:20:1',
      '    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)',
    ].join('\n'),
  );
  assert.deepEqual(
    frames.map((f) => [f.function, f.filename, f.lineno, f.colno, f.in_app]),
    [
      ['ModuleJob.run', 'node:internal/modules/esm/module_job', 271, 25, false],
      ['?', 'file:///app/src/server.ts', 20, 1, true],
      ['start', 'file:///app/src/server.ts', 10, 5, true],
    ],
  );
});

test('событие несёт тип, текст, версию и окружение', () => {
  const event = buildEvent(new TypeError('плохо'), {
    release: 'abc123',
    now: new Date('2026-10-12T00:00:00Z'),
    eventId: 'e1',
  });
  assert.equal(event['event_id'], 'e1');
  assert.equal(event['timestamp'], '2026-10-12T00:00:00.000Z');
  assert.equal(event['release'], 'abc123');
  assert.equal(event['environment'], 'stand');
  assert.equal(event['level'], 'fatal');
  const values = (event['exception'] as { values: { type: string; value: string }[] }).values;
  assert.equal(values[0]!.type, 'TypeError');
  assert.equal(values[0]!.value, 'плохо');
});

test('не Error тоже становится событием', () => {
  const values = (buildEvent('строка')['exception'] as { values: { value: string }[] }).values;
  assert.equal(values[0]!.value, 'строка');
});

// Падение процесса -> событие в приёмнике, процесс завершается с кодом 1.
async function crash(env: Record<string, string>): Promise<{ code: number | null; requests: { url: string; auth: string; body: string }[] }> {
  const requests: { url: string; auth: string; body: string }[] = [];
  const sink = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', auth: String(req.headers['x-sentry-auth'] ?? ''), body });
      res.end('{}');
    });
  });
  sink.listen(0, '127.0.0.1');
  await once(sink, 'listening');
  const port = (sink.address() as AddressInfo).port;
  const child = spawn(process.execPath, ['--import', errorsTs, '-e', "setTimeout(() => { throw new Error('упало') }, 10)"], {
    env: { PATH: process.env['PATH'] ?? '', ...env, SENTRY_DSN: (env['SENTRY_DSN'] ?? '').replace('PORT', String(port)) },
    stdio: 'ignore',
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  sink.close();
  return { code, requests };
}

test('падение уходит в GlitchTip, процесс завершается с кодом 1', async () => {
  const { code, requests } = await crash({ SENTRY_DSN: 'http://key1@127.0.0.1:PORT/5', SENTRY_RELEASE: 'deadbeef' });
  assert.equal(code, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, '/api/5/store/');
  assert.match(requests[0]!.auth, /sentry_key=key1/);
  const event = JSON.parse(requests[0]!.body);
  assert.equal(event.release, 'deadbeef');
  assert.equal(event.exception.values[0].value, 'упало');
});

test('без DSN поведение Node не меняется', async () => {
  const { code, requests } = await crash({});
  assert.equal(code, 1);
  assert.equal(requests.length, 0);
});
