// Режиссёр видео-демо: шаги сценария съёмки выполняют участники через API под своими учётками
// (боты Discord у ИИ-персонажей, учётка Atlassian у человека), итог шага ждётся по наблюдаемому
// признаку, камера - Playwright без окна - снимает экран браузера участника с его плашкой.
// Решения в точках решения принимает человек вживую: режиссёр называет команду и ждёт её итога.
// Ключи - из каталога состояния (только чтение); в журнал, манифест и клипы они не попадают.
// Использование: node film.ts СЦЕНАРИЙ.yml КАТАЛОГ_КЛИПОВ [--only шаг,шаг] [--state /state]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { parse } from 'yaml';
import { selectTracker, selectWiki } from '../ports/select.ts';
import { badge, chapterHtml, type Film, fill, parseEnv, type Step } from './script.ts';

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
const factory = atlassian('atlassian.env');
const tracker = factory.tracker;
const accounts = new Map<string, ReturnType<typeof atlassian>>();
// Учётка, под которой действует участник: своя, если заведена, иначе - фабрики.
const as = (who: string) => {
  const id = film.personas[who]?.atlassian;
  if (!id || !existsSync(join(state, `atlassian-${id}.env`))) return factory;
  if (!accounts.has(id)) accounts.set(id, atlassian(`atlassian-${id}.env`));
  return accounts.get(id) ?? factory;
};

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

type Ctx = Record<string, Record<string, unknown>>;
const ctx: Ctx = {};

async function act(step: Step): Promise<void> {
  const did: Record<string, unknown> = {};
  ctx[step.id] = did;
  const d = step.do;
  if (!d) return;
  if (d.discord) {
    const who = film.personas[step.who];
    if (!who?.discord) throw new Error(`у участника ${step.who} нет бота Discord`);
    const text = fill(d.discord.text, ctx).replaceAll('@factory', `<@${factoryId}>`);
    const m = await discord<{ id: string }>(personaToken(who.discord), `/channels/${channelId(d.discord.channel)}/messages`, {
      content: text,
    });
    did.message = { id: m.id, channel: d.discord.channel };
    log(`${step.id}: ${who.name} пишет в #${d.discord.channel}`);
  }
  if (d.wiki) {
    const wiki = as(step.who).wiki ?? factory.wiki;
    if (!wiki) throw new Error(`у участника ${step.who} нет учётки Confluence`);
    const page = await wiki.upsertPage(fill(d.wiki.title, ctx), fill(d.wiki.body, ctx));
    if (d.wiki.label) await wiki.addLabel(page.id, d.wiki.label);
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
  if (d.decision) log(`${step.id}: РЕШЕНИЕ ЧЕЛОВЕКА - ${fill(d.decision, ctx)}`);
}

async function waitFor(step: Step): Promise<void> {
  const w = step.wait;
  if (!w) return;
  const deadline = Date.now() + (w.timeout ?? 300) * 1000;
  const did = ctx[step.id] ?? {};
  while (Date.now() < deadline) {
    if (w.discord) {
      const after = (did.message as { id: string } | undefined)?.id ?? '0';
      const msgs = await discord<{ id: string; author: { id: string }; content: string }[]>(
        factoryToken,
        `/channels/${channelId(w.discord.channel)}/messages?after=${after}&limit=20`,
      );
      const reply = msgs.find((m) => m.author.id === factoryId && (!w.discord?.contains || m.content.includes(w.discord.contains)));
      if (reply) {
        did.reply = { text: reply.content };
        log(`${step.id}: ответ фабрики получен`);
        return;
      }
    }
    if (w.jira) {
      const [i] = await tracker.listIssues({ label: fill(w.jira.label, ctx), state: 'all', limit: 1 });
      const comments = i && w.jira.comment ? await tracker.listComments(i.key) : [];
      if (i && (!w.jira.comment || comments.some((c) => c.body.includes(w.jira?.comment ?? '')))) {
        did.issue = { key: i.key, url: i.url };
        log(`${step.id}: задача ${i.key}`);
        return;
      }
    }
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
    if (n === 0) {
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
      chapter: step.chapter,
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
    log(`== ${step.id}: ${step.chapter}`);
    await act(step);
    await waitFor(step);
    await shoot(browser, step);
  }
} finally {
  await browser.close();
  // Манифест прогона: шаги, клипы, ссылки на задачи и страницы - без ключей и куки.
  writeFileSync(
    join(out, 'manifest.json'),
    JSON.stringify({ title: film.title, started: new Date(t0).toISOString(), ctx, clips }, null, 2),
  );
  log(`манифест: ${join(out, 'manifest.json')}`);
}
