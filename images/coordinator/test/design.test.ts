import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KNOWLEDGE_DOCS } from '../../ports/test/contract.ts';
import { memoryJobs, memoryKnowledge, memoryTracker } from '../../ports/test/memory.ts';
import { checkLoop } from '../checks.ts';
import { acceptedMockups, designHandler, startDesign } from '../design.ts';
import { runStore } from '../runs.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('сверка макета', () => {
  const root = mkdtempSync(join(tmpdir(), 'design-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('макет по ссылке -> задание судьи макета -> комментарий, метка и сообщение', async () => {
    const runs = runStore(join(root, 'runs'));
    const tracker = memoryTracker('factory-bot', 'DRAW-');
    const story = await tracker.createIssue({ title: 'Экран невостребованного приза', body: 'повтор розыгрыша заново' });
    const jobs = memoryJobs({ 'agent-task': async () => 'success' });
    const d = {
      runs,
      jobs,
      brokerUrl: 'http://broker',
      pipeline: () => 'agent-task',
      tracker,
      knowledge: memoryKnowledge(KNOWLEDGE_DOCS),
      refreshKnowledge: async () => {},
      mockups: { render: async () => ({ png: PNG, source: 'https://figma.com/design/k/?node-id=1-2' }) },
    };
    expect(await startDesign({ ...d, mockups: undefined }, story.key, { channel: 'дизайн', text: '!макет' })).toContain(
      'Приложите картинку',
    );
    expect(await startDesign(d, story.key, { channel: 'дизайн', text: '!макет https://www.figma.com/design/k/x?node-id=1-2' })).toContain(
      'Сверяю макет с задачей DRAW-1',
    );
    const [meta] = runs.list();
    expect(meta?.kind).toBe('design');
    expect(runs.read(meta?.runId ?? '', 'task.md')?.toString()).toContain('ADR-3');
    runs.write(
      meta?.runId ?? '',
      'result.json',
      JSON.stringify({
        matches: false,
        score: 55,
        summary: 'нет кнопки повтора',
        remarks: [{ area: 'шапка', issue: 'нет статуса приза', requirement: 'R6' }],
      }),
    );
    const posts: string[] = [];
    await checkLoop({
      runs,
      jobs,
      handlers: {
        design: designHandler(tracker, async (_c, t) => void posts.push(t), { runs, mockups: acceptedMockups(join(root, 'mockups')) }),
      },
      log: () => {},
    }).tick();
    expect((await tracker.getIssue(story.key)).labels).toEqual(['design-changes']);
    expect((await tracker.listComments(story.key))[0]?.body).toContain('нужны правки, 55/100');
    expect(posts[0]).toContain('шапка: нет статуса приза (R6)');
  });

  it('принятый макет хранится только при design-ok: design-changes его не трогает, новый design-ok заменяет прошлый', async () => {
    const runs = runStore(join(root, 'runs-accepted'));
    const mockups = acceptedMockups(join(root, 'accepted'));
    const tracker = memoryTracker('factory-bot', 'DRAW-');
    const story = await tracker.createIssue({ title: 'Экран приза', body: 'статус приза в шапке' });
    const jobs = memoryJobs({ 'agent-task': async () => 'success' });
    let png: Uint8Array = PNG;
    const d = {
      runs,
      jobs,
      brokerUrl: 'http://broker',
      pipeline: () => 'agent-task',
      tracker,
      knowledge: memoryKnowledge(KNOWLEDGE_DOCS),
      refreshKnowledge: async () => {},
      mockups: { render: async () => ({ png, source: 'https://figma.com/design/k/?node-id=1-2' }) },
    };
    const loop = checkLoop({ runs, jobs, handlers: { design: designHandler(tracker, async () => {}, { runs, mockups }) }, log: () => {} });
    // Сверка картинки: судья отвечает matches, итог разбирает проход проверок.
    const check = async (bytes: Uint8Array, matches: boolean) => {
      png = bytes;
      await new Promise((r) => setTimeout(r, 5)); // свой номер запуска у каждой сверки
      await startDesign(d, story.key, { channel: 'дизайн', text: '!макет https://www.figma.com/design/k/x?node-id=1-2' });
      const meta = runs.list().at(-1);
      runs.write(meta?.runId ?? '', 'result.json', JSON.stringify({ matches, score: matches ? 90 : 40, summary: '', remarks: [] }));
      await loop.tick();
    };
    const v = (n: number) => new Uint8Array([...PNG, n]);
    await check(v(1), false);
    expect(mockups.read(story.key)).toBeUndefined();
    await check(v(2), true);
    expect(new Uint8Array(mockups.read(story.key) ?? [])).toEqual(v(2));
    await check(v(3), false);
    expect(new Uint8Array(mockups.read(story.key) ?? [])).toEqual(v(2));
    await check(v(4), true);
    expect(new Uint8Array(mockups.read(story.key) ?? [])).toEqual(v(4));
    expect((await tracker.getIssue(story.key)).labels).toEqual(expect.arrayContaining(['design-ok', 'design-changes']));
  });
});
