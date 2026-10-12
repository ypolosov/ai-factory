import { After, Before, Then, When, World, setWorldConstructor } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../src/server.ts';

// Мир сценария: свой сервер на свободном порту и последний ответ.
export class AppWorld extends World {
  server: Server | undefined;
  baseUrl = '';
  status = 0;
  body = '';
}
setWorldConstructor(AppWorld);

Before(async function (this: AppWorld) {
  this.server = createServer().listen(0);
  await once(this.server, 'listening');
  const { port } = this.server.address() as AddressInfo;
  this.baseUrl = `http://127.0.0.1:${port}`;
});

After(function (this: AppWorld) {
  this.server?.close();
});

When('клиент отправляет GET {string}', async function (this: AppWorld, path: string) {
  const res = await fetch(this.baseUrl + path, { redirect: 'manual' });
  this.status = res.status;
  this.body = await res.text();
});

Then('ответ - {int} с телом {string}', function (this: AppWorld, status: number, body: string) {
  assert.equal(this.status, status);
  assert.equal(this.body, body);
});
