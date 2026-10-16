import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { glitchtipIncidents } from '../glitchtip.ts';

// GlitchTip 16.10.2026: PUT на список задач проекта отвечает 405, закрывает - список организации.
const resolved: string[] = [];
const srv = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && u.pathname === '/api/0/projects/factory/prize-draw/issues/') {
    res.end(JSON.stringify([{ id: 3, title: 'error: date/time', culprit: 'POST /api/draws/:id/entries', count: '2', lastSeen: 't' }]));
    return;
  }
  if (req.method === 'PUT' && u.pathname === '/api/0/organizations/factory/issues/') {
    resolved.push(u.searchParams.get('id') ?? '');
    res.end(JSON.stringify({ status: 'resolved' }));
    return;
  }
  res.statusCode = 405;
  res.end('{}');
});
let url = '';
beforeAll(async () => {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv.close());

describe('сбои GlitchTip', () => {
  it('открытые сбои проекта и их закрытие через список задач организации', async () => {
    const g = glitchtipIncidents({ url, publicUrl: 'http://127.0.0.1:8200', org: 'factory', project: 'prize-draw', token: () => 't' });
    const [i] = await g.open();
    expect(i).toMatchObject({ id: '3', count: 2, url: 'http://127.0.0.1:8200/factory/issues/3' });
    await g.resolve('3');
    expect(resolved).toEqual(['3']);
  });
});
