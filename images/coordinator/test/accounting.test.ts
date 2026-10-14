import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryForge } from '../../ports/test/memory.ts';
import { account, accountText, gatewayUsage } from '../accounting.ts';
import { VERDICT_KEY } from '../actions.ts';
import { runStore } from '../runs.ts';

describe('учёт фабрики', () => {
  const root = mkdtempSync(join(tmpdir(), 'acc-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('журнал шлюза: запросы по префиксу номера запуска', () => {
    const db = new DatabaseSync(join(root, 'gw.sqlite'));
    db.exec(
      'create table request_logs (cost real, input_tokens integer, output_tokens integer, duration_ms integer, attributes_json text)',
    );
    const ins = db.prepare('insert into request_logs values (?, ?, ?, ?, ?)');
    ins.run(0.1, 1000, 100, 2000, JSON.stringify({ task_id: 'DRAW-1-a' }));
    ins.run(0.2, 2000, 200, 3000, JSON.stringify({ task_id: 'DRAW-1-a' }));
    ins.run(0.5, 1, 1, 1, JSON.stringify({ task_id: 'DRAW-10-b' }));
    db.close();
    const u = gatewayUsage(join(root, 'gw.sqlite'))('DRAW-1-');
    expect(u).toEqual({ requests: 2, cost: expect.closeTo(0.3), tokensIn: 3000, tokensOut: 300, seconds: 5 });
    expect(gatewayUsage(join(root, 'нет.sqlite'))('x').requests).toBe(0);
  });

  it('строка на задачу: попытки, время, цена, PR и вердикт', async () => {
    const runs = runStore(join(root, 'runs'));
    const m = memoryForge();
    runs.create('DRAW-1-a', 'DRAW-1');
    runs.write('DRAW-1-a', 'run.json', JSON.stringify({ seconds: 40 }));
    runs.create('DRAW-1-b', 'DRAW-1');
    runs.write('DRAW-1-b', 'run.json', JSON.stringify({ seconds: 20 }));
    m.setHead('agent/DRAW-1-b', 'sha-x');
    const pr = await m.forge.openPull({ title: 'DRAW-1: x', body: '', head: 'agent/DRAW-1-b', base: 'main' });
    await m.forge.setStatus(pr.headSha, { key: VERDICT_KEY, state: 'success', description: '' });
    const rows = await account({
      runs,
      forge: m.forge,
      usage: (p) => ({ requests: 1, cost: p.endsWith('a') ? 0.1 : 0.2, tokensIn: 1000, tokensOut: 100, seconds: 3 }),
    });
    expect(rows).toEqual([
      {
        issue: 'DRAW-1',
        attempts: 2,
        agentSeconds: 60,
        usage: { requests: 2, cost: expect.closeTo(0.3), tokensIn: 2000, tokensOut: 200, seconds: 6 },
        pull: { number: pr.number, url: pr.url, state: 'open', verdict: 'success' },
      },
    ]);
    expect(accountText(rows)).toContain('DRAW-1: попыток 2; агент 60 с');
  });
});
