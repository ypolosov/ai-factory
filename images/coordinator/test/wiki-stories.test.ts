import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryTracker, memoryWiki } from '../../ports/test/memory.ts';
import { parseRoles } from '../roles.ts';
import { wikiStories } from '../wiki-stories.ts';

describe('стори из вики', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const labels = { trigger: 'story', checking: 'story-checking', ok: 'story-ok', conflict: 'needs-decision', decision: 'decision' };

  it('страница с меткой -> стори в трекере; правка -> сверка заново; итог - на страницу', async () => {
    const wiki = memoryWiki();
    const tracker = memoryTracker('factory-bot', 'DRAW-');
    const loop = wikiStories({ wiki, tracker, labels, pageLabel: 'story', stateFile: join(root, 's.json'), log: () => {} });
    const page = await wiki.upsertPage('Повторный розыгрыш', 'Разыграть заново среди всех');
    await loop.tick(); // без метки - не стори
    expect(await tracker.listIssues({ state: 'all' })).toEqual([]);
    await wiki.addLabel(page.id, 'story');
    await loop.tick();
    await loop.tick();
    const [issue] = await tracker.listIssues({ state: 'all' });
    expect(issue?.labels).toEqual(['story', `wiki-${page.id}`]);
    expect(issue?.body).toContain('Источник: http://memory/wiki/');
    expect(wiki.pages.get('Повторный розыгрыш')?.comments[0]).toContain(issue?.key);

    // Сверщик нашёл противоречие - итог на странице один раз.
    await tracker.removeLabel(issue?.key ?? '', 'story');
    await tracker.addLabel(issue?.key ?? '', 'needs-decision');
    await tracker.addComment(issue?.key ?? '', 'противоречие с ADR-3');
    await loop.tick();
    await loop.tick();
    const comments = wiki.pages.get('Повторный розыгрыш')?.comments ?? [];
    expect(comments).toHaveLength(2);
    expect(comments[1]).toContain('противоречие с ADR-3');

    // Продукт поправил стори - сверка заново с новым текстом.
    await wiki.upsertPage('Повторный розыгрыш', 'Повтор берёт следующего кандидата');
    await loop.tick();
    const again = await tracker.getIssue(issue?.key ?? '');
    expect(again.body).toContain('следующего кандидата');
    expect(again.labels).toContain('story');
    expect(again.labels).not.toContain('needs-decision');
  });

  it('стори от автора без роли не берётся: отказ на странице один раз; версия продукта - берётся', async () => {
    const roles = parseRoles(`
holders:
  anna: { kind: human, name: Аня, accounts: { confluence: anna } }
  gleb: { kind: human, name: Глеб, accounts: { confluence: gleb } }
roles:
  product-owner: [anna]
  devops: [gleb]
decisions:
  story: [product-owner]
`);
    const wiki = memoryWiki('gleb');
    const tracker = memoryTracker('factory-bot', 'DRAW-');
    const loop = wikiStories({
      wiki,
      tracker,
      labels,
      pageLabel: 'story',
      stateFile: join(root, 'roles.json'),
      roles: async () => roles,
      log: () => {},
    });
    const page = await wiki.upsertPage('Тёмная тема', 'Нужна тёмная тема');
    await wiki.addLabel(page.id, 'story');
    await loop.tick();
    await loop.tick();
    expect(await tracker.listIssues({ state: 'all' })).toEqual([]);
    expect(wiki.pages.get('Тёмная тема')?.comments).toEqual([
      'Нельзя отдать стори на сверку: это решение ролей product-owner, а здесь Глеб (роли: devops). Реестр ролей - .factory/roles.yml цели.',
    ]);

    // Продукт переписал страницу - новая версия от Ани уходит на сверку.
    await wiki.upsertPage('Тёмная тема', 'Тёмная тема по настройке системы');
    const p = wiki.pages.get('Тёмная тема');
    if (p) p.author = 'anna';
    await loop.tick();
    const [issue] = await tracker.listIssues({ state: 'all' });
    expect(issue?.labels).toEqual(['story', `wiki-${page.id}`]);
    expect(issue?.body).toContain('по настройке системы');
  });
});
