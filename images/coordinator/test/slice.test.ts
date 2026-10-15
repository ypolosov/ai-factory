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
                  {
                    title: 'API повтора',
                    goal: 'Повтор берёт следующего кандидата из той же последовательности',
                    scenarios: [
                      { name: 'следующий кандидат', when: 'приз не подтверждён за 3 дня', result: 'выигрывает следующий кандидат' },
                    ],
                    basis: ['ADR-3'],
                  },
                  {
                    title: 'Экран невостребованного приза',
                    goal: 'Организатор видит невостребованный приз и запускает повтор',
                    scenarios: [{ name: 'виден', when: 'организатор открывает розыгрыш', result: 'видит невостребованный приз' }],
                  },
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

  it('ответ модели: от двух задач по схеме; задача без сценариев приёмки не берётся', () => {
    const t = (title: string) => ({ title, goal: 'g', scenarios: [{ name: 'n', when: 'w', result: 't' }] });
    expect(() => parseTasks(JSON.stringify({ tasks: [t('a')] }))).toThrow();
    expect(() => parseTasks('{"tasks":[{"title":"a","body":"b"},{"title":"c","body":"d"}]}')).toThrow();
    const ok = parseTasks(`ответ ${JSON.stringify({ tasks: [t('a'), t('b'), { ...t('c'), scenarios: [] }, { x: 1 }] })}`);
    expect(ok.map((x) => x.title)).toEqual(['a', 'b']);
    expect(ok[0]?.outOfScope).toEqual([]);
  });

  it('предложение -> утверждение (после перезапуска) -> задачи со связью и меткой агента', async () => {
    const story = await tracker.createIssue({ title: 'Повторный розыгрыш', body: 'следующий кандидат из той же последовательности' });
    const offer = await boot().propose(story.key);
    expect(offer).toContain('1. API повтора - Повтор берёт следующего кандидата из той же последовательности (сценариев приёмки: 1)');
    expect(prompts[0]).toContain('ADR-3');
    expect(await boot().propose(story.key)).toContain('ждёт утверждения');
    const done = await boot().approve(story.key, 'pm', true);
    expect(done).toBe('Задачи заведены: DRAW-2, DRAW-3 - отданы агенту.');
    expect(await tracker.listDependencies(story.key)).toEqual(['DRAW-2', 'DRAW-3']);
    expect((await tracker.getIssue('DRAW-2')).labels).toEqual(['agent']);
    expect((await tracker.getIssue('DRAW-2')).body).toBe(
      [
        'Цель',
        'Повтор берёт следующего кандидата из той же последовательности',
        '',
        'Сценарии приёмки',
        'Сценарий: следующий кандидат',
        '  Когда приз не подтверждён за 3 дня',
        '  Тогда выигрывает следующий кандидат',
        '',
        'Вне рамок',
        '- нет',
        '',
        'Основания',
        '- ADR-3',
        '',
        'Откуда',
        `Из стори ${story.key}; нарезку утвердил pm.`,
      ].join('\n'),
    );
    expect(await boot().approve(story.key, 'pm', false)).toContain('не ждёт утверждения');
  });
});
