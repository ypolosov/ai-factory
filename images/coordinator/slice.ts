// Нарезка стори на задачи (UC2): сверщик предлагает задачи по стори и знанию проекта, PM
// утверждает (человек над процессом), фабрика заводит задачи и связывает их со стори.
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { Knowledge, Tracker } from '../ports/ports.ts';
import type { Ask } from './llm.ts';

export interface SliceDeps {
  tracker: Tracker;
  knowledge: Knowledge;
  refreshKnowledge(): Promise<void>;
  ask: Ask;
  agentLabel: string;
}

const task = z.object({ title: z.string(), body: z.string() });
type Task = z.infer<typeof task>;

export function slicePrompt(title: string, body: string, context: string): string {
  return `Ты - аналитик команды. Нарежь стори на 2-6 задач разработки, каждую - на одного исполнителя и один PR:
API, экран, сквозная проверка, документ. В описании задачи - что сделать и признак готовности. Учитывай правила
и решения проекта ниже, не противоречь им.

Стори: ${title}
${body}

Правила и решения проекта:
${context || '(нет)'}

Ответь только JSON: {"tasks": [{"title": "короткое название по-русски", "body": "что сделать; готово, когда ..."}]}`;
}

export function parseTasks(content: string): Task[] {
  const raw = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)) as { tasks?: unknown[] };
  const tasks = (raw.tasks ?? [])
    .map((t) => task.safeParse(t))
    .filter((r) => r.success)
    .map((r) => ({ title: r.data.title.slice(0, 200), body: r.data.body }))
    .slice(0, 6);
  if (tasks.length < 2) throw new Error('сверщик не предложил хотя бы двух задач');
  return tasks;
}

export const APPROVE_STEP = 'await-approval';

export function sliceWorkflow(d: SliceDeps) {
  const proposeStep = createStep({
    id: 'propose',
    inputSchema: z.object({ story: z.string() }),
    outputSchema: z.object({ story: z.string(), tasks: z.array(task) }),
    execute: async ({ inputData }) => {
      const s = await d.tracker.getIssue(inputData.story);
      await d.refreshKnowledge();
      const ps = (await d.knowledge.search(`${s.title}\n${s.body}`, 7)).filter((p) => p.source !== s.key).slice(0, 6);
      const context = ps.map((p) => `- ${p.source}: ${p.text.slice(0, 600)}`).join('\n');
      return { story: s.key, tasks: parseTasks(await d.ask(slicePrompt(s.title, s.body, context), `${s.key}-slice`)) };
    },
  });
  const approveStep = createStep({
    id: APPROVE_STEP,
    inputSchema: z.object({ story: z.string(), tasks: z.array(task) }),
    outputSchema: z.object({ story: z.string(), tasks: z.array(task), by: z.string(), agent: z.boolean() }),
    suspendSchema: z.object({ story: z.string() }),
    resumeSchema: z.object({ by: z.string(), agent: z.boolean() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) return await suspend({ story: inputData.story });
      return { ...inputData, ...resumeData };
    },
  });
  const createStep_ = createStep({
    id: 'create',
    inputSchema: z.object({ story: z.string(), tasks: z.array(task), by: z.string(), agent: z.boolean() }),
    outputSchema: z.object({ story: z.string(), keys: z.array(z.string()) }),
    execute: async ({ inputData }) => {
      const keys: string[] = [];
      for (const t of inputData.tasks) {
        const i = await d.tracker.createIssue({
          title: t.title,
          body: `${t.body}\n\nИз стори ${inputData.story}; нарезку утвердил ${inputData.by}.`,
          labels: inputData.agent ? [d.agentLabel] : [],
        });
        await d.tracker.linkDependency(inputData.story, i.key);
        keys.push(i.key);
      }
      await d.tracker.addComment(inputData.story, `Нарезка утверждена (${inputData.by}): ${keys.join(', ')}.`);
      return { story: inputData.story, keys };
    },
  });
  return createWorkflow({
    id: 'slice',
    inputSchema: z.object({ story: z.string() }),
    outputSchema: z.object({ story: z.string(), keys: z.array(z.string()) }),
  })
    .then(proposeStep)
    .then(approveStep)
    .then(createStep_)
    .commit();
}

export type SliceWorkflow = ReturnType<typeof sliceWorkflow>;

const runId = (story: string) => `slice-${story}`;

type Result = { status: string; error?: unknown; result?: unknown; steps?: Record<string, { output?: unknown }> };

// Команды PM в чате: предложить нарезку и утвердить её.
export function slicer(workflow: SliceWorkflow) {
  const list = (tasks: Task[]) => tasks.map((t, i) => `${i + 1}. ${t.title} - ${t.body}`).join('\n');
  return {
    async propose(story: string): Promise<string> {
      const old = await workflow.getWorkflowRunById(runId(story));
      if (old?.status === 'suspended' || old?.status === 'success') {
        return `Нарезка ${story} уже ${old.status === 'success' ? 'утверждена' : 'ждёт утверждения: !утвердить'} ${story}`;
      }
      const run = await workflow.createRun({ runId: runId(story), resourceId: story });
      const r = (await run.start({ inputData: { story } })) as Result;
      if (r.status !== 'suspended')
        return `Нарезка ${story} не вышла: ${String((r.error as { message?: string } | undefined)?.message ?? r.status)}`;
      const tasks = (r.steps?.propose?.output as { tasks: Task[] } | undefined)?.tasks ?? [];
      return `Сверщик предлагает нарезку ${story}:\n${list(tasks)}\n\nУтвердить: !утвердить ${story} (или !утвердить ${story} agent - сразу агенту)`;
    },
    async approve(story: string, by: string, agent: boolean): Promise<string> {
      const old = await workflow.getWorkflowRunById(runId(story));
      if (old?.status !== 'suspended') return `Нарезка ${story} не ждёт утверждения: сначала !нарезка ${story}`;
      const run = await workflow.createRun({ runId: runId(story), resourceId: story });
      const r = (await run.resume({ step: APPROVE_STEP, resumeData: { by, agent } })) as Result;
      if (r.status !== 'success')
        return `Задачи не заведены: ${String((r.error as { message?: string } | undefined)?.message ?? r.status)}`;
      const keys = (r.result as { keys: string[] }).keys;
      return `Задачи заведены: ${keys.join(', ')}${agent ? ' - отданы агенту' : ''}.`;
    },
  };
}
