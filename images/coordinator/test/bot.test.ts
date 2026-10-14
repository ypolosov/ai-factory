import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_DOCS } from '../../ports/test/contract.ts';
import { memoryChat, memoryForge, memoryKnowledge, memoryTracker } from '../../ports/test/memory.ts';
import { VERDICT_KEY } from '../actions.ts';
import { type BotDeps, chatBot } from '../bot.ts';

const setup = () => {
  const c = memoryChat();
  const tracker = memoryTracker();
  const f = memoryForge();
  const asked: string[] = [];
  const d: BotDeps = {
    chat: c.chat,
    tracker,
    forge: f.forge,
    knowledge: memoryKnowledge(KNOWLEDGE_DOCS),
    refreshKnowledge: async () => {},
    librarian: { answer: async (q, ps) => (asked.push(q), `ответ по ${ps[0]?.source}`) },
    agentLabel: 'agent',
    log: () => {},
  };
  chatBot(d);
  return { c, tracker, f, asked };
};

describe('бот фабрики в чате', () => {
  it('библиотекарь отвечает только на обращение', async () => {
    const { c, asked } = setup();
    await c.say('продукт', 'что известно про повторный розыгрыш заново?');
    expect(c.sent).toEqual([]);
    await c.say('продукт', '<@123> что известно про повторный розыгрыш заново?', true);
    expect(asked).toEqual(['что известно про повторный розыгрыш заново?']);
    expect(c.sent[0]).toEqual({ channel: 'продукт', text: 'ответ по docs/adr/ADR-3-reproducible-draw.md', replyTo: 'm-2' });
  });

  it('!задача передаёт задачу агенту', async () => {
    const { c, tracker } = setup();
    await c.say('разработка', '!задача Тёмная тема. Добавить переключатель темы в шапке.');
    const [i] = await tracker.listIssues({ label: 'agent' });
    expect(i?.title).toBe('Тёмная тема');
    expect(i?.body).toContain('Добавить переключатель темы в шапке.');
    expect(c.sent[0]?.text).toContain(`Задача ${i?.key} передана агенту`);
  });

  it('!дейли - сводка по меткам, PR со стражем и стенду', async () => {
    const { c, tracker, f } = setup();
    await tracker.createIssue({ title: 'Повтор розыгрыша', body: '', labels: ['needs-decision'] });
    const pr = await f.openPull();
    await f.forge.setStatus((await f.forge.getPull(pr.n)).headSha, { key: VERDICT_KEY, state: 'success', description: '' });
    await c.say('разработка', '!дейли');
    const text = c.sent[0]?.text ?? '';
    expect(text).toContain('требование ждёт решения противоречия: 1 Повтор розыгрыша');
    expect(text).toContain(`PR ${pr.n}`);
    expect(text).toContain('страж зелёный');
    expect(text).toContain('ещё не выложен');
  });
});
