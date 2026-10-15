// Действия координатора над портами: взять задачу, отдать её агенту на исполнителе заданий,
// проверить итог стражем и опубликовать PR. Движок сценария (Mastra) только связывает их
// в шаги и хранит состояние между ними - его замена не трогает этот код.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Forge, JobRunner, JobState, Tracker } from '../ports/ports.ts';
import type { Git } from './git.ts';
import { type GuardOptions, guardPatch, roleAllowed, type Verdict } from './guard.ts';
import type { RunStore } from './runs.ts';

export interface Labels {
  trigger: string; // задача ждёт агента (роль dev - весь репозиторий)
  // Метки ролей агента: метка -> роль (промпт роли в образе агента, пути роли - в .factory/config.yml цели).
  roles?: Record<string, string>;
  running: string; // агент работает
  review: string; // PR открыт, решает человек
  failed: string; // агент или страж не дали результата
}

export interface Deps {
  tracker: Tracker;
  forge: Forge;
  jobs: JobRunner;
  runs: RunStore;
  git: Git;
  job: string; // имя задания агента у исполнителя
  brokerUrl: string; // адрес посредника для шага
  labels: Labels;
  guard: GuardOptions;
  // Исполнитель задачи агента роли: учётка трекера ИИ-персонажа роли (реестр ролей цели).
  assignee?(role: string): Promise<string | undefined>;
}

export interface Task {
  issue: string;
  title: string;
  body: string;
  role?: string; // роль агента: dev, frontend, backend
}

export interface Dispatched {
  issue: string;
  title: string;
  jobId: string;
  jobUrl: string;
}

export interface Outcome {
  result: 'pull' | 'blocked' | 'failed';
  detail: string;
  url?: string;
}

export const VERDICT_KEY = 'factory/verdict';

const relabel = async (d: Deps, issue: string, from: string[], to: string) => {
  for (const l of from) await d.tracker.removeLabel(issue, l);
  await d.tracker.addLabel(issue, to);
};

export async function claim(d: Deps, issue: string, label = d.labels.trigger, role = 'dev'): Promise<Task> {
  const i = await d.tracker.getIssue(issue);
  await relabel(d, issue, [label], d.labels.running);
  const who = await d.assignee?.(role).catch(() => undefined);
  if (who)
    await d.tracker.assign(issue, who).catch((e) => d.tracker.addComment(issue, `Исполнителя назначить не вышло: ${(e as Error).message}`));
  return { issue, title: i.title, body: i.body, role };
}

// Спецификация задачи - изменение OpenSpec, утверждённое слиянием PR в базу: каталог
// openspec/changes/<ключ в нижнем регистре>[-<имя>]/. Артефакты - в постоянном порядке, до 30 КБ.
const ARTIFACTS = ['proposal.md', 'design.md', 'tasks.md', 'test-plan.md'];
export function openspecChange(repo: string, issue: string): { path: string; text: string } | undefined {
  const changes = join(repo, 'openspec', 'changes');
  const key = issue.toLowerCase();
  // Изменений у задачи может оказаться несколько - агент получает все, по порядку имён.
  const names = existsSync(changes)
    ? readdirSync(changes)
        .filter((n) => n === key || n.startsWith(`${key}-`))
        .sort()
    : [];
  if (!names.length) return undefined;
  const walk = (p: string): string[] =>
    statSync(p).isDirectory()
      ? readdirSync(p)
          .sort()
          .flatMap((n) => walk(join(p, n)))
      : [p];
  const text = names
    .flatMap((name) => {
      const dir = join(changes, name);
      const files = [
        ...ARTIFACTS.map((f) => join(dir, f)).filter((f) => existsSync(f)),
        ...(existsSync(join(dir, 'specs')) ? walk(join(dir, 'specs')).filter((f) => f.endsWith('.md')) : []),
      ];
      return files.map((f) => `### ${names.length > 1 ? `${name}/` : ''}${relative(dir, f)}\n\n${readFileSync(f, 'utf8').trim()}`);
    })
    .join('\n\n');
  return { path: names.map((n) => `openspec/changes/${n}`).join(', '), text: text.slice(0, 30_000) };
}

export async function dispatch(d: Deps, runId: string, t: Task): Promise<Dispatched> {
  const { token } = d.runs.create(runId, t.issue);
  const baseBranch = (await d.forge.repo()).defaultBranch;
  const { baseSha } = await d.git.prepare(d.runs.dir(runId), baseBranch);
  const spec = openspecChange(join(d.runs.dir(runId), 'repo'), t.issue);
  d.runs.write(
    runId,
    'task.md',
    `# ${t.issue}: ${t.title}\n\n${t.body}\n${spec ? `\n## Спецификация: изменение OpenSpec ${spec.path} (утверждено слиянием)\n\nТесты - по сценариям требований и до кода; каталог openspec/ не меняй.\n\n${spec.text}\n` : ''}`,
  );
  const job = await d.jobs.start({ job: d.job, variables: { BROKER_URL: d.brokerUrl }, secrets: { RUN_TOKEN: token } });
  d.runs.update(runId, {
    baseBranch,
    baseSha,
    jobId: job.id,
    jobUrl: job.url,
    role: t.role ?? 'dev',
    ...(spec ? { spec: spec.path } : {}),
  });
  await d.tracker.addComment(t.issue, `Фабрика взяла задачу: запуск ${runId}, задание агента ${job.url}`);
  return { issue: t.issue, title: t.title, jobId: job.id, jobUrl: job.url };
}

const LEVEL = { block: 'стоп', fail: 'замечание', info: 'сведение' } as const;
const verdictText = (v: Verdict) =>
  v.findings.length ? v.findings.map((f) => `- ${LEVEL[f.level]}: ${f.message}`).join('\n') : '- замечаний нет';
const remarks = (v: Verdict) => v.findings.filter((f) => f.level !== 'info').length;

export async function finish(d: Deps, runId: string, t: Dispatched, jobState: JobState): Promise<Outcome> {
  const meta = d.runs.meta(runId);
  if (!meta?.baseBranch) throw new Error(`нет данных запуска ${runId}`);
  if (!meta.done) {
    const detail = `задание агента закончилось без итога (${jobState})`;
    await d.tracker.addComment(t.issue, `Агент не дал результата: ${detail}. Журнал: ${t.jobUrl}`);
    await relabel(d, t.issue, [d.labels.running], d.labels.failed);
    return { result: 'failed', detail };
  }
  // Фактическое время агента - в трекер (план против факта); сбой списания задачу не ломает.
  const seconds = Number((JSON.parse(d.runs.read(runId, 'run.json')?.toString('utf8') ?? '{}') as { seconds?: number }).seconds ?? 0);
  if (seconds > 0)
    await d.tracker
      .logWork(
        t.issue,
        seconds,
        `Агент фабрики (роль ${meta.role ?? 'dev'}): ${Math.max(1, Math.round(seconds / 60))} мин работы, запуск ${runId}`,
      )
      .catch((e) => d.tracker.addComment(t.issue, `Время агента не списано: ${(e as Error).message}`));
  const patch = d.runs.read(runId, 'agent.patch')?.toString('utf8') ?? '';
  const exitCode = Number(
    (JSON.parse(d.runs.read(runId, 'done.json')?.toString('utf8') ?? '{}') as { exit_code?: number }).exit_code ?? -1,
  );
  // Настройки цели - из базы, а не из патча: агент их не меняет (защищённый путь).
  const configPath = join(d.runs.dir(runId), 'repo', '.factory', 'config.yml');
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  const v = guardPatch(
    patch,
    exitCode,
    { ...d.guard, ...(meta.role ? { role: meta.role, allowed: roleAllowed(config, meta.role) } : {}) },
    config,
    d.runs.read(runId, 'secrets.json')?.toString('utf8'),
    d.runs.read(runId, 'tests.json')?.toString('utf8'),
  );
  v.findings.push({
    level: 'info',
    message: meta.spec
      ? `спецификация: изменение OpenSpec ${meta.spec} (утверждено слиянием в ${meta.baseBranch})`
      : `изменения OpenSpec для задачи нет (openspec/changes/${t.issue.toLowerCase()}-...)`,
  });
  if (v.state === 'blocked') {
    await d.tracker.addComment(t.issue, `Страж фабрики не пропустил изменение агента:\n${verdictText(v)}\nЖурнал: ${t.jobUrl}`);
    await relabel(d, t.issue, [d.labels.running], d.labels.failed);
    return { result: 'blocked', detail: verdictText(v) };
  }
  const branch = `agent/${runId}`;
  const { headSha } = await d.git.publish(d.runs.dir(runId), { branch, message: `${t.issue}: ${t.title}\n\nЗапуск фабрики ${runId}.` });
  const pull = await d.forge.openPull({
    title: `${t.issue}: ${t.title}`,
    body: `Изменение агента фабрики по задаче ${t.issue}.\n\nЗапуск: ${runId}\nЗадание агента: ${t.jobUrl}\nБаза: ${meta.baseBranch} @ ${meta.baseSha}`,
    head: branch,
    base: meta.baseBranch,
  });
  const ok = v.state === 'success';
  await d.forge.setStatus(headSha, {
    key: VERDICT_KEY,
    state: ok ? 'success' : 'failure',
    description: ok ? 'страж: изменение в границах правил' : `страж: замечаний ${remarks(v)}`,
    url: t.jobUrl,
  });
  await d.forge.commentPull(pull.number, `Вердикт стража фабрики (${ok ? 'зелёный' : 'красный'}):\n${verdictText(v)}`);
  await d.tracker.addComment(t.issue, `Агент открыл PR: ${pull.url}\nВердикт стража - ${ok ? 'зелёный' : 'красный'}, решает человек.`);
  await relabel(d, t.issue, [d.labels.running], d.labels.review);
  return { result: 'pull', detail: verdictText(v), url: pull.url };
}

// Сбой самого координатора: задача не теряется - человек видит причину в трекере.
export async function crash(d: Pick<Deps, 'tracker' | 'labels'>, issue: string, runId: string, error: string): Promise<void> {
  await d.tracker.addComment(issue, `Сбой координатора фабрики в запуске ${runId}: ${error.slice(0, 500)}`);
  for (const l of [d.labels.trigger, d.labels.running]) await d.tracker.removeLabel(issue, l);
  await d.tracker.addLabel(issue, d.labels.failed);
}
