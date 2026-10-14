// Сверка требования целиком в процессе: трекер и база знаний - в памяти, судья - поддельный:
// противоречие есть, пока в знании нет уточнения ADR-3.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { afterAll, describe, expect, it } from 'vitest';
import type { Notifier } from '../../ports/ports.ts';
import { memoryKnowledge, memoryTracker } from '../../ports/test/memory.ts';
import type { Judge } from '../judge.ts';
import type { StoryDeps } from '../story.ts';
import { storyLoop } from '../story-loop.ts';
import { storyCheckWorkflow } from '../story-workflow.ts';

describe('сверка требования со знаниями', () => {
  const root = mkdtempSync(join(tmpdir(), 'story-'));
  const labels = {
    trigger: 'story',
    checking: 'story-checking',
    ok: 'story-ok',
    conflict: 'needs-decision',
    decision: 'decision',
    failed: 'story-failed',
  };
  const docs = [
    { path: 'docs/adr/ADR-3.md', text: '# ADR-3\n\nРезультат воспроизводим из зерна; розыгрыш заново среди всех противоречит решению.' },
  ];
  const tracker = memoryTracker();
  const posts: string[] = [];
  const notifier: Notifier = { post: async (t) => void posts.push(t) };
  let refreshed = 0;
  // Поддельный судья: противоречие, пока в ADR-3 нет уточнения про следующего кандидата.
  const judge: Judge = {
    check: async (_s, passages) => {
      const adr = passages.find((p) => p.source.includes('ADR-3'));
      const conflict = adr && !adr.text.includes('следующего кандидата');
      return conflict
        ? {
            verdict: 'conflict',
            summary: 'повтор среди всех нарушает ADR-3',
            conflicts: [{ source: adr.source, url: adr.url, quote: 'противоречит решению', why: 'R4' }],
            checked: passages,
          }
        : { verdict: 'ok', summary: 'согласовано', conflicts: [], checked: passages };
    },
  };
  const deps = (): StoryDeps => ({
    tracker,
    knowledge: memoryKnowledge(docs),
    refreshKnowledge: async () => void refreshed++,
    judge,
    notifier,
    labels,
  });
  const boot = () => {
    const mastra = new Mastra({
      workflows: { storyCheck: storyCheckWorkflow(deps()) },
      storage: new LibSQLStore({ id: 'coordinator', url: `file:${join(root, 'mastra.db')}` }),
      logger: false,
    });
    return storyLoop({ workflow: mastra.getWorkflow('storyCheck'), tracker, labels, log: () => {} });
  };
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('противоречие -> задача на решение -> ожидание -> решение -> согласовано', async () => {
    const story = (
      await tracker.createIssue({ title: 'Розыгрыш заново', body: 'Разыграть невостребованный приз заново среди всех', labels: ['story'] })
    ).key;
    await boot().tick();
    expect((await tracker.getIssue(story)).labels).toEqual(['needs-decision']);
    const [task] = await tracker.listDependencies(story);
    expect(task).toBeDefined();
    const t = await tracker.getIssue(task ?? '');
    expect(t.title).toBe(`Решить противоречие: ${story} и ADR-3`);
    expect(t.labels).toEqual(['decision']);
    expect(t.body).toContain('противоречит решению');
    expect(posts.at(-1)).toContain(task);

    await boot().tick(); // задача не закрыта - стори ждёт, второй задачи нет
    expect(await tracker.listDependencies(story)).toHaveLength(1);
    expect((await tracker.getIssue(story)).labels).toEqual(['needs-decision']);

    // Архитектор уточнил ADR-3 и закрыл задачу; координатор перезапущен.
    docs[0] = { path: 'docs/adr/ADR-3.md', text: '# ADR-3\n\nПовтор берёт следующего кандидата из той же последовательности.' };
    await tracker.close(task ?? '');
    await boot().tick();
    expect((await tracker.getIssue(story)).labels).toEqual(['story-ok']);
    expect((await tracker.listComments(story)).at(-1)?.body).toContain(`Противоречие снято решением ${task}`);
    expect(refreshed).toBeGreaterThanOrEqual(2);
  });

  it('без противоречий - сразу согласовано', async () => {
    const story = (await tracker.createIssue({ title: 'Тёмная тема', body: 'Добавить тёмную тему', labels: ['story'] })).key;
    await boot().tick();
    expect((await tracker.getIssue(story)).labels).toEqual(['story-ok']);
    expect(await tracker.listDependencies(story)).toEqual([]);
  });
});
