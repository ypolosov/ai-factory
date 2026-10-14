// Согласование требования со знаниями (UC1): стори с меткой-триггером -> поиск по базе знаний ->
// судья -> противоречие: задача на решение человеку, стори ждёт; решение принято (задача
// закрыта) -> повторная сверка с обновлённым знанием -> стори согласована.
import type { Knowledge, Notifier, Tracker } from '../ports/ports.ts';
import type { Judge, Judgement, Statement } from './judge.ts';

export interface StoryLabels {
  trigger: string; // стори ждёт сверки
  checking: string;
  ok: string; // согласована со знаниями
  conflict: string; // ждёт решения человека
  decision: string; // задача на решение
}

export interface StoryDeps {
  tracker: Tracker;
  knowledge: Knowledge;
  refreshKnowledge(): Promise<void>; // знание - из вершины ветки по умолчанию
  judge: Judge;
  notifier: Notifier;
  labels: StoryLabels;
}

const relabel = async (d: StoryDeps, issue: string, from: string[], to: string) => {
  for (const l of from) await d.tracker.removeLabel(issue, l);
  await d.tracker.addLabel(issue, to);
};

const links = (j: Judgement) =>
  j.conflicts.map((c) => `- ${c.source}: "${c.quote}" - ${c.why}\n  ${c.url}`).join('\n') ||
  j.checked.map((p) => `- ${p.source}: ${p.title} - ${p.url}`).join('\n');

export async function claimStory(d: StoryDeps, issue: string): Promise<Statement> {
  const i = await d.tracker.getIssue(issue);
  await relabel(d, issue, [d.labels.trigger], d.labels.checking);
  return { issue, title: i.title, body: i.body };
}

export async function judgeStory(d: StoryDeps, s: Statement): Promise<Judgement> {
  await d.refreshKnowledge();
  // Сама стори знанием о себе не считается.
  const passages = (await d.knowledge.search(`${s.title}\n${s.body}`, 9)).filter((p) => p.source !== s.issue).slice(0, 8);
  return d.judge.check(s, passages);
}

// Противоречие -> задача на решение со ссылками на обе стороны; стори зависит от неё.
export async function escalate(d: StoryDeps, s: Statement, j: Judgement): Promise<string> {
  const sources = [...new Set(j.conflicts.map((c) => c.source.split('/').pop()?.replace(/\.md$/, '')))].join(', ');
  const task = await d.tracker.createIssue({
    title: `Решить противоречие: ${s.issue} и ${sources}`,
    body: `Требование ${s.issue} "${s.title}" противоречит знаниям проекта.\n\n${j.summary}\n\nПротиворечия:\n${links(j)}\n\nРешение - PR в правила или решения (ADR) либо изменение требования; закрытие этой задачи запускает повторную сверку.`,
    labels: [d.labels.decision],
  });
  await d.tracker.linkDependency(s.issue, task.key);
  await d.tracker.addComment(
    s.issue,
    `Сверщик фабрики: противоречие со знаниями проекта.\n${j.summary}\n${links(j)}\nЗадача на решение: ${task.key}`,
  );
  await relabel(d, s.issue, [d.labels.checking], d.labels.conflict);
  await d.notifier.post(`Противоречие: ${s.issue} "${s.title}" и ${sources}. Решение - в задаче ${task.key}: ${task.url}`);
  return task.key;
}

export async function report(
  d: StoryDeps,
  s: Statement,
  j: Judgement,
  afterDecision: string | undefined,
): Promise<{ result: 'ok' | 'conflict' | 'resolved'; detail: string }> {
  if (j.verdict === 'ok') {
    const head = afterDecision ? `Противоречие снято решением ${afterDecision}.` : 'Сверщик фабрики: противоречий со знаниями проекта нет.';
    await d.tracker.addComment(s.issue, `${head}\n${j.summary}\nСверено с:\n${links(j)}`);
    await relabel(d, s.issue, [d.labels.checking, d.labels.conflict], d.labels.ok);
    if (afterDecision) await d.notifier.post(`Согласовано: ${s.issue} "${s.title}" после решения ${afterDecision}.`);
    return { result: afterDecision ? 'resolved' : 'ok', detail: j.summary };
  }
  await d.tracker.addComment(s.issue, `Сверщик фабрики: после решения ${afterDecision} противоречие осталось.\n${j.summary}\n${links(j)}`);
  await relabel(d, s.issue, [d.labels.checking], d.labels.conflict);
  return { result: 'conflict', detail: j.summary };
}
