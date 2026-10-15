import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CiRun, TargetCi } from '../../ports/ports.ts';
import { memoryForge } from '../../ports/test/memory.ts';
import { ciRerun } from '../ci-rerun.ts';

describe('перезапуск CI цели', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('прогоны головы PR перезапускаются, итог новой попытки - в канал', async () => {
    const m = memoryForge();
    const pr = await m.openPull();
    const run: CiRun = { id: '7', name: 'ci', url: 'http://ci/7', state: 'success', attempt: 1 };
    const reruns: string[] = [];
    const ci: TargetCi = {
      runs: async () => [{ ...run }],
      run: async () => ({ ...run }),
      rerun: async (id) => {
        reruns.push(id);
        run.state = 'pending';
        run.attempt = 2;
      },
    };
    const posts: [string, string][] = [];
    const c = ciRerun({
      ci,
      forge: m.forge,
      post: async (ch, t) => void posts.push([ch, t]),
      stateFile: join(root, 'ci.json'),
      log: () => {},
    });
    expect(await c.request('qa', pr.n)).toContain(`Перезапустил CI PR ${pr.n}`);
    expect(reruns).toEqual(['7']);
    await c.tick();
    expect(posts).toEqual([]);
    run.state = 'failed';
    await c.tick();
    await c.tick();
    expect(posts).toEqual([['qa', `CI PR ${pr.n}, ci: красный (попытка 2). http://ci/7`]]);
  });
});
