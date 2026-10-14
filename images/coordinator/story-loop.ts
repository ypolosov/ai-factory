// Цикл сверки требований: новые стори с меткой-триггером -> сценарий сверки; стори, которые
// ждут решения, возобновляются, когда закрыты все задачи, от которых они зависят. Истина о
// решении - в трекере, поэтому цикл переживает перезапуск координатора.
import type { Tracker } from '../ports/ports.ts';
import type { StoryLabels } from './story.ts';
import { DECISION_STEP, type StoryCheckWorkflow } from './story-workflow.ts';

export interface StoryLoopDeps {
  workflow: StoryCheckWorkflow;
  tracker: Tracker;
  labels: StoryLabels & { failed: string };
  log(message: string): void;
}

type Result = { status: string; error?: unknown; result?: unknown };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function storyLoop(d: StoryLoopDeps) {
  let busy = false;

  async function settle(issue: string, runId: string, r: Result) {
    d.log(`${runId}: ${r.status}${r.result ? ` ${JSON.stringify(r.result)}` : ''}`);
    if (r.status !== 'failed') return;
    await d.tracker.addComment(issue, `Сбой сверщика фабрики в запуске ${runId}: ${message(r.error).slice(0, 500)}`);
    for (const l of [d.labels.trigger, d.labels.checking]) await d.tracker.removeLabel(issue, l);
    await d.tracker.addLabel(issue, d.labels.failed);
  }

  async function startNew() {
    for (const i of await d.tracker.listIssues({ label: d.labels.trigger, state: 'open' })) {
      const runId = `${i.key}-${Date.now().toString(36)}`;
      const run = await d.workflow.createRun({ runId, resourceId: i.key });
      await settle(i.key, runId, (await run.start({ inputData: { issue: i.key } })) as Result);
    }
  }

  async function resumeDecided() {
    const { runs } = await d.workflow.listWorkflowRuns({ status: 'suspended' });
    for (const { runId, resourceId } of runs) {
      if (!resourceId) continue;
      const deps = await d.tracker.listDependencies(resourceId);
      if (!deps.length) continue;
      const states = await Promise.all(deps.map(async (k) => (await d.tracker.getIssue(k)).state));
      if (states.some((s) => s !== 'closed')) continue;
      const run = await d.workflow.createRun({ runId, resourceId });
      await settle(resourceId, runId, (await run.resume({ step: DECISION_STEP, resumeData: { decided: true } })) as Result);
    }
  }

  return {
    async tick() {
      if (busy) return;
      busy = true;
      try {
        await startNew();
        await resumeDecided();
      } catch (e) {
        d.log(`проход сверщика: ${message(e)}`);
      } finally {
        busy = false;
      }
    },
  };
}
