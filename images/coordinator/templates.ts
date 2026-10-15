// Шаблоны вывода фабрики: модель отдаёт данные по схеме, текст собирает код, поэтому в похожих
// случаях форма одна - разделы, порядок и объём. Новый случай - новый шаблон здесь, с тестом.
import { z } from 'zod';

// Задача нарезки. Сценарии приёмки - в форме Gherkin (Дано, Когда, Тогда), как приёмочные
// сценарии фабрики и сценарии требований OpenSpec; поле "тогда" - result (then у объекта
// делает его похожим на обещание).
export const taskSpec = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  scenarios: z
    .array(z.object({ name: z.string().min(1), given: z.string().optional(), when: z.string().min(1), result: z.string().min(1) }))
    .min(1),
  outOfScope: z.array(z.string()).default([]),
  basis: z.array(z.string()).default([]),
});
export type TaskSpec = z.infer<typeof taskSpec>;

const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`) : ['- нет']);

// Описание задачи в трекере: цель, сценарии приёмки, вне рамок, основания, откуда задача.
export function taskBody(t: TaskSpec, origin: string): string {
  const scenarios = t.scenarios.flatMap((s) => [
    `Сценарий: ${s.name}`,
    ...(s.given ? [`  Дано ${s.given}`] : []),
    `  Когда ${s.when}`,
    `  Тогда ${s.result}`,
  ]);
  return [
    'Цель',
    t.goal,
    '',
    'Сценарии приёмки',
    ...scenarios,
    '',
    'Вне рамок',
    ...list(t.outOfScope),
    '',
    'Основания',
    ...list(t.basis),
    '',
    'Откуда',
    origin,
  ].join('\n');
}

// Строка задачи в предложении нарезки (чат).
export function taskLine(t: TaskSpec, n: number): string {
  return `${n}. ${t.title} - ${t.goal} (сценариев приёмки: ${t.scenarios.length})`;
}

// Ответ библиотекаря: коротко, подробнее, источники; ссылки [n] - на источники.
export const librarianAnswer = z.object({
  found: z.boolean(),
  short: z.string(),
  details: z.array(z.string()).default([]),
});
export type LibrarianAnswer = z.infer<typeof librarianAnswer>;

export function librarianText(a: LibrarianAnswer, sources: { title: string; url: string }[]): string {
  return [
    `Коротко: ${a.found && a.short.trim() ? a.short.trim() : 'в знаниях проекта ответа нет.'}`,
    ...(a.found && a.details.length ? ['Подробнее:', ...a.details.slice(0, 5).map((d) => `- ${d}`)] : []),
    'Источники:',
    ...sources.map((s, i) => `[${i + 1}] ${s.title} - <${s.url}>`),
  ].join('\n');
}

// JSON из ответа модели: от первой "{" до последней "}".
export function jsonOf(content: string): unknown {
  return JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
}
