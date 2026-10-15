// Проверки на своём раннере (судья PR, сверка макета, e2e на стенде): тот же посредник шагов,
// что у агента, - платформа заданий знает только адрес посредника и разовый ключ. Итог шага
// разбирает обработчик своего вида проверки, когда задание закончилось.
import type { Job, JobRunner } from '../ports/ports.ts';
import { message } from './errors.ts';
import type { RunKind, RunMeta, RunStore } from './runs.ts';

export type CheckKind = Exclude<RunKind, 'agent'>;

export interface CheckDeps {
  runs: RunStore;
  jobs: JobRunner;
  brokerUrl: string;
  pipeline(kind: CheckKind): string; // имя задания у исполнителя
}

export interface CheckRequest {
  kind: CheckKind;
  issue: string; // задача для учёта (или pr-N)
  subject: string;
  task: string;
  input?: Uint8Array;
  repoTar?: Uint8Array;
}

export async function startCheck(d: CheckDeps, r: CheckRequest): Promise<{ runId: string; jobUrl: string }> {
  const runId = `${r.issue}-${r.kind}-${Date.now().toString(36)}`;
  const { token } = d.runs.create(runId, r.issue, { kind: r.kind, subject: r.subject });
  d.runs.write(runId, 'task.md', r.task);
  if (r.input) d.runs.write(runId, 'input', r.input);
  if (r.repoTar) d.runs.write(runId, 'repo.tar.gz', r.repoTar);
  const job = await d.jobs.start({ job: d.pipeline(r.kind), variables: { BROKER_URL: d.brokerUrl }, secrets: { RUN_TOKEN: token } });
  d.runs.update(runId, { jobId: job.id, jobUrl: job.url });
  return { runId, jobUrl: job.url };
}

// Обработчик итога: result - разобранный result.json шага (нет файла - undefined).
export type CheckHandler = (meta: RunMeta, result: unknown, job: Job) => Promise<void>;

export function checkLoop(d: {
  runs: RunStore;
  jobs: JobRunner;
  handlers: Partial<Record<CheckKind, CheckHandler>>;
  // Вход Codex, обновлённый в шаге: сохранить для следующих шагов.
  saveCodexAuth?(auth: string): void;
  log(m: string): void;
}) {
  let busy = false;
  return {
    async tick() {
      if (busy) return;
      busy = true;
      try {
        for (const meta of d.runs.list()) {
          if (!meta.kind || meta.kind === 'agent' || meta.reported || !meta.jobId) continue;
          const job = await d.jobs.get(meta.jobId);
          if (job.state === 'pending' || job.state === 'running') continue;
          let result: unknown;
          try {
            result = JSON.parse(d.runs.read(meta.runId, 'result.json')?.toString('utf8') ?? 'null') ?? undefined;
          } catch {
            result = undefined;
          }
          d.runs.update(meta.runId, { reported: true });
          const auth = d.runs.read(meta.runId, 'codex-auth.json');
          if (auth?.length && d.saveCodexAuth) {
            d.saveCodexAuth(auth.toString('utf8'));
            d.runs.write(meta.runId, 'codex-auth.json', '');
          }
          try {
            await d.handlers[meta.kind]?.(meta, result, job);
          } catch (e) {
            d.log(`итог проверки ${meta.runId}: ${message(e)}`);
          }
          d.log(`${meta.runId}: ${job.state}`);
        }
      } catch (e) {
        d.log(`проход проверок: ${message(e)}`);
      } finally {
        busy = false;
      }
    },
  };
}
