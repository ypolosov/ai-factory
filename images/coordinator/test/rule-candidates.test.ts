// Правило-кандидат целиком: замечания людей в трёх PR -> PR с правилом в цели (настоящий git,
// хостинг - в памяти, модель - поддельная).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryForge } from '../../ports/test/memory.ts';
import { VERDICT_KEY } from '../actions.ts';
import { git as gitPort } from '../git.ts';
import { guardPatch } from '../guard.ts';
import { parseCandidate, proposeRule, remarks, withRule } from '../rule-candidates.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd })
    .toString()
    .trim();

const ANSWER = JSON.stringify({
  found: true,
  id: 'UTC deadline',
  theme: 'срок подтверждения без часового пояса',
  rule: 'Сроки считать в UTC: new Date с локальными полями не использовать.',
  prs: [1, 2, 3],
  guard: { message: 'дата с локальными полями', paths: ['api/src/'], forbid: 'new Date\\(\\d{4}, ' },
});

describe('правило-кандидат из повторяющихся замечаний', () => {
  const root = mkdtempSync(join(tmpdir(), 'rules-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('ответ модели проверяется: минимум три известных PR, шаблон компилируется', () => {
    const rs = [1, 2, 3].map((pr) => ({ pr, url: '', text: 'x' }));
    expect(parseCandidate(ANSWER, rs)?.id).toBe('utc-deadline');
    expect(parseCandidate(ANSWER, rs.slice(0, 2))).toBeUndefined();
    expect(parseCandidate(ANSWER.replace('new Date\\\\(\\\\d{4}, ', '('), rs)?.guard).toBeUndefined();
  });

  it('правило-страж дописывается в настройки и сразу работает в страже', () => {
    const c = parseCandidate(
      ANSWER,
      [1, 2, 3].map((pr) => ({ pr, url: '', text: 'x' })),
    );
    const config = withRule('checks:\n  lint: npm run lint\n  format: npm run format:check\n', c!);
    const patch =
      'diff --git a/api/src/d.ts b/api/src/d.ts\n--- a/api/src/d.ts\n+++ b/api/src/d.ts\n@@ -0,0 +1 @@\n+const d = new Date(2026, 9, 1);\n';
    expect(guardPatch(patch, 0, undefined, config).findings[0]?.message).toContain('правило utc-deadline');
  });

  it('замечания людей в трёх PR -> PR с правилом, вердикт "ждёт решения", сообщение в канал', async () => {
    const origin = join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', origin);
    const seed = join(root, 'seed');
    git(root, 'init', '-q', seed);
    writeFileSync(join(seed, 'AGENTS.md'), '# Правила\n');
    mkdirSync(join(seed, '.factory'));
    writeFileSync(join(seed, '.factory', 'config.yml'), 'checks:\n  lint: npm run lint\n  format: npm run format:check\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'init');
    git(seed, 'push', '-q', origin, 'HEAD:refs/heads/main');

    const m = memoryForge();
    for (let i = 0; i < 3; i++) {
      const p = await m.openPull();
      await m.forge.commentPull(p.n, 'Срок подтверждения посчитан без часового пояса');
      await m.forge.commentPull(p.n, 'Вердикт стража фабрики (зелёный): - замечаний нет');
    }
    expect((await remarks(m.forge)).length).toBe(3);
    const posts: string[] = [];
    let n = 0;
    const forge = {
      ...m.forge,
      openPull: async (p: { title: string; body: string; head: string; base: string }) => {
        m.setHead(p.head, git(origin, 'rev-parse', `refs/heads/${p.head}`));
        return m.forge.openPull(p);
      },
    };
    const res = await proposeRule({
      forge,
      git: gitPort({ url: origin, author: { name: 'factory', email: 'f@f' } }),
      workDir: () => mkdtempSync(join(root, `w${++n}-`)),
      ask: async () => ANSWER,
      post: async (t) => void posts.push(t),
    });
    expect(res).toContain('Правило-кандидат предложено');
    const head = git(origin, 'rev-parse', 'refs/heads/factory/rule-utc-deadline');
    expect(git(origin, 'show', `${head}:AGENTS.md`)).toContain('Сроки считать в UTC');
    expect(git(origin, 'show', `${head}:.factory/config.yml`)).toContain('id: utc-deadline');
    expect(await m.forge.statuses(head)).toEqual([expect.objectContaining({ key: VERDICT_KEY, state: 'pending' })]);
    expect(posts[0]).toContain('Сверщик предлагает правило');
    expect(
      await proposeRule({
        forge,
        git: gitPort({ url: origin, author: { name: 'f', email: 'f@f' } }),
        workDir: () => mkdtempSync(join(root, `w${++n}-`)),
        ask: async () => ANSWER,
        post: async () => {},
      }),
    ).toContain('уже предложено');
  });
});
