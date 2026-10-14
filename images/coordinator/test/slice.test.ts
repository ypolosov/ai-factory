import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { afterAll, describe, expect, it } from 'vitest';
import { KNOWLEDGE_DOCS } from '../../ports/test/contract.ts';
import { memoryKnowledge, memoryTracker } from '../../ports/test/memory.ts';
import { parseTasks, slicer, sliceWorkflow } from '../slice.ts';

describe('нарезка стори с утверждением PM', () => {
  const root = mkdtempSync(join(tmpdir(), 'slice-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const tracker = memoryTracker('factory-bot', 'DRAW-');
  const prompts: string[] = [];
  const boot = () =>
    slicer(
      new Mastra({
        workflows: {
          slice: sliceWorkflow({
            tracker,
            knowledge: memoryKnowledge(KNOWLEDGE_DOCS),
            refreshKnowledge: async () => {},
            ask: async (p) => {
              prompts.push(p);
              return JSON.stringify({
                tasks: [
                  { title: 'API повтора', body: 'готово, когда e2e зелёный' },
                  { title: 'Экран', body: 'готово, когда виден' },
                ],
              });
            },
            agentLabel: 'agent',
          }),
        },
        storage: new LibSQLStore({ id: 'coordinator', url: `file:${join(root, 'mastra.db')}` }),
        logger: false,
      }).getWorkflow('slice'),
    );

  it('ответ модели: от двух задач', () => {
    expect(() => parseTasks('{"tasks":[{"title":"a","body":"b"}]}')).toThrow();
    expect(parseTasks('ответ {"tasks":[{"title":"a","body":"b"},{"title":"c","body":"d"},{"x":1}]}')).toHaveLength(2);
  });

  it('предложение -> утверждение (после перезапуска) -> задачи со связью и меткой агента', async () => {
    const story = await tracker.createIssue({ title: 'Повторный розыгрыш', body: 'следующий кандидат из той же последовательности' });
    const offer = await boot().propose(story.key);
    expect(offer).toContain('1. API повтора');
    expect(prompts[0]).toContain('ADR-3');
    expect(await boot().propose(story.key)).toContain('ждёт утверждения');
    const done = await boot().approve(story.key, 'pm', true);
    expect(done).toBe('Задачи заведены: DRAW-2, DRAW-3 - отданы агенту.');
    expect(await tracker.listDependencies(story.key)).toEqual(['DRAW-2', 'DRAW-3']);
    expect((await tracker.getIssue('DRAW-2')).labels).toEqual(['agent']);
    expect(await boot().approve(story.key, 'pm', false)).toContain('не ждёт утверждения');
  });
});
