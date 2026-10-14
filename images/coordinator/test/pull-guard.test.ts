import { describe, expect, it } from 'vitest';
import { memoryForge } from '../../ports/test/memory.ts';
import { VERDICT_KEY } from '../actions.ts';
import { DEFAULT_GUARD } from '../guard.ts';
import { pullGuard } from '../pull-guard.ts';

const CONFIG = 'checks:\n  lint: npm run lint\n  format: npm run format:check\n';

describe('страж всех PR цели', () => {
  it('PR человека получает вердикт один раз на голову; PR с вердиктом не трогается', async () => {
    const m = memoryForge();
    const human = await m.openPull();
    const agent = await m.openPull();
    const agentHead = (await m.forge.getPull(agent.n)).headSha;
    await m.forge.setStatus(agentHead, { key: VERDICT_KEY, state: 'success', description: 'агент' });
    const g = pullGuard({ forge: m.forge, guard: DEFAULT_GUARD, targetConfig: async () => CONFIG, log: () => {} });
    await g.tick();
    await g.tick();
    const head = (await m.forge.getPull(human.n)).headSha;
    expect(await m.forge.statuses(head)).toEqual([expect.objectContaining({ key: VERDICT_KEY, state: 'success' })]);
    expect(await m.forge.listPullComments(human.n)).toHaveLength(1);
    expect(await m.forge.listPullComments(agent.n)).toHaveLength(0);
  });

  it('без объявленных проверок цели - красный вердикт', async () => {
    const m = memoryForge();
    const pr = await m.openPull();
    await pullGuard({ forge: m.forge, guard: DEFAULT_GUARD, targetConfig: async () => undefined, log: () => {} }).tick();
    expect((await m.forge.statuses((await m.forge.getPull(pr.n)).headSha))[0]?.state).toBe('failure');
    expect((await m.forge.listPullComments(pr.n))[0]?.body).toContain('checks.lint');
  });
});
