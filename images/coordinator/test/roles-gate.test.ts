// Права в точках решения: команды бота и метки-триггеры задач проверяются по реестру ролей.
import { describe, expect, it } from 'vitest';
import { memoryChat, memoryForge, memoryKnowledge, memoryTracker } from '../../ports/test/memory.ts';
import { chatBot } from '../bot.ts';
import { coordinator } from '../coordinator.ts';
import { admitIssue, parseRoles } from '../roles.ts';
import type { AgentTaskWorkflow } from '../workflow.ts';

const YAML = `
holders:
  anna: { kind: human, name: Аня, accounts: { discord: "u-anna", jira: anna } }
  gleb: { kind: human, name: Глеб, accounts: { discord: "u-gleb", jira: gleb } }
  pavel: { kind: human-ai, name: Павел, accounts: { discord: "u-pavel" } }
roles:
  product-owner: [anna]
  devops: [gleb]
  project-manager: [pavel]
decisions:
  deploy: [devops]
  submit-task: [product-owner]
  approve-slice: [project-manager]
`;

describe('права в точках решения', () => {
  it('выкладку подтверждает только DevOps; вебхук без учётки - отказ', async () => {
    const c = memoryChat();
    const confirmed: string[] = [];
    chatBot({
      chat: c.chat,
      tracker: memoryTracker(),
      forge: memoryForge().forge,
      knowledge: memoryKnowledge([]),
      refreshKnowledge: async () => {},
      librarian: { answer: async () => '' },
      agentLabel: 'agent',
      roles: async () => parseRoles(YAML),
      release: { draft: async () => '', confirm: async (tag, by) => (confirmed.push(`${tag}:${by}`), 'подтверждено') },
      log: () => {},
    });
    await c.say('релизы', '!выкладка v1.1.0', false, 'u-anna');
    await c.say('релизы', '!выкладка v1.1.0', false, 'hook-1', true);
    await c.say('релизы', '!выкладка v1.1.0', false, 'u-gleb');
    expect(c.sent.map((s) => s.text)).toEqual([
      'Нельзя подтвердить выкладку: это решение ролей devops, а здесь Аня (роли: product-owner). Реестр ролей - .factory/roles.yml цели.',
      'Нельзя подтвердить выкладку: это решение ролей devops, а здесь сообщение вебхука без учётки. Реестр ролей - .factory/roles.yml цели.',
      'подтверждено',
    ]);
    expect(confirmed).toEqual(['v1.1.0:Глеб']);
  });

  it('метку agent от учётки без роли фабрика снимает и объясняет; агент не запускается', async () => {
    // Метку ставит Глеб (DevOps) своей учёткой, а отдавать задачи агенту может только продукт.
    const tracker = memoryTracker();
    const i = await tracker.as('gleb').createIssue({ title: 'Тёмная тема', body: '', labels: ['agent'] });
    const workflow = {
      createRun: async () => {
        throw new Error('агент не должен запускаться');
      },
      listWorkflowRuns: async () => ({ runs: [], total: 0 }),
    } as unknown as AgentTaskWorkflow;
    const loop = coordinator({
      workflow,
      tracker,
      jobs: {
        start: async () => ({ id: '', state: 'pending', url: '' }),
        get: async () => ({ id: '', state: 'pending', url: '' }),
        stop: async () => {},
      },
      runs: { list: () => [] } as never,
      labels: { trigger: 'agent', running: 'agent-running', review: 'agent-review', failed: 'agent-failed' },
      roles: async () => parseRoles(YAML),
      log: () => {},
    });
    await loop.tick();
    expect((await tracker.getIssue(i.key)).labels).toEqual([]);
    expect((await tracker.listComments(i.key))[0]?.body).toContain(
      'Нельзя передать задачу агенту: это решение ролей product-owner, а здесь Глеб (роли: devops)',
    );
  });

  it('метку от учётки самой фабрики не проверяют второй раз; руками - по роли', async () => {
    // Задачу из чата завела фабрика после проверки роли в чате; её метка проходит.
    const tracker = memoryTracker();
    const d = { tracker, roles: async () => parseRoles(YAML), log: () => {} };
    const mine = await tracker.createIssue({ title: 'из чата', body: '', labels: ['agent'] });
    expect(await admitIssue(d, mine.key, 'agent', 'submit-task')).toBe(true);
    const anna = await tracker.as('anna').createIssue({ title: 'от продукта', body: '', labels: ['agent'] });
    expect(await admitIssue(d, anna.key, 'agent', 'submit-task')).toBe(true);
    // Метку поставили позже: решает тот, кто её поставил, а не автор задачи.
    const late = await tracker.as('anna').createIssue({ title: 'позже', body: '' });
    await tracker.as('gleb').addLabel(late.key, 'agent');
    expect(await admitIssue(d, late.key, 'agent', 'submit-task')).toBe(false);
  });

  it('нарезка с передачей агенту - ещё и решение передать задачу', async () => {
    const c = memoryChat();
    const approved: string[] = [];
    chatBot({
      chat: c.chat,
      tracker: memoryTracker(),
      forge: memoryForge().forge,
      knowledge: memoryKnowledge([]),
      refreshKnowledge: async () => {},
      librarian: { answer: async () => '' },
      agentLabel: 'agent',
      roles: async () => parseRoles(YAML),
      slice: {
        propose: async () => '',
        approve: async (story, by, agent) => (approved.push(`${story}:${by}:${agent}`), 'утверждено'),
      },
      log: () => {},
    });
    await c.say('продукт', '!утвердить DRAW-1 agent', false, 'u-pavel');
    await c.say('продукт', '!утвердить DRAW-1', false, 'u-pavel');
    expect(c.sent.map((s) => s.text)).toEqual([
      'Нельзя передать задачу агенту: это решение ролей product-owner, а здесь Павел (роли: project-manager). Реестр ролей - .factory/roles.yml цели.',
      'утверждено',
    ]);
    expect(approved).toEqual(['DRAW-1:Павел:false']);
  });
});
