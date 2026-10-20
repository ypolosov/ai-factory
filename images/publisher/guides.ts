// Руководства "Как пользоваться фабрикой" из источника (sources.ts). Справочные разделы и навык
// для агентов собирает код; модель-писатель пишет только инструкции по ролям - данными по
// схеме, каждое предложение со ссылками на факты. Судья другого семейства моделей проверяет
// каждое предложение и приводит дословную цитату; код сверяет, что цитата есть в указанных
// фактах. Порог - ноль неподтверждённых: иначе руководство не собирается (FPF E.17.EFP, NSTD.6).
import { items, type SourceItem, type SourcePack } from './sources.ts';

export interface Sentence {
  text: string;
  sources: string[]; // идентификаторы фактов
}

export interface RoleGuide {
  role: string;
  intro: Sentence[];
  howto: { title: string; steps: Sentence[] }[];
}

export interface Draft {
  roles: RoleGuide[];
}

export interface Verdict {
  id: string;
  verdict: 'supported' | 'unsupported' | 'contradicted';
  quotes: { source: string; quote: string }[]; // дословно из указанного факта
  why?: string;
}

export interface Writer {
  write(facts: SourceItem[], roles: string[], fix?: { draft: Draft; failures: Failure[] }): Promise<Draft>;
}

export interface Judge {
  judge(sentences: { id: string; text: string; facts: SourceItem[] }[]): Promise<Verdict[]>;
}

// Роли руководства - люди из сценария; агенты, судья, самозванец и проверка владельца - не роли.
export const peopleRoles = (p: SourcePack) =>
  [...new Set(p.steps.map((s) => s.role))].filter((r) => r && !/^(Агент|Судья|Самозванец)/.test(r) && r !== 'Владелец');

// Предложения черновика с устойчивыми номерами: r0.i1, r0.h1.s2.
export function sentences(d: Draft): { id: string; s: Sentence }[] {
  return d.roles.flatMap((r, i) => [
    ...r.intro.map((s, j) => ({ id: `r${i}.i${j}`, s })),
    ...r.howto.flatMap((h, k) => h.steps.map((s, j) => ({ id: `r${i}.h${k}.s${j}`, s }))),
  ]);
}

const norm = (t: string) =>
  t
    .replace(/\s+/g, ' ')
    .replace(/[\u00ab\u00bb"]/g, '"')
    .trim()
    .toLowerCase();

export interface Failure {
  id: string;
  text: string;
  reason: string;
}

// Верность: каждое предложение ссылается на известные факты, судья его подтвердил, и каждая
// его цитата дословно есть в том указанном факте, из которого взята. Без цитаты не считается.
export function checkFaithfulness(d: Draft, facts: SourceItem[], verdicts: Verdict[]): Failure[] {
  const byId = new Map(facts.map((f) => [f.id, f.text]));
  const byVerdict = new Map(verdicts.map((v) => [v.id, v]));
  return sentences(d).flatMap(({ id, s }) => {
    const fail = (reason: string) => [{ id, text: s.text, reason }];
    const unknown = s.sources.filter((x) => !byId.has(x));
    if (!s.sources.length) return fail('нет ссылок на факты');
    if (unknown.length) return fail(`ссылки на неизвестные факты: ${unknown.join(', ')}`);
    const v = byVerdict.get(id);
    if (!v) return fail('судья не вынес вердикт');
    if (v.verdict !== 'supported') return fail(`судья: ${v.verdict}${v.why ? ` - ${v.why}` : ''}`);
    if (!v.quotes.length) return fail('судья не привёл цитату');
    const bad = v.quotes.find(
      (q) => !s.sources.includes(q.source) || !norm(byId.get(q.source) ?? '').includes(norm(q.quote)) || !norm(q.quote),
    );
    return bad ? fail(`цитаты судьи нет в факте ${bad.source}: "${bad.quote}"`) : [];
  });
}

const label = (id: string) => {
  const [kind, name] = id.split(':');
  return kind === 'step'
    ? `шаг ${name}`
    : kind === 'cmd'
      ? `!${name}`
      : kind === 'tool'
        ? `${name}`
        : kind === 'prep'
          ? `подготовка ${name}`
          : kind === 'el'
            ? `модель (${name})`
            : id;
};
// "Фабрика: Координирует работу" -> "Фабрика - координирует работу."
const sentence = (t: string) => {
  const [head, ...rest] = t.split(': ');
  const tail = rest.join(': ');
  return tail ? `${head} - ${tail.charAt(0).toLowerCase()}${tail.slice(1)}${/[.!?]$/.test(tail) ? '' : '.'}` : t;
};
const row = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;

// Руководство для людей: Diataxis внутри роли - коротко о фабрике (объяснение), подготовка и
// инструкции по ролям (как сделать), справочник (команды, инструменты, точки решения).
export function peopleGuide(p: SourcePack, d: Draft, factory: SourceItem | undefined, about: SourceItem): string {
  const out = [
    '# Как пользоваться фабрикой ПО на ИИ',
    '',
    `Собрано из модели и файлов фабрики, версия источника ${p.version}. Правка - в источнике, не здесь.`,
    '',
    '## Коротко',
    '',
    ...(factory ? [sentence(factory.text), ''] : []),
    about.text,
    '',
    '## Подготовка',
    '',
    ...p.prep.map((x, i) => `${i + 1}. ${x.text}`),
    '',
    '## По ролям',
  ];
  for (const r of d.roles) {
    out.push('', `### ${r.role}`, '', r.intro.map((s) => s.text).join(' '));
    for (const h of r.howto) out.push('', `**${h.title}**`, '', ...h.steps.map((s, i) => `${i + 1}. ${s.text}`));
    const refs = [...new Set([...r.intro, ...r.howto.flatMap((h) => h.steps)].flatMap((s) => s.sources))];
    out.push('', `Основания: ${refs.map(label).join(', ')}.`);
  }
  out.push('', '## Справочник', '', '### Команды бота в чате', '', '| Команда | Что делает |', '|---|---|');
  out.push(...p.commands.map((c) => row([`\`${c.usage}\``, c.what])));
  out.push('', '### Инструменты MCP фабрики', '', '| Инструмент | Что даёт |', '|---|---|');
  out.push(...p.tools.map((t) => row([`\`${t.name}\``, `${t.title} - ${t.description.charAt(0).toLowerCase()}${t.description.slice(1)}`])));
  out.push('', '### Точки решения ролей', '', 'Кто их принимает, задаёт реестр ролей цели `.factory/roles.yml`.', '');
  out.push(...p.decisions.map((x) => `- ${x.text}`), '');
  return out.join('\n');
}

// Навык для обвязок агентов (Agent Skills): что есть у фабрики и где правила. Только факты
// из кода фабрики и сценария - без модели.
export function agentSkill(p: SourcePack): string {
  const mcp = p.prep.find((x) => /MCP фабрики/.test(x.text));
  return [
    '---',
    'name: ai-factory',
    'description: Работа с фабрикой ПО на ИИ из обвязки агента - инструменты MCP фабрики (поиск по знанию проекта, сверка требования, правила стражей, передача задачи агенту фабрики). Брать, когда задача касается проекта, который ведёт фабрика.',
    '---',
    '',
    '# Фабрика ПО на ИИ для агента',
    '',
    `Собрано из кода фабрики, версия источника ${p.version}. Правка - в источнике, не здесь.`,
    '',
    ...(mcp ? ['## Подключение', '', mcp.text, ''] : []),
    '## Инструменты MCP фабрики',
    '',
    '| Инструмент | Что даёт |',
    '|---|---|',
    ...p.tools.map((t) => row([`\`${t.name}\``, `${t.title} - ${t.description.charAt(0).toLowerCase()}${t.description.slice(1)}`])),
    '',
    '## Что делают люди в чате',
    '',
    'Эти команды набирают люди в чате команды; агенту они нужны, чтобы понимать, откуда приходят задачи и решения.',
    '',
    ...p.commands.map((c) => `- \`${c.usage}\` - ${c.what}`),
    '',
  ].join('\n');
}

export const draftSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['roles'],
  properties: {
    roles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'intro', 'howto'],
        properties: {
          role: { type: 'string' },
          intro: { type: 'array', items: { $ref: '#/$defs/sentence' } },
          howto: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'steps'],
              properties: { title: { type: 'string' }, steps: { type: 'array', items: { $ref: '#/$defs/sentence' } } },
            },
          },
        },
      },
    },
  },
  $defs: {
    sentence: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'sources'],
      properties: { text: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } },
    },
  },
};

export const verdictSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'quotes', 'why'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['supported', 'unsupported', 'contradicted'] },
          quotes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['source', 'quote'],
              properties: { source: { type: 'string' }, quote: { type: 'string' } },
            },
          },
          why: { type: 'string' },
        },
      },
    },
  },
};

const factsText = (facts: SourceItem[]) => facts.map((f) => `[${f.id}] ${f.text}`).join('\n');

export function writerPrompt(facts: SourceItem[], roles: string[], fix?: { draft: Draft; failures: Failure[] }): string {
  const repair = fix
    ? [
        'Судья не подтвердил предложения ниже. Перепиши только их: убери то, чего нет в фактах, или удали предложение; остальное верни без изменений.',
        ...fix.failures.map((f) => `- ${f.id}: ${f.text} (${f.reason})`),
        'Прошлый черновик (номера: r<роль>.i<вступление>, r<роль>.h<инструкция>.s<шаг>):',
        JSON.stringify(fix.draft),
        '',
      ]
    : [];
  return [
    ...repair,
    'Ты пишешь раздел "По ролям" руководства "Как пользоваться фабрикой ПО на ИИ" для людей команды.',
    `Роли, ровно в этом порядке: ${roles.join('; ')}.`,
    'Для каждой роли: intro - одно-два предложения, что эта роль делает через фабрику; howto - одна-три инструкции с заголовком "Как ..." и шагами в повелительном наклонении.',
    'Правила:',
    '- используй только факты из списка ниже; не добавляй фактов, оценок, обещаний и советов, которых в них нет;',
    '- каждое предложение - одно утверждение; в sources - идентификаторы фактов, из которых оно следует;',
    '- не обобщай и не достраивай: без "каждый", "всегда", "сам", кто что предложил и где это видно, если этого нет в фактах;',
    '- команды, метки, имена каналов и инструментов пиши так же, как в фактах;',
    '- по-русски, просто; только символы с клавиатуры: без эмодзи, длинных тире, кавычек-ёлочек и стрелок.',
    '',
    'Факты:',
    factsText(facts),
  ].join('\n');
}

export function judgePrompt(list: { id: string; text: string; facts: SourceItem[] }[]): string {
  return [
    'Ты судья верности текста источнику. Для каждого предложения реши по его фактам:',
    '- supported - всё сказанное следует из фактов;',
    '- unsupported - есть утверждение, которого в фактах нет (даже правдоподобное);',
    '- contradicted - противоречит фактам.',
    'quotes - дословные цитаты, на которых держится вердикт: для каждой - идентификатор факта (source) и кусок его текста как есть (quote), без префикса [id]; для supported обязательна хотя бы одна; why - коротко почему.',
    'Не придумывай и не склеивай цитаты: одна цитата - один кусок одного факта.',
    '',
    ...list.flatMap((x) => [`## ${x.id}`, `Предложение: ${x.text}`, 'Факты:', factsText(x.facts), '']),
  ].join('\n');
}

export function judgeInput(d: Draft, facts: SourceItem[]) {
  const byId = new Map(facts.map((f) => [f.id, f]));
  return sentences(d).map(({ id, s }) => ({ id, text: s.text, facts: s.sources.flatMap((x) => byId.get(x) ?? []) }));
}

export { items };
