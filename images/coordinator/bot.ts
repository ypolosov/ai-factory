// Бот фабрики в чате команды: библиотекарь отвечает на вопросы со ссылками на источники,
// "!дейли" - сводка работы фабрики, "!задача" - задача агенту. Ответ - только на обращение
// к боту или на команду.
import type { Chat, ChatMessage, Forge, Knowledge, Passage, Tracker } from '../ports/ports.ts';
import { VERDICT_KEY } from './actions.ts';
import type { Ask } from './llm.ts';

export interface Librarian {
  answer(question: string, passages: Passage[]): Promise<string>;
}

export interface BotDeps {
  chat: Chat;
  tracker: Tracker;
  forge: Forge;
  knowledge: Knowledge;
  refreshKnowledge(): Promise<void>;
  librarian: Librarian;
  agentLabel: string;
  // Выпуск: черновик заметок и подтверждение выкладки человеком.
  release?: { draft(): Promise<string>; confirm(tag: string, by: string): Promise<string> };
  account?(): Promise<string>; // учёт фабрики
  proposeRule?(): Promise<string>; // правило-кандидат из повторяющихся замечаний
  slice?: { propose(story: string): Promise<string>; approve(story: string, by: string, agent: boolean): Promise<string> };
  e2e?(channel: string): Promise<string>; // сквозные проверки цели на стенде
  ci?(channel: string, pr?: number): Promise<string>; // перезапуск CI цели на её платформе
  design?(issue: string, m: ChatMessage): Promise<string>; // сверка макета с задачей
  log(message: string): void;
}

export const HELP = `Я бот фабрики. Спросите меня (упоминанием) о проекте - отвечу со ссылками на правила, решения и задачи.
!дейли - что делает фабрика: задачи агентов, PR, решения, выкладка
!задача <название>. <описание> - задача агенту фабрики
!выпуск - что войдёт в следующий выпуск
!выкладка vX.Y.Z - подтвердить выкладку выпуска на стенд
!учёт - попытки, время и цена работы агентов по задачам
!правила - сверщик ищет повторяющиеся замечания к PR и предлагает правило
!нарезка DRAW-N - предложить задачи по стори; !утвердить DRAW-N [agent] - завести их
!e2e - перезапустить сквозные проверки цели на стенде; итог - сюда же
!ci [номер PR] - перезапустить CI цели (GitHub Actions) для PR или ветки по умолчанию
!макет DRAW-N [ссылка на рамку Figma] - сверить макет с задачей (или приложите картинку PNG)`;

const STATES: [string, string][] = [
  ['agent-running', 'агент работает'],
  ['agent-review', 'PR ждёт решения человека'],
  ['agent-failed', 'агент или страж не дали результата'],
  ['needs-decision', 'требование ждёт решения противоречия'],
  ['decision', 'задачи на решение'],
];

export async function daily(d: BotDeps): Promise<string> {
  const lines = ['Дейли фабрики:'];
  for (const [label, what] of STATES) {
    const issues = await d.tracker.listIssues({ label, state: 'open' });
    if (issues.length) lines.push(`- ${what}: ${issues.map((i) => `${i.key} ${i.title}`).join('; ')}`);
  }
  const pulls = await d.forge.listPulls({ state: 'open' });
  for (const p of pulls) {
    const v = (await d.forge.statuses(p.headSha)).find((s) => s.key === VERDICT_KEY);
    lines.push(`- PR ${p.number} "${p.title}": страж ${v ? (v.state === 'success' ? 'зелёный' : 'красный') : 'ещё не смотрел'} - ${p.url}`);
  }
  const repo = await d.forge.repo();
  const head = await d.forge.branchHead(repo.defaultBranch);
  const deploy = head ? (await d.forge.statuses(head)).find((s) => s.key === 'factory/deploy') : undefined;
  lines.push(`- стенд: ${deploy ? `${deploy.description} (${head?.slice(0, 7)})` : `коммит ${head?.slice(0, 7)} ещё не выложен`}`);
  return lines.length > 2 ? lines.join('\n') : `${lines.join('\n')}\n- открытой работы нет`;
}

export async function answer(d: BotDeps, m: ChatMessage): Promise<string | undefined> {
  const text = m.text.replace(/<@!?\d+>/g, '').trim();
  if (/^!(дейли|daily)(\s|$)/i.test(text)) return daily(d);
  if (/^!(помощь|help)(\s|$)/i.test(text)) return HELP;
  if (d.release && /^!(выпуск|release)(\s|$)/i.test(text)) return d.release.draft();
  if (d.account && /^!(учёт|учет|account)(\s|$)/i.test(text)) return d.account();
  if (d.proposeRule && /^!(правила|rules)(\s|$)/i.test(text)) return d.proposeRule();
  if (d.e2e && /^!e2e(\s|$)/i.test(text)) return d.e2e(m.channel);
  const ci = /^!ci(?:\s+#?(\d+))?\s*$/i.exec(text);
  if (d.ci && ci) return d.ci(m.channel, ci[1] ? Number(ci[1]) : undefined);
  const design = /^!(макет|design)\s+([A-Z][A-Z0-9]*-\d+)/i.exec(text)?.[2];
  if (d.design && design) return d.design(design.toUpperCase(), m);
  const slice = /^!(нарезка|slice)\s+([A-Z][A-Z0-9]*-\d+)\s*$/i.exec(text)?.[2];
  if (d.slice && slice) return d.slice.propose(slice.toUpperCase());
  const approve = /^!(утвердить|approve)\s+([A-Z][A-Z0-9]*-\d+)(\s+agent)?\s*$/i.exec(text);
  if (d.slice && approve?.[2]) return d.slice.approve(approve[2].toUpperCase(), m.author, !!approve[3]);
  const deployTag = /^!(выкладка|deploy)\s+(v\d+\.\d+\.\d+)\s*$/i.exec(text)?.[2];
  if (d.release && deployTag) return d.release.confirm(deployTag, m.author);
  const task = /^!(задача|task)\s+([\s\S]+)$/i.exec(text)?.[2];
  if (task) {
    const [title = task, ...rest] = task.split(/(?<=\.)\s+/);
    const i = await d.tracker.createIssue({
      title: title.replace(/\.$/, '').slice(0, 200),
      body: `${rest.join(' ')}\n\nИз чата: ${m.author}, #${m.channel}`.trim(),
      labels: [d.agentLabel],
    });
    return `Задача ${i.key} передана агенту фабрики: ${i.url}`;
  }
  if (!m.mentionsMe) return undefined;
  if (!text) return HELP;
  await d.refreshKnowledge();
  const passages = await d.knowledge.search(text, 6);
  if (!passages.length) return 'В знаниях проекта об этом ничего не нашлось.';
  return d.librarian.answer(text, passages);
}

export function chatBot(d: BotDeps) {
  return d.chat.listen(async (m) => {
    const reply = await answer(d, m).catch((e) => `Не вышло: ${e instanceof Error ? e.message : String(e)}`);
    if (!reply) return;
    await d.chat.reply(m, reply);
    d.log(`бот: ответ в #${m.channel}`);
  });
}

// Ответ только по отрывкам, со ссылками [n]; список источников добавляется всегда.
export function gatewayLibrarian(ask: Ask): Librarian {
  return {
    async answer(question, passages) {
      const list = passages.map((p, i) => `[${i + 1}] ${p.source} - ${p.title}\n${p.text}`).join('\n\n');
      const prompt = `Ты - библиотекарь проекта. Ответь на вопрос кратко, по-русски, только по отрывкам ниже.
После каждого утверждения поставь номер отрывка в скобках, например [2]. Если в отрывках ответа нет - так и скажи.

Вопрос: ${question}

Отрывки:
${list}`;
      const text = (await ask(prompt, 'chat-librarian')).trim() || 'Ответа нет.';
      return `${text}\n\nИсточники:\n${passages.map((p, i) => `[${i + 1}] ${p.title} - <${p.url}>`).join('\n')}`;
    },
  };
}
