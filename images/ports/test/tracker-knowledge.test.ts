import { describe, expect, it } from 'vitest';
import { compositeKnowledge, trackerKnowledge } from '../tracker-knowledge.ts';
import { memoryKnowledge, memoryTracker } from './memory.ts';

describe('знание из трекера и сборка носителей', () => {
  it('задачи - отрывки со ссылкой; выше - где совпало больше слов', async () => {
    const t = memoryTracker();
    await t.createIssue({ title: 'Подтверждение приза', body: 'срок подтверждения три дня' });
    const best = await t.createIssue({ title: 'Невостребованный приз', body: 'подтверждение не пришло, приз невостребованный' });
    const ps = await trackerKnowledge(t).search('невостребованный приз без подтверждения');
    expect(ps[0]?.source).toBe(best.key);
    expect(ps[0]?.url).toBe(best.url);
    expect(ps).toHaveLength(2);
  });

  it('сборка берёт отрывки по очереди от каждого носителя', async () => {
    const a = memoryKnowledge([
      { path: 'a1', text: 'розыгрыш один' },
      { path: 'a2', text: 'розыгрыш два' },
    ]);
    const b = memoryKnowledge([{ path: 'b1', text: 'розыгрыш три' }]);
    expect((await compositeKnowledge([a, b]).search('розыгрыш', 3)).map((p) => p.source)).toEqual(['a1', 'b1', 'a2']);
  });
});
