import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KNOWLEDGE_DOCS } from '../../ports/test/contract.ts';
import { memoryJobs, memoryKnowledge, memoryTracker } from '../../ports/test/memory.ts';
import { checkLoop } from '../checks.ts';
import { designHandler, startDesign } from '../design.ts';
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
      handlers: { design: designHandler(tracker, async (_c, t) => void posts.push(t)) },
      log: () => {},
    }).tick();
    expect((await tracker.getIssue(story.key)).labels).toEqual(['design-changes']);
    expect((await tracker.listComments(story.key))[0]?.body).toContain('нужны правки, 55/100');
    expect(posts[0]).toContain('шапка: нет статуса приза (R6)');
  });
});
