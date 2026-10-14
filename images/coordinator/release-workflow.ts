// Сценарий выпуска на Mastra core: заметки -> ждать подтверждения человека -> выкладка тега
// -> ждать итога выкладки -> публикация. Обе паузы переживают перезапуск координатора.
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { deploy, draft, publish, type ReleaseDeps } from './release.ts';

export const CONFIRM_STEP = 'await-confirm';
export const DEPLOYED_STEP = 'await-deploy';

const notes = z.object({ tag: z.string(), sha: z.string(), prev: z.string().optional(), keys: z.array(z.string()), text: z.string() });
const confirmed = z.object({ notes, by: z.string() });

export function releaseWorkflow(d: ReleaseDeps) {
  const notesStep = createStep({
    id: 'notes',
    inputSchema: z.object({ tag: z.string() }),
    outputSchema: notes,
    execute: async ({ inputData }) => draft(d, inputData.tag),
  });
  const confirmStep = createStep({
    id: CONFIRM_STEP,
    inputSchema: notes,
    outputSchema: confirmed,
    suspendSchema: z.object({ tag: z.string() }),
    resumeSchema: z.object({ by: z.string() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) return await suspend({ tag: inputData.tag });
      return { notes: inputData, by: resumeData.by };
    },
  });
  const deployStep = createStep({
    id: 'deploy',
    inputSchema: confirmed,
    outputSchema: confirmed,
    execute: async ({ inputData }) => {
      await deploy(d, inputData.notes.tag);
      return inputData;
    },
  });
  const deployedStep = createStep({
    id: DEPLOYED_STEP,
    inputSchema: confirmed,
    outputSchema: confirmed,
    suspendSchema: z.object({ tag: z.string() }),
    resumeSchema: z.object({ ok: z.boolean(), description: z.string() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) return await suspend({ tag: inputData.notes.tag });
      if (!resumeData.ok) throw new Error(`выкладка ${inputData.notes.tag} не удалась: ${resumeData.description}`);
      return inputData;
    },
  });
  const publishStep = createStep({
    id: 'publish',
    inputSchema: confirmed,
    outputSchema: z.object({ tag: z.string(), url: z.string() }),
    execute: async ({ inputData }) => ({ tag: inputData.notes.tag, url: await publish(d, inputData.notes, inputData.by) }),
  });
  return createWorkflow({
    id: 'release',
    inputSchema: z.object({ tag: z.string() }),
    outputSchema: z.object({ tag: z.string(), url: z.string() }),
  })
    .then(notesStep)
    .then(confirmStep)
    .then(deployStep)
    .then(deployedStep)
    .then(publishStep)
    .commit();
}

export type ReleaseWorkflow = ReturnType<typeof releaseWorkflow>;
