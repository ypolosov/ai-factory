// Действия координатора над портами: взять задачу, отдать её агенту на исполнителе заданий,
// проверить итог стражем и опубликовать PR. Движок сценария (Mastra) только связывает их
// в шаги и хранит состояние между ними - его замена не трогает этот код.
import type { Forge, JobRunner, JobState, Tracker } from '../ports/ports.ts';
import type { Git } from './git.ts';
import { type GuardOptions, guardPatch, type Verdict } from './guard.ts';
import type { RunStore } from './runs.ts';

export interface Labels {
  trigger: string; // задача ждёт агента
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
}

export interface Task {
  issue: string;
  title: string;
  body: string;
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

export async function claim(d: Deps, issue: string): Promise<Task> {
  const i = await d.tracker.getIssue(issue);
  await relabel(d, issue, [d.labels.trigger], d.labels.running);
  return { issue, title: i.title, body: i.body };
}

export async function dispatch(d: Deps, runId: string, t: Task): Promise<Dispatched> {
  const { token } = d.runs.create(runId, t.issue);
  const baseBranch = (await d.forge.repo()).defaultBranch;
  const { baseSha } = await d.git.prepare(d.runs.dir(runId), baseBranch);
  d.runs.write(runId, 'task.md', `# ${t.issue}: ${t.title}\n\n${t.body}\n`);
  const job = await d.jobs.start({ job: d.job, variables: { BROKER_URL: d.brokerUrl }, secrets: { RUN_TOKEN: token } });
  d.runs.update(runId, { baseBranch, baseSha, jobId: job.id, jobUrl: job.url });
  await d.tracker.addComment(t.issue, `Фабрика взяла задачу: запуск ${runId}, задание агента ${job.url}`);
  return { issue: t.issue, title: t.title, jobId: job.id, jobUrl: job.url };
}

const verdictText = (v: Verdict) =>
  v.findings.length ? v.findings.map((f) => `- ${f.level === 'block' ? 'стоп' : 'замечание'}: ${f.message}`).join('\n') : '- замечаний нет';

export async function finish(d: Deps, runId: string, t: Dispatched, jobState: JobState): Promise<Outcome> {
  const meta = d.runs.meta(runId);
  if (!meta?.baseBranch) throw new Error(`нет данных запуска ${runId}`);
  if (!meta.done) {
    const detail = `задание агента закончилось без итога (${jobState})`;
    await d.tracker.addComment(t.issue, `Агент не дал результата: ${detail}. Журнал: ${t.jobUrl}`);
    await relabel(d, t.issue, [d.labels.running], d.labels.failed);
    return { result: 'failed', detail };
  }
  const patch = d.runs.read(runId, 'agent.patch')?.toString('utf8') ?? '';
  const exitCode = Number(
    (JSON.parse(d.runs.read(runId, 'done.json')?.toString('utf8') ?? '{}') as { exit_code?: number }).exit_code ?? -1,
  );
  const v = guardPatch(patch, exitCode, d.guard);
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
    description: ok ? 'страж: изменение в границах правил' : `страж: замечаний ${v.findings.length}`,
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
