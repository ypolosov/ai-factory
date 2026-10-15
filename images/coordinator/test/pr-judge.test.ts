import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryForge, memoryJobs, memoryTracker } from '../../ports/test/memory.ts';
import { VERDICT_KEY } from '../actions.ts';
import { checkLoop } from '../checks.ts';
import { JUDGE_KEY, judgeDiff, judgeHandler, prJudge } from '../pr-judge.ts';
import { runStore } from '../runs.ts';

describe('судья PR (Codex) на раннере', () => {
  const root = mkdtempSync(join(tmpdir(), 'judge-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('голова с вердиктом стража -> задание судьи -> статус и комментарий с оценкой', async () => {
    const runs = runStore(join(root, 'runs'));
    const m = memoryForge();
    const tracker = memoryTracker('factory-bot', 'DRAW-');
    await tracker.createIssue({ title: 'Повтор розыгрыша', body: 'следующий кандидат' });
    const pr = await m.openPull();
    const head = (await m.forge.getPull(pr.n)).headSha;
    const unchecked = await m.openPull(); // без вердикта стража - судье рано
    await m.forge.setStatus(head, { key: VERDICT_KEY, state: 'success', description: '' });
    const started: string[] = [];
    const jobs = memoryJobs({ 'agent-task': async (env) => (started.push(env.RUN_TOKEN ?? ''), 'success') });
    const deps = { runs, jobs, brokerUrl: 'http://broker', pipeline: () => 'agent-task' };
    const judge = prJudge({ ...deps, forge: m.forge, tracker, log: () => {} });
    await judge.tick();
    await judge.tick(); // голова уже у судьи - второго задания нет
    expect(started).toHaveLength(1);
    expect((await m.forge.statuses(head)).find((s) => s.key === JUDGE_KEY)?.state).toBe('pending');
    expect((await m.forge.statuses((await m.forge.getPull(unchecked.n)).headSha)).some((s) => s.key === JUDGE_KEY)).toBe(false);
    const [meta] = runs.list();
    expect(meta?.kind).toBe('judge');
    expect(runs.read(meta?.runId ?? '', 'input')?.toString()).toContain('diff --git');
    runs.write(
      meta?.runId ?? '',
      'result.json',
      JSON.stringify({
        score: 72,
        security_concerns: '',
        merge_recommendation: 'approve',
        risk_level: 'low',
        key_issues: [{ file: 'a.ts', header: 'тест', content: 'добавить граничный случай' }],
      }),
    );
    await checkLoop({ runs, jobs, handlers: { judge: judgeHandler(m.forge) }, log: () => {} }).tick();
    expect((await m.forge.statuses(head)).find((s) => s.key === JUDGE_KEY)).toEqual(
      expect.objectContaining({ state: 'success', description: 'судья (Codex): 72/100, можно сливать' }),
    );
    expect((await m.forge.listPullComments(pr.n)).at(-1)?.body).toContain('a.ts: тест - добавить граничный случай');
  });

  it('большой дифф: судья видит важное, а не вошедшие файлы знает по именам', () => {
    const section = (path: string, size: number) => `diff --git a/${path} b/${path}\n+${'x'.repeat(size)}\n`;
    const diff = [
      section('.claude/skills/a/SKILL.md', 600),
      section('AGENTS.md', 50),
      section('package-lock.json', 100),
      section('openspec/config.yaml', 80),
    ].join('');
    expect(judgeDiff(diff, 10_000)).toEqual({ text: diff, omitted: [] });
    const cut = judgeDiff(diff, 300); // блокировка (153 знака) уже не влезает после двух важных (226)
    expect(cut.omitted).toEqual(['.claude/skills/a/SKILL.md', 'package-lock.json']);
    expect(cut.text).toBe(section('AGENTS.md', 50) + section('openspec/config.yaml', 80));
  });

  it('!судья N: повтор для головы, у которой уже есть итог судьи', async () => {
    const runs = runStore(join(root, 'rerun'));
    const m = memoryForge();
    const pr = await m.openPull();
    const head = (await m.forge.getPull(pr.n)).headSha;
    await m.forge.setStatus(head, { key: VERDICT_KEY, state: 'success', description: '' });
    await m.forge.setStatus(head, { key: JUDGE_KEY, state: 'failure', description: 'судья (Codex): 35/100' });
    const started: string[] = [];
    const jobs = memoryJobs({ 'agent-task': async (env) => (started.push(env.RUN_TOKEN ?? ''), 'success') });
    const judge = prJudge({
      runs,
      jobs,
      brokerUrl: 'http://broker',
      pipeline: () => 'agent-task',
      forge: m.forge,
      tracker: memoryTracker(),
      log: () => {},
    });
    await judge.tick(); // итог уже есть - сам судья не повторяет
    expect(started).toHaveLength(0);
    expect(await judge.rerun(pr.n)).toBe(
      `Судья (Codex) снова смотрит PR ${pr.n} (${head.slice(0, 7)}): итог - статусом factory/judge и комментарием в PR.`,
    );
    expect(started).toHaveLength(1);
    expect((await m.forge.statuses(head)).filter((s) => s.key === JUDGE_KEY).at(-1)?.state).toBe('pending');
  });
});
