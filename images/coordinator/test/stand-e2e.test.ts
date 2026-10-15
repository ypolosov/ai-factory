import { describe, expect, it } from 'vitest';
import { memoryForge } from '../../ports/test/memory.ts';
import { deployedSha, e2eHandler } from '../stand-e2e.ts';

describe('e2e на стенде', () => {
  it('коммит стенда - самый новый со статусом выкладки', async () => {
    const m = memoryForge();
    expect(await deployedSha(m.forge)).toBeUndefined();
    m.setHead('main', 'sha-a');
    m.setHead('main', 'sha-b');
    await m.forge.setStatus('sha-a', { key: 'factory/deploy', state: 'success', description: '' });
    expect(await deployedSha(m.forge)).toBe('sha-a');
    await m.forge.setStatus('sha-b', { key: 'factory/deploy', state: 'failure', description: '' });
    expect(await deployedSha(m.forge)).toBe('sha-a');
  });

  it('итог - в канал запроса, с упавшими проверками', async () => {
    const posts: [string, string][] = [];
    const h = e2eHandler(async (ch, t) => void posts.push([ch, t]));
    const job = { id: 'j', state: 'failed' as const, url: 'http://job' };
    await h(
      { runId: 'r', issue: 'e2e', tokenHash: '', createdAt: '', envServed: true, done: true, subject: 'разработка:abcdef123' },
      { passed: 2, failed: 1, skipped: 0, specs: [{ title: 'seed > R4', ok: false }] },
      job,
    );
    expect(posts[0]?.[0]).toBe('разработка');
    expect(posts[0]?.[1]).toContain('прошли 2, упали 1');
    expect(posts[0]?.[1]).toContain('- не прошла: seed > R4');
    await h({ runId: 'r', issue: 'e2e', tokenHash: '', createdAt: '', envServed: true, done: false, subject: 'qa:abc' }, undefined, job);
    expect(posts[1]?.[1]).toContain('не прошли: шаг failed');
  });
});
