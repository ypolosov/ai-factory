// Бот фабрики в чате команды: библиотекарь отвечает на вопросы со ссылками на источники,
// "!дейли" - сводка работы фабрики, "!задача" - задача агенту. Ответ - только на обращение
// к боту или на команду.
import { type Chat, type ChatMessage, type Forge, type Knowledge, type Passage, PortError, type Tracker } from '../ports/ports.ts';
import { VERDICT_KEY } from './actions.ts';
import type { Ask } from './llm.ts';
import { type Decision, type RoleRegistry, refusal } from './roles.ts';
import { jsonOf, type LibrarianAnswer, librarianAnswer, librarianText } from './templates.ts';

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
  roles?(): Promise<RoleRegistry>; // реестр ролей цели: права в точках решения
  chatTool?: string; // имя носителя чата в реестре ролей (по умолчанию discord)
  proposeRule?(): Promise<string>; // правило-кандидат из повторяющихся замечаний
  slice?: { propose(story: string): Promise<string>; approve(story: string, by: string, agent: boolean): Promise<string> };
  e2e?(channel: string): Promise<string>; // сквозные проверки цели на стенде
  ci?(channel: string, pr?: number): Promise<string>; // перезапуск CI цели на её платформе
  judge?(pr: number): Promise<string>; // повтор судьи PR
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
!судья N - судья фабрики (Codex) снова смотрит PR N
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
  // Упоминания учёток и ролей - не часть вопроса (служебная роль бота - тоже обращение к нему).
  const text = m.text.replace(/<@[!&]?\d+>/g, '').trim();
  const tool = d.chatTool ?? 'discord';
  // Точка решения: отказ, если у учётки нет нужной роли; иначе - undefined.
  const gate = async (decision: Decision): Promise<string | undefined> => {
    const r = await d.roles?.();
    if (!r) return undefined;
    const c = r.check(decision, tool, m.authorId);
    return c.ok ? undefined : refusal(decision, c, m.viaWebhook);
  };
  const by = async () => (await d.roles?.())?.holder(tool, m.authorId)?.name ?? m.author;
  if (/^!(дейли|daily)(\s|$)/i.test(text)) return daily(d);
  if (/^!(помощь|help)(\s|$)/i.test(text)) return HELP;
  if (d.release && /^!(выпуск|release)(\s|$)/i.test(text)) return d.release.draft();
  if (d.account && /^!(учёт|учет|account)(\s|$)/i.test(text)) return d.account();
  if (d.proposeRule && /^!(правила|rules)(\s|$)/i.test(text)) return (await gate('propose-rule')) ?? d.proposeRule();
  if (d.e2e && /^!e2e(\s|$)/i.test(text)) return (await gate('rerun-checks')) ?? d.e2e(m.channel);
  const judge = /^!(судья|judge)\s+#?(\d+)\s*$/i.exec(text)?.[2];
  if (d.judge && judge) return (await gate('rerun-checks')) ?? d.judge(Number(judge));
  const ci = /^!ci(?:\s+#?(\d+))?\s*$/i.exec(text);
  if (d.ci && ci) return (await gate('rerun-checks')) ?? d.ci(m.channel, ci[1] ? Number(ci[1]) : undefined);
  const design = /^!(макет|design)\s+([A-Z][A-Z0-9]*-\d+)/i.exec(text)?.[2];
  if (d.design && design) return (await gate('design-check')) ?? d.design(design.toUpperCase(), m);
  const slice = /^!(нарезка|slice)\s+([A-Z][A-Z0-9]*-\d+)\s*$/i.exec(text)?.[2];
  if (d.slice && slice) return (await gate('slice')) ?? d.slice.propose(slice.toUpperCase());
  const approve = /^!(утвердить|approve)\s+([A-Z][A-Z0-9]*-\d+)(\s+agent)?\s*$/i.exec(text);
  if (d.slice && approve?.[2]) {
    const denied = (await gate('approve-slice')) ?? (approve[3] ? await gate('submit-task') : undefined);
    return denied ?? d.slice.approve(approve[2].toUpperCase(), await by(), !!approve[3]);
  }
  const deployTag = /^!(выкладка|deploy)\s+(v\d+\.\d+\.\d+)\s*$/i.exec(text)?.[2];
  if (d.release && deployTag) return (await gate('deploy')) ?? d.release.confirm(deployTag, await by());
  const task = /^!(задача|task)\s+([\s\S]+)$/i.exec(text)?.[2];
  if (task) {
    const denied = await gate('submit-task');
    if (denied) return denied;
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

// Ответ на сбой команды - для человека: что не так и что сделать, без ответа API.
export function failure(e: unknown): string {
  if (e instanceof PortError && e.code === 'not_found') return 'Не нашлось: проверьте номер задачи или PR в команде.';
  if (e instanceof PortError && e.code === 'unavailable') return 'Сервис сейчас недоступен - повторите команду через минуту.';
  if (e instanceof PortError && e.code === 'auth') return 'Фабрике не хватает доступа к сервису - скажите владельцу фабрики.';
  return `Не вышло: ${e instanceof Error ? e.message : String(e)}`;
}

export function chatBot(d: BotDeps) {
  return d.chat.listen(async (m) => {
    const reply = await answer(d, m).catch(failure);
    if (!reply) return;
    await d.chat.reply(m, reply);
    d.log(`бот: ответ в #${m.channel}`);
  });
}

// Ответ только по отрывкам, со ссылками [n], по шаблону "коротко, подробнее, источники".
export function gatewayLibrarian(ask: Ask): Librarian {
  return {
    async answer(question, passages) {
      const list = passages.map((p, i) => `[${i + 1}] ${p.source} - ${p.title}\n${p.text}`).join('\n\n');
      const prompt = `Ты - библиотекарь проекта. Ответь на вопрос по-русски, только по отрывкам ниже.
После каждого утверждения поставь номер отрывка в скобках, например [2].

Вопрос: ${question}

Отрывки:
${list}

Ответь только JSON: {"found": true или false - есть ли ответ в отрывках, "short": "ответ одним-двумя
предложениями", "details": ["до пяти подробностей, каждая со ссылкой [n]"]}`;
      const content = await ask(prompt, 'chat-librarian');
      let a: LibrarianAnswer;
      try {
        a = librarianAnswer.parse(jsonOf(content));
      } catch {
        // Модель ответила не по схеме - её текст идёт в "коротко", форма ответа та же.
        a = { found: !!content.trim(), short: content.trim().slice(0, 600), details: [] };
      }
      return librarianText(a, passages);
    },
  };
}
