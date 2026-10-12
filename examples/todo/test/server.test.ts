import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/server.ts';

test('GET /health отвечает 200 и ok', async () => {
  const server = createServer().listen(0);
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  } finally {
    server.close();
  }
});
