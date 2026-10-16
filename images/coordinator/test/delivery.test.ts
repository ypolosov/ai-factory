import { describe, expect, it } from 'vitest';
import { memoryForge, memoryTracker } from '../../ports/test/memory.ts';
import { deliveryLoop } from '../delivery.ts';

describe('доставка задачи агента', () => {
  it('слито и выложено -> задача закрыта со ссылками; без выкладки и без слияния - открыта', async () => {
    const m = memoryForge();
    const tracker = memoryTracker('factory-bot', 'DRAW-');
    const done = await tracker.createIssue({ title: 'Словарь предметной области', body: '', labels: ['agent-review'] });
    const waiting = await tracker.createIssue({ title: 'Раздел README', body: '', labels: ['agent-review'] });
    const bug = await tracker.createIssue({ title: 'Сбой на стенде', body: '', labels: ['bug', 'incident', 'agent-review'] });
    const pr = await m.openPull();
    m.setHead('main', 'sha-merge', 'docs/glossary.md', `${done.key}: Словарь предметной области (#${pr.n})`);
    m.setHead('main', 'sha-fix', 'api/src/x.ts', `${bug.key}: исправление сбоя`);
    const posted: string[] = [];
    const loop = deliveryLoop({ forge: m.forge, tracker, review: 'agent-review', post: async (t) => void posted.push(t), log: () => {} });

    await loop.tick(); // слито, но ещё не выложено
    expect((await tracker.getIssue(done.key)).state).toBe('open');

    await m.forge.setStatus('sha-fix', { key: 'factory/deploy', state: 'success', description: 'выложено на стенд (main)' });
    await loop.tick();
    const closed = await tracker.getIssue(done.key);
    expect(closed.state).toBe('closed');
    expect(closed.labels).toEqual([]);
    expect((await tracker.listComments(done.key)).at(-1)?.body).toBe(
      `Сделано и выложено: ${done.key}: Словарь предметной области (#${pr.n}) (sha-mer), PR http://memory/pulls/${pr.n}; стенд - выложено на стенд (main).`,
    );
    expect(posted).toEqual([`Задача ${done.key} закрыта: Словарь предметной области - на стенде (sha-mer).`]);
    expect((await tracker.getIssue(waiting.key)).state).toBe('open');
    // Баг сбоя закрывает проход сбоев - вместе с ошибкой в сборщике.
    expect((await tracker.getIssue(bug.key)).state).toBe('open');
  });

  it('PR агента ещё открыт -> задача открыта, хотя выложен другой коммит с её ключом (спецификация)', async () => {
    const m = memoryForge();
    const tracker = memoryTracker('factory-bot', 'DRAW-');
    const t = await tracker.createIssue({ title: 'API повтора', body: '', labels: ['agent-review'] });
    const agent = await m.openPullFrom(`agent/${t.key}-abc`, `${t.key}: API повтора`);
    m.setHead('main', 'sha-spec', 'openspec/changes/x/proposal.md', `${t.key}: спецификация повтора (#7)`);
    await m.forge.setStatus('sha-spec', { key: 'factory/deploy', state: 'success', description: 'выложено на стенд (main)' });
    const loop = deliveryLoop({ forge: m.forge, tracker, review: 'agent-review', log: () => {} });

    await loop.tick();
    expect((await tracker.getIssue(t.key)).state).toBe('open');

    m.merge(agent);
    m.setHead('main', 'sha-api', 'api/src/x.ts', `${t.key}: API повтора (#${agent})`);
    await m.forge.setStatus('sha-api', { key: 'factory/deploy', state: 'success', description: 'выложено на стенд (main)' });
    await loop.tick();
    expect((await tracker.getIssue(t.key)).state).toBe('closed');
    expect((await tracker.listComments(t.key)).at(-1)?.body).toContain(`(#${agent}) (sha-api)`);
  });
});
