// Выпуск целиком в процессе: хостинг, трекер и вики - в памяти, реестр - поддельный.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryForge, memoryTracker, memoryWiki } from '../../ports/test/memory.ts';
import { missingImages, newer, notes, type ReleaseDeps } from '../release.ts';
import { releaseLoop } from '../release-loop.ts';
import { releaseWorkflow } from '../release-workflow.ts';

describe('выпуск цели', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const tracker = memoryTracker('factory-bot', 'DRAW-');
  const m = memoryForge();
  const wiki = memoryWiki();
  const posts: string[] = [];
  const pins: (string | undefined)[] = [];
  const built = new Set<string>();
  const deps: ReleaseDeps = {
    forge: m.forge,
    tracker,
    wiki,
    registry: { exists: async (image, tag) => built.has(`${image}:${tag}`) },
    images: ['app-api', 'app-web'],
    post: async (t) => void posts.push(t),
    pin: async (t) => void pins.push(t),
  };
  const boot = () => {
    const mastra = new Mastra({
      workflows: { release: releaseWorkflow(deps) },
      storage: new LibSQLStore({ id: 'coordinator', url: `file:${join(root, 'mastra.db')}` }),
      logger: false,
    });
    return releaseLoop({
      workflow: mastra.getWorkflow('release'),
      forge: m.forge,
      seenFile: join(root, 'seen.json'),
      missing: (tag) => missingImages(deps, tag),
      post: deps.post,
      log: () => {},
    });
  };

  it('порядок версий', () => {
    expect(newer('v1.10.0', 'v1.9.3')).toBeGreaterThan(0);
    expect(newer('v1.0.0', 'v1.0.0')).toBe(0);
  });

  it('тег -> черновик -> подтверждение -> выкладка -> заметки в вики и задачи помечены', async () => {
    await m.tag('v1.0.0', 'sha-0');
    await boot().tick(); // первые теги - уже известные
    const a = await tracker.createIssue({ title: 'Словарь', body: '' });
    const b = await tracker.createIssue({ title: 'Повтор розыгрыша', body: '' });
    m.setHead('main', 'sha-a', 'docs/g.md', `${a.key}: Словарь (#1)`);
    m.setHead('main', 'sha-b', 'src/r.ts', `${b.key}: Повтор розыгрыша (#2)\n\nОписание`);
    expect((await notes(deps)).text).toContain(`${b.key}: Повтор розыгрыша (#2) http://memory/repo/pull/2`);

    await m.tag('v1.1.0', 'sha-b');
    await boot().tick();
    expect(posts.at(-1)).toContain('!выкладка v1.1.0');
    expect(posts.at(-1)).toContain('с v1.0.0');

    expect(await boot().confirm('v1.1.0', 'devops')).toContain('Образов app-api:v1.1.0, app-web:v1.1.0 ещё нет');
    expect(pins).toEqual([]);
    built.add('app-api:v1.1.0');
    built.add('app-web:v1.1.0');
    expect(await boot().confirm('v1.1.0', 'devops')).toContain('подтверждена');
    expect(pins).toEqual(['v1.1.0']);
    await m.forge.setStatus('sha-b', { key: 'factory/deploy', state: 'success', description: 'выложено на стенд (v1.1.0)' });
    await boot().tick();
    expect(wiki.pages.get('Выпуск v1.1.0')?.body).toContain(`${b.key} Повтор розыгрыша`);
    expect((await tracker.getIssue(a.key)).labels).toEqual(['release-v1.1.0']);
    expect((await tracker.listComments(b.key)).at(-1)?.body).toContain('Вошло в выпуск v1.1.0');
  });

  it('подтверждённый выпуск доходит до публикации, переживая перезапуск', async () => {
    m.setHead('main', 'sha-c', 'src/c.ts', 'Мелочь (#3)');
    await m.tag('v1.2.0', 'sha-c');
    await boot().tick();
    built.add('app-api:v1.2.0');
    built.add('app-web:v1.2.0');
    expect(await boot().confirm('v1.2.0', 'devops')).toContain('подтверждена');
    expect(pins.at(-1)).toBe('v1.2.0');
    await boot().tick(); // статуса выкладки ещё нет - ждём
    expect(wiki.pages.has('Выпуск v1.2.0')).toBe(false);
    await m.forge.setStatus('sha-c', { key: 'factory/deploy', state: 'success', description: 'выложено на стенд (v1.2.0)' });
    await boot().tick();
    const page = wiki.pages.get('Выпуск v1.2.0');
    expect(page?.body).toContain('Мелочь (#3)');
    expect(page?.body).toContain('Подтвердил: devops');
    expect(posts.at(-1)).toContain('Выпуск v1.2.0 на стенде');
  });
});
