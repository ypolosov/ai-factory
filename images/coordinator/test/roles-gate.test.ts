// Права в точках решения: команды бота и метки-триггеры задач проверяются по реестру ролей.
import { describe, expect, it } from 'vitest';
import { memoryChat, memoryForge, memoryKnowledge, memoryTracker } from '../../ports/test/memory.ts';
import { chatBot } from '../bot.ts';
import { coordinator } from '../coordinator.ts';
import { parseRoles } from '../roles.ts';
import type { AgentTaskWorkflow } from '../workflow.ts';

const YAML = `
holders:
  anna: { kind: human, name: Аня, accounts: { discord: "u-anna", jira: anna } }
  gleb: { kind: human, name: Глеб, accounts: { discord: "u-gleb", jira: factory-bot } }
roles:
  product-owner: [anna]
  devops: [gleb]
decisions:
  deploy: [devops]
  submit-task: [product-owner]
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
    // Метку ставит учётка factory-bot (Глеб, DevOps), а отдавать задачи агенту может только продукт.
    const tracker = memoryTracker();
    const i = await tracker.createIssue({ title: 'Тёмная тема', body: '', labels: ['agent'] });
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
});
