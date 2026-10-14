import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryForge, memoryIncidents, memoryTracker } from '../../ports/test/memory.ts';
import { incidentLoop } from '../incidents.ts';

describe('сбой на стенде -> баг', () => {
  const root = mkdtempSync(join(tmpdir(), 'incidents-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const tracker = memoryTracker('factory-bot', 'DRAW-');
  const m = memoryForge();
  const inc = memoryIncidents();
  const posts: string[] = [];
  const loop = incidentLoop({
    incidents: inc.incidents,
    tracker,
    forge: m.forge,
    post: async (t) => void posts.push(t),
    stateFile: join(root, 'incidents.json'),
    log: () => {},
  });

  it('новая ошибка - один баг со ссылкой; повторы без дублей', async () => {
    inc.event('error: date/time field value out of range');
    await loop.tick();
    inc.event('error: date/time field value out of range');
    await loop.tick();
    const bugs = await tracker.listIssues({ label: 'incident', state: 'all' });
    expect(bugs).toHaveLength(1);
    expect(bugs[0]?.title).toBe('Сбой на стенде: error: date/time field value out of range');
    expect(bugs[0]?.body).toContain('http://memory/issues/1');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(bugs[0]?.key);
  });

  it('исправление с ключом бага выложено -> баг закрыт, ошибка закрыта; повтор открывает снова', async () => {
    const [bug] = await tracker.listIssues({ label: 'incident' });
    const key = bug?.key ?? '';
    m.setHead('main', 'sha-fix', 'api/src/x.ts', `${key}: проверка даты рождения (#9)`);
    await loop.tick(); // ещё не выложено
    expect((await tracker.getIssue(key)).state).toBe('open');
    await m.forge.setStatus('sha-fix', { key: 'factory/deploy', state: 'success', description: 'выложено на стенд (main)' });
    await loop.tick();
    expect((await tracker.getIssue(key)).state).toBe('closed');
    expect(await inc.incidents.open()).toEqual([]);
    expect(posts.at(-1)).toContain(`Баг ${key} закрыт`);
    inc.event('error: date/time field value out of range');
    await loop.tick();
    expect((await tracker.getIssue(key)).state).toBe('open');
    expect(posts.at(-1)).toContain('Сбой вернулся');
  });
});
