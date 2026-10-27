// Контрактные тесты портов: один набор для всех адаптеров. Адаптер считается
// заменяемым, только если проходит его целиком (заменяемость доказывает второй
// носитель, а не публичный API).

import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { diffViews } from '../diagrams.ts';
import {
  type Diagrams,
  type DiagramView,
  type Forge,
  type JobRunner,
  type JobState,
  type Knowledge,
  PortError,
  type Tracker,
  type Wiki,
} from '../ports.ts';

export interface TrackerFixture {
  tracker: Tracker;
  cleanup(): Promise<void>;
}

export interface ForgeFixture {
  forge: Forge;
  // Ветка с одним изменённым файлом и открытый PR из неё в ветку по умолчанию.
  openPull(): Promise<{ n: number; branch: string; file: string }>;
  // Ветка с одним изменённым файлом без PR.
  pushBranch(): Promise<{ branch: string; file: string }>;
  // Лёгкий тег на коммите; убирается в cleanup.
  tag(name: string, sha: string): Promise<void>;
  cleanup(): Promise<void>;
}

export interface JobsFixture {
  jobs: JobRunner;
  quick: string; // задание, которое быстро завершается успехом
  slow: string; // задание, которое идёт дольше теста и останавливается
  poll: { everyMs: number; forMs: number };
  cleanup(): Promise<void>;
}

// Корпус знаний, который фикстура кладёт в носитель до тестов.
export const KNOWLEDGE_DOCS: { path: string; text: string }[] = [
  {
    path: 'docs/adr/ADR-3-reproducible-draw.md',
    text: '# ADR-3. Результат воспроизводим из зерна\n\nЗерно фиксируется заранее, победителей выбирают детерминированно.\n\n## Последствия\n\nПовторный розыгрыш заново среди всех противоречит решению.\n',
  },
  { path: 'README.md', text: '# Розыгрыш призов\n\n## Правила\n\n- R1. Одна заявка от участника на розыгрыш.\n' },
];

export interface KnowledgeFixture {
  knowledge: Knowledge;
  cleanup(): Promise<void>;
}

const uniq = () => Math.random().toString(16).slice(2, 8);

async function rejectsNotFound(p: Promise<unknown>) {
  await assert.rejects(p, (e: unknown) => e instanceof PortError && e.code === 'not_found');
}

export function trackerContract(name: string, setup: () => Promise<TrackerFixture>) {
  describe(`трекер ${name}`, () => {
    let fx: TrackerFixture;
    let t: Tracker;
    beforeAll(async () => {
      fx = await setup();
      t = fx.tracker;
    });
    afterAll(async () => fx?.cleanup());

    it('исполнитель, плановая оценка и списанное время', async () => {
      const i = await t.createIssue({ title: `исполнитель ${uniq()}`, body: 'задача' });
      const me = await t.me();
      await t.assign(i.key, me);
      await t.estimate(i.key, 1.5);
      await t.logWork(i.key, 600, 'агент фабрики: 10 мин работы');
      const got = await t.getIssue(i.key);
      assert.equal(got.assignee, me);
      // Оценку носитель хранит полем или строкой описания; списанное время - если отдаёт его в задаче.
      assert.ok(got.estimateSeconds === 5400 || got.body.includes('Оценка: 1.5 ч'), 'нет оценки');
      if (got.spentSeconds !== undefined) assert.ok(got.spentSeconds >= 600);
    });

    it('название и описание задачи меняются', async () => {
      const i = await t.createIssue({ title: `было ${uniq()}`, body: 'старое описание' });
      await t.updateIssue(i.key, { title: 'стало', body: 'новое описание' });
      const got = await t.getIssue(i.key);
      assert.equal(got.title, 'стало');
      assert.equal(got.body, 'новое описание');
    });

    it('поиск по тексту задачи', async () => {
      const word = `zx${uniq()}`;
      const i = await t.createIssue({ title: `поиск ${uniq()}`, body: `описание со словом ${word}` });
      // Поиск носителя может отставать от записи (индекс Forgejo строится в очереди): ждём до 20 с.
      let found = false;
      for (let n = 0; n < 40 && !found; n++) {
        found = (await t.listIssues({ text: word, state: 'all' })).some((x) => x.key === i.key);
        if (!found) await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(found, `задача ${i.key} не найдена по слову ${word}`);
      assert.ok(
        (await t.listIssues({ text: `${word.slice(0, 6)}*`, state: 'all' })).some((x) => x.key === i.key),
        'нет поиска по началу слова',
      );
      assert.equal((await t.listIssues({ text: `zx${uniq()}`, state: 'all' })).length, 0);
    });

    it('созданная задача открыта и читается по ключу', async () => {
      const title = `задача ${uniq()}`;
      const made = await t.createIssue({ title, body: 'описание', labels: ['agent'] });
      assert.equal(made.state, 'open');
      const got = await t.getIssue(made.key);
      assert.equal(got.title, title);
      assert.equal(got.body, 'описание');
      assert.deepEqual(got.labels, ['agent']);
      assert.match(got.url, /^https?:\/\//);
    });

    it('нет задачи - ошибка not_found', async () => {
      await rejectsNotFound(t.getIssue('999999'));
    });

    it('список фильтруется по метке и состоянию', async () => {
      const label = `l-${uniq()}`;
      const a = await t.createIssue({ title: 'a', body: '', labels: [label] });
      const b = await t.createIssue({ title: 'b', body: '', labels: [label] });
      await t.createIssue({ title: 'c', body: '' });
      await t.close(b.key);
      const open = await t.listIssues({ label, state: 'open' });
      assert.deepEqual(
        open.map((i) => i.key),
        [a.key],
      );
      const all = await t.listIssues({ label, state: 'all' });
      assert.deepEqual(all.map((i) => i.key).sort(), [a.key, b.key].sort());
    });

    it('комментарий виден в списке комментариев', async () => {
      const i = await t.createIssue({ title: 'к', body: '' });
      await t.addComment(i.key, 'первый');
      const cs = await t.listComments(i.key);
      assert.deepEqual(
        cs.map((c) => c.body),
        ['первый'],
      );
      assert.ok(cs[0]?.author);
      assert.ok(!Number.isNaN(Date.parse(cs[0]?.createdAt ?? '')));
    });

    it('метку можно поставить и снять, даже если её ещё нет', async () => {
      const i = await t.createIssue({ title: 'м', body: '' });
      const label = `new-${uniq()}`;
      await t.addLabel(i.key, label);
      assert.deepEqual((await t.getIssue(i.key)).labels, [label]);
      await t.removeLabel(i.key, label);
      assert.deepEqual((await t.getIssue(i.key)).labels, []);
    });

    it('история меток: когда метку поставили', async () => {
      const i = await t.createIssue({ title: 'и', body: '' });
      await t.addLabel(i.key, 'agent');
      const ev = await t.labelEvents(i.key);
      const added = ev.find((e) => e.label === 'agent' && e.action === 'added');
      assert.ok(added);
      assert.ok(!Number.isNaN(Date.parse(added.at)));
      // Кто поставил и кто завёл - учётка носителя: по ней реестр ролей узнаёт роль.
      assert.ok(added.author, 'нет автора метки');
      assert.equal((await t.getIssue(i.key)).author, added.author);
      // Своя учётка порта: метки фабрики после её же проверки прав не проверяются второй раз.
      assert.equal(await t.me(), added.author);
    });

    it('задачу можно закрыть и открыть снова', async () => {
      const i = await t.createIssue({ title: 'з', body: '' });
      await t.close(i.key);
      assert.equal((await t.getIssue(i.key)).state, 'closed');
      await t.reopen(i.key);
      assert.equal((await t.getIssue(i.key)).state, 'open');
    });

    it('зависимость задачи видна в списке зависимостей', async () => {
      const a = await t.createIssue({ title: 'зав a', body: '' });
      const b = await t.createIssue({ title: 'зав b', body: '' });
      await t.linkDependency(b.key, a.key);
      assert.deepEqual(await t.listDependencies(b.key), [a.key]);
    });
  });
}

export function forgeContract(name: string, setup: () => Promise<ForgeFixture>) {
  describe(`хостинг ${name}`, () => {
    let fx: ForgeFixture;
    let f: Forge;
    let pr: { n: number; branch: string; file: string };
    beforeAll(async () => {
      fx = await setup();
      f = fx.forge;
      pr = await fx.openPull();
    });
    afterAll(async () => fx?.cleanup());

    it('репозиторий: адрес и ветка по умолчанию', async () => {
      const r = await f.repo();
      assert.match(r.webUrl, /^https?:\/\//);
      assert.ok(r.defaultBranch);
      assert.ok(await f.branchHead(r.defaultBranch));
    });

    it('нет ветки - голова не определена', async () => {
      assert.equal(await f.branchHead(`no-${uniq()}`), undefined);
    });

    it('открытый PR: ветки, голова и поиск по ветке', async () => {
      const p = await f.getPull(pr.n);
      const r = await f.repo();
      assert.equal(p.state, 'open');
      assert.equal(p.sourceBranch, pr.branch);
      assert.equal(p.targetBranch, r.defaultBranch);
      assert.equal(p.headSha, await f.branchHead(pr.branch));
      assert.equal((await f.findPullByBranch(pr.branch))?.number, pr.n);
      assert.equal(await f.findPullByBranch(`no-${uniq()}`), undefined);
      assert.ok((await f.listPulls({ state: 'open' })).some((x) => x.number === pr.n));
    });

    it('тег виден с коммитом', async () => {
      const head = (await f.branchHead((await f.repo()).defaultBranch)) ?? '';
      const name = `v0.0.${Date.now()}`;
      await fx.tag(name, head);
      assert.deepEqual(
        (await f.tags()).find((t) => t.name === name),
        { name, sha: head },
      );
    });

    it('коммиты между двумя точками', async () => {
      const base = (await f.branchHead((await f.repo()).defaultBranch)) ?? '';
      const b = await fx.pushBranch();
      const head = (await f.branchHead(b.branch)) ?? '';
      const between = await f.commits(base, head);
      assert.deepEqual(
        between.map((c) => c.sha),
        [head],
      );
      assert.match(between[0]?.message ?? '', new RegExp(b.file.replace(/[.]/g, '[.]')));
      const all = (await f.commits(undefined, head)).map((c) => c.sha);
      assert.ok(all.includes(head) && all.includes(base));
      assert.equal(all.at(-1), head, 'коммиты - от старых к новым');
    });

    it('PR открывается из ветки', async () => {
      const b = await fx.pushBranch();
      const base = (await f.repo()).defaultBranch;
      const p = await f.openPull({ title: 'порт открыл PR', body: 'описание PR', head: b.branch, base });
      assert.equal(p.state, 'open');
      assert.equal(p.title, 'порт открыл PR');
      assert.equal(p.sourceBranch, b.branch);
      assert.equal(p.targetBranch, base);
      assert.equal(p.headSha, await f.branchHead(b.branch));
      assert.equal((await f.getPull(p.number)).body, 'описание PR');
    });

    it('нет PR - ошибка not_found', async () => {
      await rejectsNotFound(f.getPull(999999));
    });

    it('коммиты и дифф PR', async () => {
      const p = await f.getPull(pr.n);
      const cs = await f.pullCommits(pr.n);
      assert.ok(cs.some((c) => c.sha === p.headSha));
      assert.ok(!Number.isNaN(Date.parse(await f.commitDate(p.headSha))));
      assert.ok((await f.pullDiff(pr.n)).includes(pr.file));
      assert.ok(Array.isArray(await f.pullReviews(pr.n)));
    });

    it('комментарий к PR виден в списке', async () => {
      await f.commentPull(pr.n, 'замечание ревьюера');
      assert.ok((await f.listPullComments(pr.n)).some((c) => c.body === 'замечание ревьюера'));
    });

    it('статус коммита: последний по ключу побеждает', async () => {
      const sha = (await f.getPull(pr.n)).headSha;
      await f.setStatus(sha, { key: 'factory/gate', state: 'pending', description: 'идёт' });
      await f.setStatus(sha, { key: 'factory/gate', state: 'success', description: 'готово' });
      const st = (await f.statuses(sha)).filter((s) => s.key === 'factory/gate');
      assert.deepEqual(
        st.map((s) => s.state),
        ['success'],
      );
    });

    it('обязательные проверки ветки - список', async () => {
      assert.ok(Array.isArray(await f.requiredChecks((await f.repo()).defaultBranch)));
    });

    it('черновик PR - туда и обратно, повтор без второго эффекта (носитель без черновиков - пропуск)', async () => {
      if (!f.setDraft) return;
      await f.setDraft(pr.n, true);
      await f.setDraft(pr.n, true);
      assert.equal((await f.getPull(pr.n)).draft, true);
      await f.setDraft(pr.n, false);
      assert.equal(Boolean((await f.getPull(pr.n)).draft), false);
    });
  });
}

export function jobsContract(name: string, setup: () => Promise<JobsFixture>) {
  describe(`исполнитель заданий ${name}`, () => {
    let fx: JobsFixture;
    let j: JobRunner;
    beforeAll(async () => {
      fx = await setup();
      j = fx.jobs;
    });
    afterAll(async () => fx?.cleanup());

    const until = async (id: string, want: JobState) => {
      const end = Date.now() + fx.poll.forMs;
      let state: JobState = 'pending';
      while (Date.now() < end) {
        state = (await j.get(id)).state;
        if (state === want) return;
        await new Promise((r) => setTimeout(r, fx.poll.everyMs));
      }
      assert.fail(`задание ${id}: ждали ${want}, сейчас ${state}`);
    };

    // Живой исполнитель ждёт раннер и образ шага: тесту - до пяти минут.
    const LONG = 300_000;

    it(
      'задание с переменными и секретами доходит до успеха',
      async () => {
        const job = await j.start({ job: fx.quick, variables: { FACTORY_CONTRACT: uniq() }, secrets: { FACTORY_SECRET: uniq() } });
        assert.ok(job.id);
        assert.ok(job.url);
        assert.ok(['pending', 'running'].includes(job.state));
        await until(job.id, 'success');
        assert.equal((await j.get(job.id)).url, job.url);
      },
      LONG,
    );

    // Остановка идущего задания. Задание, остановленное до старта шага, Bitbucket
    // завершает ошибкой, а не остановкой, - это вне контракта.
    it(
      'остановленное идущее задание - stopped',
      async () => {
        const job = await j.start({ job: fx.slow });
        await until(job.id, 'running');
        await j.stop(job.id);
        await until(job.id, 'stopped');
      },
      LONG,
    );

    it('нет задания - ошибка not_found', async () => {
      await rejectsNotFound(j.get('{00000000-0000-4000-8000-000000000000}'));
    });
  });
}

export function knowledgeContract(name: string, setup: () => Promise<KnowledgeFixture>) {
  describe(`база знаний ${name}`, () => {
    let fx: KnowledgeFixture;
    let k: Knowledge;
    beforeAll(async () => {
      fx = await setup();
      k = fx.knowledge;
    });
    afterAll(async () => fx?.cleanup());

    it('находит отрывок с источником и ссылкой', async () => {
      const [p] = await k.search('повторный розыгрыш заново');
      assert.ok(p, 'нет отрывка');
      assert.equal(p.source, 'docs/adr/ADR-3-reproducible-draw.md');
      assert.match(p.text, /заново среди всех/);
      assert.ok(p.title);
      assert.match(p.url, /^https?:\/\//);
    });

    it('без совпадений - пусто', async () => {
      assert.deepEqual(await k.search('квантовая гравитация'), []);
    });

    it('предел числа отрывков соблюдается', async () => {
      assert.equal((await k.search('розыгрыш зерно заявка', 1)).length, 1);
    });
  });
}

export interface WikiFixture {
  wiki: Wiki;
  cleanup(): Promise<void>; // удаляет страницы, созданные тестами
}

export function wikiContract(name: string, setup: () => Promise<WikiFixture>) {
  describe(`вики ${name}`, () => {
    let fx: WikiFixture;
    let w: Wiki;
    beforeAll(async () => {
      fx = await setup();
      w = fx.wiki;
    });
    afterAll(async () => fx?.cleanup());

    it('страница создаётся и обновляется по названию', async () => {
      const title = `Проверка фабрики ${uniq()}`;
      assert.equal(await w.getPage(title), undefined);
      const a = await w.upsertPage(title, '## Изменения\n- первое https://example.com/1\nабзац');
      assert.match(a.url, /^https?:\/\//);
      const b = await w.upsertPage(title, '## Изменения\n- второе');
      assert.equal(b.id, a.id);
      const p = await w.getPage(title);
      assert.equal(p?.id, a.id);
      assert.match(p?.body ?? '', /второе/);
      assert.doesNotMatch(p?.body ?? '', /первое/);
    });

    it('метка, поиск по метке и тексту, комментарий', async () => {
      const word = `zx${uniq()}`;
      const label = `fct-${uniq()}`;
      const a = await w.upsertPage(`Проверка фабрики ${uniq()}`, `Стори со словом ${word}`);
      await w.addLabel(a.id, label);
      await w.comment(a.id, 'комментарий фабрики');
      // Поиск носителя отстаёт от записи (индекс Confluence): ждём до 30 с, пока новая страница
      // не появится в обоих поисках. Поиск по тексту находит и прежние страницы песочницы, поэтому
      // непустой ответ - ещё не повод перестать ждать.
      const until = Date.now() + 30_000;
      let byLabel = await w.pagesByLabel(label);
      let byText = await w.search(`слово ${word}`);
      while (!(byLabel.some((p) => p.id === a.id) && byText.some((p) => p.id === a.id)) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000));
        byLabel = await w.pagesByLabel(label);
        byText = await w.search(`слово ${word}`);
      }
      assert.equal(byLabel[0]?.id, a.id);
      assert.ok((byLabel[0]?.version ?? 0) >= 1);
      // Автор текущей версии: по нему реестр ролей решает, можно ли отдать стори на сверку.
      assert.ok(byLabel[0]?.author, 'нет автора версии');
      assert.ok(
        byText.some((p) => p.id === a.id),
        'нет поиска по тексту',
      );
    }, 60_000);
  });
}

export interface DiagramsFixture {
  diagrams: Diagrams;
  cleanup(): Promise<void>; // убирает опубликованные тестами виды
}

// Вид с тем, что носители любят терять: кириллица, кавычки, обратная косая, перевод строки,
// точка, дефис и подчёркивание в идентификаторах, группа, связь без подписи, технология,
// контейнер и база внутри узла развёртывания.
export function sampleView(id: string, version = 'v1'): DiagramView {
  return {
    id,
    title: 'Проверка: контекст "фабрики"',
    version,
    nodes: [
      { id: '@gr1', kind: '@group', title: 'Предмет демо' },
      {
        id: 'factory',
        kind: 'system',
        title: 'Фабрика ПО на ИИ',
        description: 'Координирует работу;\nпроверяет "стражами" & правилами',
        parent: '@gr1',
        box: { x: 0, y: 0, width: 320, height: 180 },
      },
      { id: 'target', kind: 'system', title: 'Цель (демо)', parent: '@gr1' },
      { id: 'eng', kind: 'person', title: 'Инженеры', description: 'Архитектор, QA' },
      { id: 'ext.jira', kind: 'external', title: 'Jira' },
      { id: 'my_kb-1', kind: 'external', title: 'База знаний \\ индекс' },
      { id: 'stand', kind: 'node', title: 'compose: factory', technology: 'Docker' },
      {
        id: 'stand.mcp',
        kind: 'container',
        title: 'MCP фабрики и бот',
        technology: 'TypeScript, MCP',
        description: 'MCP для экзокортексов;\nбот Discord',
        parent: 'stand',
      },
      { id: 'stand.kb', kind: 'database', title: 'База знаний', technology: 'PostgreSQL; Onyx на переходе', parent: 'stand' },
    ],
    edges: [
      { source: 'eng', target: 'factory', label: 'работают через MCP, правила' },
      { source: 'factory', target: 'ext.jira', label: 'читает и ведёт задачи' },
      { source: 'factory', target: 'my_kb-1', label: 'ищет (индекс)' },
      { source: 'factory', target: 'target' },
      { source: 'stand.mcp', target: 'stand.kb', label: 'поиск' },
    ],
  };
}

// Носитель показывает то же, что опубликовано: узлы, подписи, группы, связи и версию.
function assertSame(model: DiagramView, shown: DiagramView | undefined) {
  assert.ok(shown, 'вид не прочитан');
  assert.equal(shown.id, model.id);
  assert.equal(shown.title, model.title);
  assert.deepEqual(diffViews(model, shown), { added: [], removed: [], changed: [], edgesAdded: [], edgesRemoved: [] });
}

// Последовательность с тем, что носители любят терять: перевод строки в имени участника, вызов
// себя, ответ, заметка, связь без подписи, ветки alt, loop и par.
export function sampleSequence(id: string, version = 'v1'): DiagramView {
  return {
    id,
    title: 'Проверка: сценарий "задача -> слияние"',
    version,
    nodes: [
      { id: 'eng.dev', kind: 'person', title: 'Разработчик\n(оркестратор)' },
      { id: 'exo', kind: 'external', title: 'Экзокортекс' },
      { id: 'factory.mcp', kind: 'container', title: 'MCP фабрики' },
      { id: 'factory.cd', kind: 'container', title: 'Выкладка' },
      { id: 'github.repo', kind: 'external', title: 'GitHub' },
    ],
    edges: [
      { source: 'eng.dev', target: 'exo', label: 'беру задачу DRAW-12' },
      { source: 'exo', target: 'factory.mcp', label: 'контекст задачи' },
      { source: 'factory.mcp', target: 'exo', label: 'требования; ссылки: ADR-3, "DRAW-7"' },
      { source: 'eng.dev', target: 'github.repo', label: 'PR спецификации', note: 'HITL: замысел' },
      { source: 'eng.dev', target: 'github.repo', label: 'замечания' },
      { source: 'eng.dev', target: 'github.repo', label: 'одобрение и слияние' },
      { source: 'factory.cd', target: 'factory.cd', label: 'тянет образ' },
      { source: 'factory.cd', target: 'exo', label: 'готово' },
      { source: 'exo', target: 'github.repo' },
    ],
    flow: [
      0,
      1,
      2,
      3,
      {
        kind: 'alt',
        branches: [
          { title: 'доработать', flow: [4] },
          { title: 'принять', flow: [5] },
        ],
      },
      { kind: 'loop', title: 'пока стенд не ответит', flow: [6] },
      { kind: 'par', flow: [7, 8] },
    ],
  };
}

export function diagramsContract(name: string, setup: () => Promise<DiagramsFixture>, opts: { sequence?: boolean } = {}) {
  describe(`схемы ${name}`, () => {
    let fx: DiagramsFixture;
    let d: Diagrams;
    beforeAll(async () => {
      fx = await setup();
      d = fx.diagrams;
    });
    afterAll(async () => fx?.cleanup());

    it('вид читается обратно тем же: узлы, подписи, группы, связи, версия', async () => {
      const v = sampleView(`contract-${uniq()}`);
      const { url } = await d.publish(v);
      assert.ok(url);
      assertSame(v, await d.read(v.id));
    });

    it('повторная публикация заменяет вид на месте', async () => {
      const v = sampleView(`contract-${uniq()}`);
      await d.publish(v);
      const next: DiagramView = {
        ...v,
        version: 'v2',
        title: 'Проверка: после правки',
        nodes: v.nodes.filter((n) => n.id !== 'target').map((n) => (n.id === 'eng' ? { ...n, title: 'Инженеры и QA' } : n)),
        edges: [...v.edges.filter((e) => e.target !== 'target'), { source: 'eng', target: 'ext.jira', label: 'смотрят задачи' }],
      };
      await d.publish(next);
      assertSame(next, await d.read(v.id));
    });

    it('неизвестный вид - пусто', async () => {
      assert.equal(await d.read(`missing-${uniq()}`), undefined);
    });

    if (opts.sequence)
      it('последовательность читается обратно той же: участники, шаги по порядку, заметки, блоки', async () => {
        const v = sampleSequence(`contract-${uniq()}`);
        await d.publish(v);
        assertSame(v, await d.read(v.id));
      });
  });
}
