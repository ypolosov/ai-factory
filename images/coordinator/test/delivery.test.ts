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
});
