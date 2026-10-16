// Режиссёр видео-демо: шаги сценария съёмки выполняют участники через API под своими учётками
// (у ИИ-персонажа - бот Discord, учётка Atlassian и приложение GitHub), итог шага ждётся по
// наблюдаемому признаку, камера - Playwright без окна - снимает экран браузера участника с его
// плашкой. Шаг с do.decision называет команду, которую человек выполняет вживую, и ждёт её итога.
// Ключи - из каталога состояния (только чтение); в журнал, манифест и клипы они не попадают.
// Использование: node film.ts СЦЕНАРИЙ.yml КАТАЛОГ_КЛИПОВ [--only шаг,шаг] [--ctx МАНИФЕСТ] [--state /state]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { parse } from 'yaml';
import { selectForge, selectTracker, selectWiki } from '../ports/select.ts';
import { persona as githubPersona } from './github.ts';
import {
  applyEdit,
  badge,
  chapterHtml,
  checkFilm,
  FILM_LABEL,
  type Film,
  fill,
  nextVersion,
  parseEnv,
  type Step,
  snowflake,
  takeName,
} from './script.ts';

const API = 'https://discord.com/api/v10';
const [filmPath = '', out = ''] = process.argv.slice(2);
const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const state = flag('--state') ?? '/state';
const only = flag('--only')?.split(',');
const film = parse(readFileSync(filmPath, 'utf8')) as Film;
const env = (name: string) => parseEnv(readFileSync(join(state, name), 'utf8'));
const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Atlassian: учётка фабрики (ожидание итогов) и учётки участников (действия под своим именем):
// .state/atlassian.env и .state/atlassian-<персонаж>.env.
const atlassian = (file: string) => {
  const a = env(file);
  return {
    tracker: selectTracker({
      kind: 'jira',
      site: a.ATLASSIAN_SITE ?? '',
      email: a.ATLASSIAN_EMAIL ?? '',
      token: a.JIRA_API_TOKEN ?? '',
      project: a.JIRA_PROJECT ?? '',
    }),
    wiki: a.CONFLUENCE_API_TOKEN
      ? selectWiki({
          kind: 'confluence',
          site: a.ATLASSIAN_SITE ?? '',
          email: a.ATLASSIAN_EMAIL ?? '',
          token: a.CONFLUENCE_API_TOKEN,
          space: a.CONFLUENCE_SPACE ?? '',
        })
      : undefined,
  };
};
const factory = atlassian(existsSync(join(state, 'atlassian-factory.env')) ? 'atlassian-factory.env' : 'atlassian.env');
const tracker = factory.tracker;
const accounts = new Map<string, ReturnType<typeof atlassian>>();
// Учётка, под которой действует участник: своя, если заведена, иначе - фабрики.
const as = (who: string) => {
  const id = film.personas[who]?.atlassian;
  if (!id || !existsSync(join(state, `atlassian-${id}.env`))) return factory;
  if (!accounts.has(id)) accounts.set(id, atlassian(`atlassian-${id}.env`));
  return accounts.get(id) ?? factory;
};

// GitHub: итоги (PR, статусы) читаются токеном фабрики на чтение, персонаж действует своим приложением.
const githubTarget = env('github-target.env');
const forge = selectForge({ kind: 'github', repo: githubTarget.GITHUB_TARGET_REPO ?? '', token: githubTarget.GITHUB_READ_TOKEN ?? '' });
const apps = new Map<string, ReturnType<typeof githubPersona>>();
const app = (who: string) => {
  const id = film.personas[who]?.github;
  if (!id) throw new Error(`у участника ${who} нет приложения GitHub`);
  if (!apps.has(id)) apps.set(id, githubPersona(state, id));
  return apps.get(id) as ReturnType<typeof githubPersona>;
};
const assetsDir = join(filmPath, '..', 'film-assets');
const asset = (name: string) => fill(readFileSync(join(assetsDir, name), 'utf8'), ctx);
// Сценарий проверяется до первого действия: ошибка в нём не оставит стенд на полпути.
const problems = checkFilm(film, (n) => existsSync(join(assetsDir, n)));
if (problems.length) throw new Error(`сценарий съёмки:\n${problems.join('\n')}`);

// Discord: бот фабрики читает ответы, бот персонажа пишет реплику.
const factoryToken = env('discord.env').DISCORD_BOT_TOKEN ?? '';
const personaToken = (id: string) => {
  const e = env(`discord-${id}.env`);
  return e.DISCORD_BOT_TOKEN ?? e[`DISCORD_${id.toUpperCase().replace(/-/g, '_')}_TOKEN`] ?? '';
};
async function discord<T>(token: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Discord ${path.split('?')[0]}: ${r.status}`);
  return (await r.json()) as T;
}
const factoryId = (await discord<{ id: string }>(factoryToken, '/users/@me')).id;
const guild = env('discord.env').DISCORD_GUILD_ID ?? '';
const channels = new Map(
  (await discord<{ id: string; name: string }[]>(factoryToken, `/guilds/${guild}/channels`)).map((c) => [c.name, c.id]),
);
const channelId = (name: string) => {
  const id = channels.get(name);
  if (!id) throw new Error(`нет канала ${name}`);
  return id;
};

// Итоги шагов для подстановок {шаг.поле}; {take} - имя дубля. Всё, что создаёт съёмка, получает
// метки film и имени дубля: прошлые дубли уводит в архив scripts/demo-reset.sh.
// --ctx МАНИФЕСТ продолжает прерванный дубль: итоги и имя дубля - из его манифеста, шаги - через --only.
const resumed = flag('--ctx')
  ? (JSON.parse(readFileSync(flag('--ctx') ?? '', 'utf8')) as { take: string; ctx: Record<string, unknown> })
  : undefined;
const take = resumed?.take ?? takeName(new Date(t0));
const ctx: Record<string, unknown> = { ...resumed?.ctx, take };
if (film.steps.some((s) => s.id === 'take')) throw new Error('шаг не может называться take');

// Реплика участника в Discord - его ботом; @factory - упоминание бота фабрики.
async function say(step: Step, did: Record<string, unknown>): Promise<void> {
  const d = step.do?.discord;
  const who = film.personas[step.who];
  if (!d) return;
  if (!who?.discord) throw new Error(`у участника ${step.who} нет бота Discord`);
  const text = fill(d.text, ctx).replaceAll('@factory', `<@${factoryId}>`);
  const m = await discord<{ id: string }>(personaToken(who.discord), `/channels/${channelId(d.channel)}/messages`, { content: text });
  did.message = { id: m.id, channel: d.channel };
  did.said = Date.now();
  log(`${step.id}: ${who.name} пишет в #${d.channel}`);
}

async function act(step: Step): Promise<void> {
  const did: Record<string, unknown> = { since: Date.now() };
  ctx[step.id] = did;
  const d = step.do;
  if (!d) return;
  if (d.discord) await say(step, did);
  if (d.wiki) {
    const wiki = as(step.who).wiki ?? factory.wiki;
    if (!wiki) throw new Error(`у участника ${step.who} нет учётки Confluence`);
    const page = await wiki.upsertPage(fill(d.wiki.title, ctx), fill(d.wiki.body, ctx));
    for (const l of [FILM_LABEL, take, d.wiki.label]) if (l) await wiki.addLabel(page.id, l);
    did.page = page;
    log(`${step.id}: страница ${page.url}`);
  }
  if (d.label) {
    await as(step.who).tracker.addLabel(fill(d.label.key, ctx), d.label.label);
    log(`${step.id}: метка ${d.label.label} на ${fill(d.label.key, ctx)}`);
  }
  if (d.comment) {
    await as(step.who).tracker.addComment(fill(d.comment.key, ctx), fill(d.comment.text, ctx));
    log(`${step.id}: комментарий на ${fill(d.comment.key, ctx)}`);
  }
  if (d.assign) {
    const who = film.personas[d.assign.to];
    if (!who?.jira) throw new Error(`у участника ${d.assign.to} нет учётки Jira`);
    await as(step.who).tracker.assign(fill(d.assign.key, ctx), who.jira);
    log(`${step.id}: ${fill(d.assign.key, ctx)} - исполнитель ${who.name}`);
  }
  if (d.logWork) {
    await as(step.who).tracker.logWork(fill(d.logWork.key, ctx), d.logWork.minutes * 60, fill(d.logWork.comment, ctx));
    log(`${step.id}: списано ${d.logWork.minutes} мин на ${fill(d.logWork.key, ctx)}`);
  }
  if (d.github?.pr) {
    const p = d.github.pr;
    const gh = app(step.who);
    const base = p.base ?? 'main';
    const files: Record<string, string> = {};
    for (const e of p.files) {
      const path = fill(e.path, ctx);
      const edit = {
        path,
        ...(e.from ? { from: e.from } : {}),
        ...(e.replace ? { replace: e.replace.map((r) => ({ find: fill(r.find, ctx), with: fill(r.with, ctx) })) } : {}),
        ...(e.append !== undefined ? { append: fill(e.append, ctx) } : {}),
      };
      files[path] = applyEdit(await gh.read(path, base), edit, asset);
    }
    const pr = await gh.openPull({ base, branch: fill(p.branch, ctx), title: fill(p.title, ctx), body: fill(p.body, ctx), files });
    did.pr = pr;
    log(`${step.id}: ${gh.slug} открыл PR ${pr.number}: ${pr.url}`);
  }
  if (d.github?.merge) {
    const n = Number(fill(d.github.merge.pr, ctx));
    await app(step.who).merge(n, fill(d.github.merge.title, ctx));
    log(`${step.id}: PR ${n} слит`);
  }
  if (d.github?.comment) {
    const n = Number(fill(d.github.comment.pr, ctx));
    await app(step.who).comment(n, fill(d.github.comment.text, ctx));
    log(`${step.id}: замечание в PR ${n}`);
  }
  if (d.github?.closePr) {
    const n = Number(fill(d.github.closePr.pr, ctx));
    await app(step.who).closePull(n);
    log(`${step.id}: PR ${n} закрыт без слияния`);
  }
  if (d.github?.tag) {
    const name = nextVersion(
      (await forge.tags()).map((x) => x.name),
      d.github.tag.bump,
    );
    did.tag = name;
    did.sha = await app(step.who).tag(name);
    log(`${step.id}: тег ${name}`);
  }
  if (d.http) {
    const r = await fetch(fill(d.http.url, ctx), {
      method: d.http.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      body: d.http.body === undefined ? undefined : fill(JSON.stringify(d.http.body), ctx),
    });
    const text = await r.text();
    did.status = r.status;
    try {
      did.json = JSON.parse(text);
    } catch {
      did.json = text.slice(0, 500);
    }
    log(`${step.id}: ${d.http.method ?? 'GET'} ${fill(d.http.url, ctx)} - ${r.status}`);
  }
  if (d.webhook) {
    // Вебхук без учётки: самозванец пишет от чужого имени. Вебхук канала заводит бот фабрики.
    const ch = channelId(d.webhook.channel);
    const hooks = await discord<{ id: string; token?: string; name: string }[]>(factoryToken, `/channels/${ch}/webhooks`);
    const hook =
      hooks.find((h) => h.name === 'film-webhook' && h.token) ??
      (await discord<{ id: string; token: string; name: string }>(factoryToken, `/channels/${ch}/webhooks`, { name: 'film-webhook' }));
    const r = await fetch(`${API}/webhooks/${hook.id}/${hook.token}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: fill(d.webhook.text, ctx), username: d.webhook.username }),
    });
    if (!r.ok) throw new Error(`Discord вебхук: ${r.status}`);
    did.message = { id: ((await r.json()) as { id: string }).id, channel: d.webhook.channel };
    log(`${step.id}: вебхук "${d.webhook.username}" пишет в #${d.webhook.channel}`);
  }
  // Задача закрывается после PR: закрытие задачи на решение запускает повторную сверку, и она
  // должна видеть уже слитое решение.
  if (d.close) {
    await as(step.who).tracker.close(fill(d.close.key, ctx));
    log(`${step.id}: ${fill(d.close.key, ctx)} закрыта`);
  }
  if (d.decision) log(`${step.id}: РЕШЕНИЕ ЧЕЛОВЕКА - ${fill(d.decision, ctx)}`);
}

const anyOf = (labels: string[], want: string) => want.split('|').some((l) => labels.includes(l));
const seen = async (key: string) => {
  for (const l of [FILM_LABEL, take]) await tracker.addLabel(key, l);
};

// Задача Jira, которой ждёт шаг: найдена - в итог шага (issue, а для deps - ещё issues).
async function jiraDone(w: NonNullable<NonNullable<Step['wait']>['jira']>, did: Record<string, unknown>): Promise<boolean> {
  const label = w.label ? fill(w.label, ctx) : undefined;
  const hasComment = async (key: string) =>
    !w.comment || (await tracker.listComments(key)).some((c) => c.body.includes(fill(w.comment ?? '', ctx)));
  let found: { key: string; url: string; title: string }[] = [];
  // Все зависимости задачи (deps), не только отобранные: сброс стенда закроет и остальные задачи нарезки.
  const deps: string[] = [];
  if (w.key) {
    const i = await tracker.getIssue(fill(w.key, ctx));
    if ((!label || anyOf(i.labels, label)) && (await hasComment(i.key))) found = [i];
  } else if (w.deps) {
    const match = w.match ? new RegExp(fill(w.match, ctx), 'i') : undefined;
    for (const k of await tracker.listDependencies(fill(w.deps, ctx))) {
      deps.push(k);
      const i = await tracker.getIssue(k);
      if ((!label || anyOf(i.labels, label)) && (!match || match.test(i.title)) && (await hasComment(i.key))) found.push(i);
    }
    if (found.length < (w.count ?? 1)) found = [];
  } else if (label) {
    const [i] = await tracker.listIssues({ label, state: w.open ? 'open' : 'all', limit: 1 });
    if (i && (await hasComment(i.key))) found = [i];
  }
  if (!found.length) return false;
  for (const k of new Set([...found.map((i) => i.key), ...deps])) await seen(k);
  did.issue = { key: found[0]?.key, url: found[0]?.url, title: found[0]?.title };
  if (w.deps) did.issues = found.map((i) => ({ key: i.key, url: i.url, title: i.title }));
  return true;
}

// PR, которого ждёт шаг: по номеру или по началу имени ветки; со статусом - когда статус готов.
async function githubDone(w: NonNullable<NonNullable<Step['wait']>['github']>, did: Record<string, unknown>): Promise<boolean> {
  const head = w.head ? fill(w.head, ctx) : undefined;
  const p = w.pr
    ? await forge.getPull(Number(fill(w.pr, ctx)))
    : (await forge.listPulls({ state: 'open', limit: 50 })).find((x) => head && x.sourceBranch.startsWith(head));
  if (!p) return false;
  if (w.status) {
    const s = (await forge.statuses(p.headSha)).find((x) => x.key === w.status);
    if (!s || s.state === 'pending' || (w.success && s.state !== 'success')) return false;
    did.status = { key: s.key, state: s.state, description: s.description };
  }
  did.pr = { number: p.number, url: p.url, head: p.sourceBranch, sha: p.headSha };
  return true;
}

async function waitFor(step: Step): Promise<void> {
  const w = step.wait;
  if (!w) return;
  const deadline = Date.now() + (w.timeout ?? 300) * 1000;
  const did = (ctx[step.id] ?? {}) as Record<string, unknown>;
  ctx[step.id] = did;
  const done = { discord: !w.discord, jira: !w.jira, github: !w.github };
  while (Date.now() < deadline) {
    if (w.discord && !done.discord) {
      // После своей реплики, а без неё - после начала шага.
      const after = (did.message as { id: string } | undefined)?.id ?? snowflake(Number(did.since ?? t0));
      const msgs = await discord<{ id: string; author: { id: string }; content: string }[]>(
        factoryToken,
        `/channels/${channelId(w.discord.channel)}/messages?after=${after}&limit=20`,
      );
      const reply = msgs.find(
        (m) => m.author.id === factoryId && (!w.discord?.contains || m.content.includes(fill(w.discord.contains, ctx))),
      );
      if (reply) {
        did.reply = { text: reply.content, url: /https?:\/\/\S+/.exec(reply.content)?.[0]?.replace(/[).,]+$/, '') };
        done.discord = true;
        log(`${step.id}: ответ фабрики получен`);
      } else if (w.discord.retry && step.do?.discord && Date.now() - Number(did.said ?? t0) > w.discord.retry * 1000) {
        // Фабрика ещё не готова (например, образов выпуска нет в реестре) - реплика повторяется.
        await say(step, did);
      }
    }
    if (w.jira && !done.jira && (await jiraDone(w.jira, did))) {
      done.jira = true;
      log(`${step.id}: задача ${(did.issue as { key: string }).key}`);
    }
    if (w.github && !done.github && (await githubDone(w.github, did))) {
      done.github = true;
      log(
        `${step.id}: PR ${(did.pr as { number: number }).number}${w.github.status ? ` - ${w.github.status}: ${(did.status as { state: string }).state}` : ''}`,
      );
    }
    if (done.discord && done.jira && done.github) return;
    await sleep(5000);
  }
  throw new Error(`${step.id}: итог не наступил за ${w.timeout ?? 300} с`);
}

const clips: { step: string; chapter: string; who: string; caption: string; file: string; at: string }[] = [];
async function shoot(browser: Browser, step: Step): Promise<void> {
  for (const [n, shot] of (step.show ?? []).entries()) {
    const who = film.personas[shot.who];
    if (!who) throw new Error(`нет участника ${shot.who}`);
    const login = who.browser ? join(state, film.browsers?.[who.browser] ?? '') : undefined;
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      locale: 'ru-RU',
      ...(login && existsSync(login) ? { storageState: login } : {}),
      recordVideo: { dir: join(out, 'raw'), size: { width: 1280, height: 720 } },
    });
    await context.addInitScript(badge, { name: who.name, ai: who.kind === 'ai' });
    const page = await context.newPage();
    if (n === 0 && step.chapter) {
      await page.setContent(chapterHtml(step.chapter, step.note ?? ''));
      await page.waitForTimeout(2500);
    }
    await page.goto(fill(shot.url, ctx), { waitUntil: 'domcontentloaded' });
    if (shot.focus) {
      const target = page.getByText(fill(shot.focus, ctx)).first();
      await target.waitFor({ timeout: 15_000 }).catch(() => log(`${step.id}: нет текста "${shot.focus}" на экране`));
      await target.scrollIntoViewIfNeeded().catch(() => {});
    }
    await page.waitForTimeout((shot.seconds ?? 6) * 1000);
    const video = page.video();
    await context.close();
    const file = `${step.id}-${n + 1}-${shot.who}.webm`;
    await video?.saveAs(join(out, file));
    clips.push({
      step: step.id,
      chapter: step.chapter ?? '',
      who: who.name,
      caption: fill(shot.caption, ctx),
      file,
      at: new Date().toISOString(),
    });
    log(`${step.id}: кадр ${file}`);
  }
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const step of film.steps.filter((s) => !only || only.includes(s.id))) {
    log(`== ${step.id}${step.chapter ? `: ${step.chapter}` : ''}`);
    await act(step);
    await waitFor(step);
    await shoot(browser, step);
  }
} finally {
  await browser.close();
  // Манифест прогона: шаги, клипы, ссылки на задачи и страницы - без ключей и куки.
  writeFileSync(
    join(out, 'manifest.json'),
    JSON.stringify({ title: film.title, take, started: new Date(t0).toISOString(), ctx, clips }, null, 2),
  );
  log(`манифест: ${join(out, 'manifest.json')}`);
}
