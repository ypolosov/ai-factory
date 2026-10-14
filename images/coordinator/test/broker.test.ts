import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { broker } from '../broker.ts';
import { type RunStore, runStore } from '../runs.ts';

describe('посредник шага', () => {
  let dir: string;
  let runs: RunStore;
  let url: string;
  const done: string[] = [];
  const server = () =>
    broker({
      runs,
      env: (m) => ({ TASK_ID: m.runId, SECRET: 's3cret' }),
      onDone: (m) => done.push(m.runId),
      maxUpload: 1024,
    });
  let srv: ReturnType<typeof server>;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'broker-'));
    runs = runStore(dir);
    srv = server();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (token: string, method: string, path: string, body?: string) =>
    fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body });

  it('без ключа запуска - 401', async () => {
    expect((await fetch(`${url}/v1/task`)).status).toBe(401);
    expect((await call('f'.repeat(64), 'GET', '/v1/task')).status).toBe(401);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });

  it('шаг получает задачу и рабочую копию, ключи - один раз', async () => {
    const { token } = runs.create('R-1', 'DRAW-1');
    runs.write('R-1', 'task.md', '# DRAW-1');
    runs.write('R-1', 'repo.bundle', Buffer.from([1, 2, 3]));
    expect(await (await call(token, 'GET', '/v1/task')).text()).toBe('# DRAW-1');
    expect(new Uint8Array(await (await call(token, 'GET', '/v1/repo')).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(await (await call(token, 'GET', '/v1/env')).json()).toEqual({ TASK_ID: 'R-1', SECRET: 's3cret' });
    expect((await call(token, 'GET', '/v1/env')).status).toBe(410);
  });

  it('итог шага сдаётся один раз, лишние и большие файлы не принимаются', async () => {
    const { token } = runs.create('R-2', 'DRAW-2');
    expect((await call(token, 'PUT', '/v1/files/agent.patch', 'diff')).status).toBe(204);
    expect((await call(token, 'PUT', '/v1/files/task.md', 'x')).status).toBe(400);
    expect((await call(token, 'PUT', '/v1/files/agent.log', 'x'.repeat(2048))).status).toBe(413);
    expect((await call(token, 'POST', '/v1/done', '{"exit_code":3}')).status).toBe(204);
    expect(done).toContain('R-2');
    expect(JSON.parse(runs.read('R-2', 'done.json')?.toString() ?? '{}').exit_code).toBe(3);
    expect(runs.read('R-2', 'agent.patch')?.toString()).toBe('diff');
    expect((await call(token, 'PUT', '/v1/files/agent.patch', 'другой')).status).toBe(409);
  });

  it('ключ запуска истекает', () => {
    const { token } = runs.create('R-3', 'DRAW-3');
    expect(runs.byToken(token)?.runId).toBe('R-3');
    expect(runs.byToken(token, new Date(Date.now() + 4 * 60 * 60 * 1000))).toBeUndefined();
  });
});
