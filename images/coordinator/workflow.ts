// Сценарий "задача агенту" на Mastra core: взять задачу -> отдать агенту -> ждать задание
// (приостановка с записью в хранилище, переживает перезапуск) -> страж и PR.
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { claim, type Deps, dispatch, finish } from './actions.ts';

export const AWAIT_STEP = 'await-job';

const jobState = z.enum(['pending', 'running', 'success', 'failed', 'stopped']);
const start = z.object({ issue: z.string(), label: z.string().optional(), role: z.string().optional() });
const task = z.object({ issue: z.string(), title: z.string(), body: z.string(), role: z.string().optional() });
const dispatched = z.object({ issue: z.string(), title: z.string(), jobId: z.string(), jobUrl: z.string() });
const finished = dispatched.extend({ jobState });
const outcome = z.object({ result: z.enum(['pull', 'blocked', 'failed']), detail: z.string(), url: z.string().optional() });

export function agentTaskWorkflow(d: Deps) {
  const claimStep = createStep({
    id: 'claim',
    inputSchema: start,
    outputSchema: task,
    execute: async ({ inputData }) => claim(d, inputData.issue, inputData.label, inputData.role),
  });
  const dispatchStep = createStep({
    id: 'dispatch',
    inputSchema: task,
    outputSchema: dispatched,
    execute: async ({ inputData, runId }) => dispatch(d, runId, inputData),
  });
  // Ждёт конца задания агента: координатор возобновляет шаг, когда исполнитель сообщил итог.
  const awaitStep = createStep({
    id: AWAIT_STEP,
    inputSchema: dispatched,
    outputSchema: finished,
    suspendSchema: z.object({ jobId: z.string() }),
    resumeSchema: z.object({ jobState }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) return await suspend({ jobId: inputData.jobId });
      return { ...inputData, jobState: resumeData.jobState };
    },
  });
  const finishStep = createStep({
    id: 'finish',
    inputSchema: finished,
    outputSchema: outcome,
    execute: async ({ inputData, runId }) => finish(d, runId, inputData, inputData.jobState),
  });
  return createWorkflow({ id: 'agent-task', inputSchema: start, outputSchema: outcome })
    .then(claimStep)
    .then(dispatchStep)
    .then(awaitStep)
    .then(finishStep)
    .commit();
}

export type AgentTaskWorkflow = ReturnType<typeof agentTaskWorkflow>;
