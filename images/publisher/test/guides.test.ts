import { describe, expect, it } from 'vitest';
import { agentSkill, checkFaithfulness, type Draft, judgeInput, peopleGuide, peopleRoles, sentences } from '../guides.ts';
import type { SourcePack } from '../sources.ts';

const pack: SourcePack = {
  version: 'v9',
  commands: [{ id: 'cmd:дейли', usage: '!дейли', what: 'что делает фабрика: задачи агентов, PR, решения, выкладка' }],
  tools: [{ id: 'tool:kb_search', name: 'kb_search', title: 'Поиск по знанию проекта', description: 'Отрывки правил со ссылками.' }],
  decisions: [{ id: 'decision:deploy', text: 'deploy - подтвердить выкладку' }],
  prep: [{ id: 'prep:3', text: 'У разработчиков подключён MCP фабрики (`http://127.0.0.1:4100/mcp`)' }],
  steps: [
    { id: 'step:14', n: '14', role: 'Project Manager', where: 'Discord', action: '`!дейли`, `!учёт`', result: 'сводка работы фабрики' },
    { id: 'step:5', n: '5', role: 'Агент фабрики', where: '', action: '(сам)', result: 'PR' },
  ],
  elements: [{ id: 'el:factory', text: 'Фабрика ПО на ИИ: координирует работу' }],
};
const facts = [
  { id: 'step:14', text: 'Project Manager, Discord: `!дейли`, `!учёт` -> сводка работы фабрики' },
  { id: 'cmd:дейли', text: '!дейли - что делает фабрика: задачи агентов, PR, решения, выкладка' },
];
const draft: Draft = {
  roles: [
    {
      role: 'Project Manager',
      intro: [{ text: 'Project Manager смотрит сводку работы фабрики.', sources: ['step:14'] }],
      howto: [
        { title: 'Как узнать, что делает фабрика', steps: [{ text: 'Наберите `!дейли` в Discord.', sources: ['step:14', 'cmd:дейли'] }] },
      ],
    },
  ],
};

describe('верность руководства источнику', () => {
  const ok = [
    { id: 'r0.i0', verdict: 'supported' as const, quotes: [{ source: 'step:14', quote: 'сводка работы фабрики' }] },
    {
      id: 'r0.h0.s0',
      verdict: 'supported' as const,
      quotes: [
        { source: 'step:14', quote: 'Project Manager, Discord: `!дейли`' },
        { source: 'cmd:дейли', quote: 'что делает фабрика' },
      ],
    },
  ];

  it('подтверждено с цитатами из указанных фактов - ошибок нет', () => {
    expect(sentences(draft).map((x) => x.id)).toEqual(['r0.i0', 'r0.h0.s0']);
    expect(checkFaithfulness(draft, facts, ok)).toEqual([]);
  });

  it('придуманная цитата, вердикт против, нет вердикта, неизвестный факт - всё ошибки', () => {
    const invented = { ...ok[1]!, quotes: [{ source: 'step:14', quote: 'фабрика сама всё сделает' }] };
    expect(checkFaithfulness(draft, facts, [ok[0]!, invented])[0]?.reason).toMatch(/цитаты/);
    // цитата из факта, на который предложение не ссылается, - не основание
    const foreign = { ...ok[0]!, quotes: [{ source: 'cmd:дейли', quote: 'что делает фабрика' }] };
    expect(checkFaithfulness(draft, facts, [foreign, ok[1]!])[0]?.reason).toMatch(/cmd:дейли/);
    expect(checkFaithfulness(draft, facts, [{ ...ok[0]!, quotes: [] }, ok[1]!])[0]?.reason).toMatch(/не привёл/);
    expect(checkFaithfulness(draft, facts, [ok[0]!, { ...ok[1]!, verdict: 'unsupported', why: 'нет в фактах' }])[0]?.reason).toMatch(
      /unsupported/,
    );
    expect(checkFaithfulness(draft, facts, [ok[0]!])[0]?.reason).toMatch(/вердикт/);
    const bad: Draft = { roles: [{ ...draft.roles[0]!, intro: [{ text: 'x', sources: ['step:99'] }] }] };
    expect(checkFaithfulness(bad, facts, ok)[0]?.reason).toMatch(/неизвестные/);
  });

  it('судья получает каждое предложение вместе с его фактами', () => {
    expect(judgeInput(draft, facts)[1]?.facts.map((f) => f.id)).toEqual(['step:14', 'cmd:дейли']);
  });
});

describe('сборка руководств', () => {
  it('роли - только люди сценария', () => {
    expect(peopleRoles(pack)).toEqual(['Project Manager']);
  });

  it('руководство людям: версия, роли с основаниями, справочник таблицами', () => {
    const md = peopleGuide(pack, draft, pack.elements[0], { id: 'bot:about', text: 'Я бот фабрики.' });
    expect(md).toMatch(/версия источника v9/);
    expect(md).toMatch(/### Project Manager\n\nProject Manager смотрит сводку/);
    expect(md).toMatch(/1\. Наберите `!дейли` в Discord\./);
    expect(md).toMatch(/Основания: шаг 14, !дейли\./);
    expect(md).toMatch(/\| `!дейли` \| что делает фабрика/);
    expect(md).toMatch(/\| `kb_search` \| Поиск по знанию проекта - отрывки правил/);
  });

  it('навык агентам по стандарту Agent Skills: имя и описание в шапке', () => {
    const md = agentSkill(pack);
    expect(md).toMatch(/^---\nname: ai-factory\ndescription: .+\n---\n/);
    expect(md).toMatch(/## Подключение\n\nУ разработчиков подключён MCP фабрики/);
  });
});
