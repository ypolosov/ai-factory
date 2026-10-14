// Сценарий "сверка требования" на Mastra core: взять стори -> сверить со знаниями ->
// противоречие: задача на решение и приостановка до решения человека (переживает
// перезапуск) -> повторная сверка и итог.
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { claimStory, escalate, judgeStory, report, type StoryDeps } from './story.ts';

export const DECISION_STEP = 'await-decision';

const start = z.object({ issue: z.string() });
const statement = z.object({ issue: z.string(), title: z.string(), body: z.string() });
const passage = z.object({ source: z.string(), title: z.string(), text: z.string(), url: z.string() });
const judgement = z.object({
  verdict: z.enum(['ok', 'conflict']),
  summary: z.string(),
  conflicts: z.array(z.object({ source: z.string(), url: z.string(), quote: z.string(), why: z.string() })),
  checked: z.array(passage),
});
const judged = z.object({ statement, judgement });
const decided = judged.extend({ decision: z.string().optional() });
const outcome = z.object({ result: z.enum(['ok', 'conflict', 'resolved']), detail: z.string() });

export function storyCheckWorkflow(d: StoryDeps) {
  const claimStep = createStep({
    id: 'claim-story',
    inputSchema: start,
    outputSchema: statement,
    execute: async ({ inputData }) => claimStory(d, inputData.issue),
  });
  const judgeStep = createStep({
    id: 'judge-story',
    inputSchema: statement,
    outputSchema: judged,
    execute: async ({ inputData }) => ({ statement: inputData, judgement: await judgeStory(d, inputData) }),
  });
  // Противоречие решает человек: задача на решение, шаг ждёт её закрытия.
  const decisionStep = createStep({
    id: DECISION_STEP,
    inputSchema: judged,
    outputSchema: decided,
    suspendSchema: z.object({ task: z.string() }),
    resumeSchema: z.object({ decided: z.boolean() }),
    execute: async ({ inputData, resumeData, suspendData, suspend }) => {
      if (inputData.judgement.verdict === 'ok') return inputData;
      if (resumeData?.decided && suspendData?.task) return { ...inputData, decision: suspendData.task };
      return await suspend({ task: await escalate(d, inputData.statement, inputData.judgement) });
    },
  });
  const reportStep = createStep({
    id: 'report-story',
    inputSchema: decided,
    outputSchema: outcome,
    execute: async ({ inputData }) => {
      const j = inputData.decision ? await judgeStory(d, inputData.statement) : inputData.judgement;
      return report(d, inputData.statement, j, inputData.decision);
    },
  });
  return createWorkflow({ id: 'story-check', inputSchema: start, outputSchema: outcome })
    .then(claimStep)
    .then(judgeStep)
    .then(decisionStep)
    .then(reportStep)
    .commit();
}

export type StoryCheckWorkflow = ReturnType<typeof storyCheckWorkflow>;
