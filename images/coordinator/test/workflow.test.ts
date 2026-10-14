// Сценарий координатора целиком в процессе: трекер, хостинг и исполнитель заданий - в памяти,
// git - настоящий (цель - голый репозиторий на диске), шаг задания - поддельный агент,
// который говорит с посредником так же, как factory-job на раннере.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobRunner, Tracker } from '../../ports/ports.ts';
import { memoryForge, memoryJobs, memoryTracker } from '../../ports/test/memory.ts';
import { type Deps, VERDICT_KEY } from '../actions.ts';
import { broker } from '../broker.ts';
import { coordinator } from '../coordinator.ts';
import { git as gitPort } from '../git.ts';
import { DEFAULT_GUARD } from '../guard.ts';
import { runStore } from '../runs.ts';
import { agentTaskWorkflow } from '../workflow.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd })
    .toString()
    .trim();

// Поддельный шаг: что агент меняет в рабочей копии; exit - код агента.
type Change = { file: string; text: string; exit?: number } | 'no-result';

describe('координатор: задача -> агент -> страж -> PR', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-'));
  const origin = join(root, 'origin.git');
  const labels = { trigger: 'agent', running: 'agent-running', review: 'agent-review', failed: 'agent-failed' };
  let brokerUrl = '';
  let change: Change = { file: 'src/draw.ts', text: 'export const draw = 1;\n' };
  const tracker: Tracker = memoryTracker();
  const mf = memoryForge();
  const runs = runStore(join(root, 'runs'));

  const fakeStep = async (env: Record<string, string>) => {
    if (change === 'no-result') return 'failed' as const;
    const h = { authorization: `Bearer ${env.RUN_TOKEN}` };
    const get = async (p: string) => {
      const r = await fetch(`${env.BROKER_URL}/v1/${p}`, { headers: h });
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return r;
    };
    const vars = (await (await get('env')).json()) as Record<string, string>;
    const task = await (await get('task')).text();
    const work = mkdtempSync(join(root, 'step-'));
    writeFileSync(join(work, 'repo.bundle'), new Uint8Array(await (await get('repo')).arrayBuffer()));
    git(work, 'clone', '-q', 'repo.bundle', 'repo');
    const repo = join(work, 'repo');
    mkdirSync(dirname(join(repo, change.file)), { recursive: true });
    writeFileSync(join(repo, change.file), `// ${task.split('\n')[0]}\n${change.text}`);
    git(repo, 'add', '-A');
    const patch = execFileSync('git', ['diff', '--cached', '--binary'], { cwd: repo });
    const put = (name: string, body: string | Uint8Array) =>
      fetch(`${env.BROKER_URL}/v1/files/${name}`, { method: 'PUT', headers: h, body: body as BodyInit });
    await put('agent.patch', new Uint8Array(patch));
    await put('run.json', JSON.stringify({ task_id: vars.TASK_ID, exit_code: change.exit ?? 0 }));
    await fetch(`${env.BROKER_URL}/v1/done`, { method: 'POST', headers: h, body: JSON.stringify({ exit_code: change.exit ?? 0 }) });
    return change.exit ? ('failed' as const) : ('success' as const);
  };
  const jobs: JobRunner = memoryJobs({ 'agent-task': fakeStep });

  const deps = (): Deps => ({
    tracker,
    forge: {
      ...mf.forge,
      // Ветку отправил git координатора - хостинг в памяти о ней узнаёт здесь.
      openPull: async (p) => {
        mf.setHead(p.head, git(origin, 'rev-parse', `refs/heads/${p.head}`));
        return mf.forge.openPull(p);
      },
    },
    jobs,
    runs,
    git: gitPort({ url: origin, author: { name: 'factory-agent', email: 'agent@factory' } }),
    job: 'agent-task',
    brokerUrl,
    labels,
    guard: DEFAULT_GUARD,
  });
  // Новый экземпляр Mastra на тот же файл хранилища - как перезапуск службы.
  const boot = () => {
    const d = deps();
    const mastra = new Mastra({
      workflows: { agentTask: agentTaskWorkflow(d) },
      storage: new LibSQLStore({ id: 'coordinator', url: `file:${join(root, 'mastra.db')}` }),
      logger: false,
    });
    return coordinator({ workflow: mastra.getWorkflow('agentTask'), tracker, jobs, runs, labels, log: () => {} });
  };
  const settle = async (issue: string) => {
    for (let i = 0; i < 100; i++) {
      const s = (await tracker.getIssue(issue)).labels;
      if (s.includes(labels.review) || s.includes(labels.failed)) return s;
      await boot().tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`задача ${issue} не дошла до итога`);
  };

  const srv = broker({ runs, env: (m) => ({ TASK_ID: m.runId, CLAUDE_CODE_OAUTH_TOKEN: 'секрет' }) });
  beforeAll(async () => {
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    brokerUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    git(root, 'init', '-q', '--bare', origin);
    const seed = join(root, 'seed');
    git(root, 'init', '-q', seed);
    writeFileSync(join(seed, 'README.md'), '# Розыгрыш призов\n');
    mkdirSync(join(seed, '.factory'));
    writeFileSync(join(seed, '.factory', 'config.yml'), 'checks:\n  lint: npm run lint\n  format: npm run format:check\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'init');
    git(seed, 'push', '-q', origin, 'HEAD:refs/heads/main');
  });
  afterAll(() => {
    srv.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('задача с меткой agent доходит до PR с зелёным вердиктом, переживая перезапуск', async () => {
    const issue = (await tracker.createIssue({ title: 'Повторный розыгрыш', body: 'Разыграть невостребованный приз', labels: ['agent'] }))
      .key;
    await boot().tick(); // взял задачу и ждёт задание
    expect((await tracker.getIssue(issue)).labels).toEqual([labels.running]);
    const labelsAfter = await settle(issue);
    expect(labelsAfter).toEqual([labels.review]);
    const [pull] = await mf.forge.listPulls();
    expect(pull?.title).toBe(`${issue}: Повторный розыгрыш`);
    const head = git(origin, 'rev-parse', `refs/heads/${pull?.sourceBranch}`);
    expect(git(origin, 'show', `${head}:src/draw.ts`)).toContain('Повторный розыгрыш');
    expect(git(origin, 'log', '-1', '--format=%an', head)).toBe('factory-agent');
    expect(await mf.forge.statuses(head)).toEqual([expect.objectContaining({ key: VERDICT_KEY, state: 'success' })]);
    const comments = (await tracker.listComments(issue)).map((c) => c.body).join('\n');
    expect(comments).toContain('Агент открыл PR');
    expect(comments).not.toContain('секрет');
  });

  it('изменение настроек CI страж не публикует', async () => {
    change = { file: '.github/workflows/ci.yml', text: 'on: push\n' };
    const before = (await mf.forge.listPulls({ state: 'all' })).length;
    const issue = (await tracker.createIssue({ title: 'Поменять CI', body: '', labels: ['agent'] })).key;
    expect(await settle(issue)).toEqual([labels.failed]);
    expect((await mf.forge.listPulls({ state: 'all' })).length).toBe(before);
    expect((await tracker.listComments(issue)).at(-1)?.body).toContain('изменён защищённый путь .github/workflows/ci.yml');
  });

  it('агент упал с изменением - PR с красным вердиктом', async () => {
    change = { file: 'src/half.ts', text: 'export const half = 1;\n', exit: 1 };
    const issue = (await tracker.createIssue({ title: 'Недоделка', body: '', labels: ['agent'] })).key;
    expect(await settle(issue)).toEqual([labels.review]);
    const pull = (await mf.forge.listPulls()).find((p) => p.title.startsWith(`${issue}:`));
    expect((await mf.forge.statuses(pull?.headSha ?? ''))[0]?.state).toBe('failure');
  });

  it('задание без итога - задача помечена неудачей', async () => {
    change = 'no-result';
    const issue = (await tracker.createIssue({ title: 'Без итога', body: '', labels: ['agent'] })).key;
    expect(await settle(issue)).toEqual([labels.failed]);
    expect((await tracker.listComments(issue)).at(-1)?.body).toContain('без итога');
  });
});
