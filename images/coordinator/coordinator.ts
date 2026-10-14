// Цикл координатора: новые задачи с меткой-триггером -> запуск сценария; приостановленные
// запуски, чьё задание закончилось, -> возобновление. Истина о задании - у исполнителя
// заданий, поэтому цикл переживает перезапуск координатора.
import type { JobRunner, Tracker } from '../ports/ports.ts';
import { crash, type Labels } from './actions.ts';
import { message } from './errors.ts';
import type { RunStore } from './runs.ts';
import { type AgentTaskWorkflow, AWAIT_STEP } from './workflow.ts';

export interface CoordinatorDeps {
  workflow: AgentTaskWorkflow;
  tracker: Tracker;
  jobs: JobRunner;
  runs: RunStore;
  labels: Labels;
  log(message: string): void;
}

type Result = { status: string; error?: unknown; result?: unknown };

export function coordinator(d: CoordinatorDeps) {
  let busy = false;

  async function settle(issue: string, runId: string, r: Result) {
    d.log(`${runId}: ${r.status}${r.result ? ` ${JSON.stringify(r.result)}` : ''}`);
    if (r.status === 'failed') await crash(d, issue, runId, message(r.error));
  }

  async function startNew() {
    for (const i of await d.tracker.listIssues({ label: d.labels.trigger, state: 'open' })) {
      const runId = `${i.key}-${Date.now().toString(36)}`;
      const run = await d.workflow.createRun({ runId, resourceId: i.key });
      await settle(i.key, runId, (await run.start({ inputData: { issue: i.key } })) as Result);
    }
  }

  async function resumeFinished() {
    const { runs } = await d.workflow.listWorkflowRuns({ status: 'suspended' });
    for (const { runId } of runs) {
      const meta = d.runs.meta(runId);
      if (!meta?.jobId) continue;
      const job = await d.jobs.get(meta.jobId);
      if (job.state === 'pending' || job.state === 'running') continue;
      const run = await d.workflow.createRun({ runId });
      await settle(meta.issue, runId, (await run.resume({ step: AWAIT_STEP, resumeData: { jobState: job.state } })) as Result);
    }
  }

  return {
    // Один проход; пока идёт проход, новые вызовы пропускаются.
    async tick() {
      if (busy) return;
      busy = true;
      try {
        await startNew();
        await resumeFinished();
      } catch (e) {
        d.log(`проход координатора: ${message(e)}`);
      } finally {
        busy = false;
      }
    },
  };
}
