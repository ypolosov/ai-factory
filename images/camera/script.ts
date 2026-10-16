// Сценарий съёмки и то, что камера рисует поверх экрана: чистые функции, проверяются тестами.

export interface Persona {
  name: string; // как зритель видит участника на плашке
  kind: 'human' | 'ai';
  discord?: string; // бот персонажа: .state/discord-<id>.env
  atlassian?: string; // учётка Atlassian персонажа: .state/atlassian-<id>.env
  github?: string; // приложение GitHub персонажа: .state/github-app-<id>.env и .pem
  jira?: string; // accountId в Jira - для назначения исполнителем
  browser?: string; // вход браузера камеры: ключ в film.browsers
}

// Правка файла в PR участника: заготовка рядом со сценарием (from), замены в нынешнем тексте или
// дописка в конец. Строки проходят подстановки {шаг.поле}.
export interface FileEdit {
  path: string;
  from?: string;
  replace?: { find: string; with: string }[];
  append?: string;
}

// Кадр: страница (url) или карточка (card); focus - текст, до которого прокрутить; scroll - секунды
// плавной прокрутки от этой точки до конца страницы; play - действия на странице (стенд); login -
// вход камеры из film.browsers вместо входа участника (Figma, GlitchTip, Bitbucket).
export type PlayAction = { click: string } | { fill: { label: string; value: string } } | { press: string } | { wait: number };
export interface Shot {
  who: string;
  url?: string;
  card?: { title: string; note?: string };
  caption: string;
  seconds?: number;
  focus?: string;
  scroll?: number;
  play?: PlayAction[];
  login?: string;
  clockDays?: number; // часы браузера сдвинуты вперёд (часы стенда демо - так же)
}

export interface HttpCall {
  method?: string;
  url: string;
  body?: unknown;
  as?: string;
}

export interface Step {
  id: string;
  chapter?: string; // заголовок главы языком зрителя; нет - шаг продолжает прошлую главу
  note?: string; // подзаголовок главы
  who: string;
  do?: {
    discord?: { channel: string; text: string; file?: string }; // file - картинка PNG из film-assets во вложении
    wiki?: { title: string; body: string; label?: string };
    label?: { key: string; label: string };
    comment?: { key: string; text: string };
    assign?: { key: string; to: string }; // to - участник из film.personas
    logWork?: { key: string; minutes: number; comment: string };
    close?: { key: string };
    github?: {
      pr?: { branch: string; title: string; body: string; base?: string; files: FileEdit[] };
      merge?: { pr: string; title: string };
      comment?: { pr: string; text: string };
      closePr?: { pr: string }; // закрыть PR без слияния
      tag?: { bump: 'minor' | 'patch' }; // тег следующего выпуска на вершине main: итог - tag
    };
    // Запрос к стенду: итог - status и json; список запросов идёт по порядку, as - имя итога запроса
    // в итоге шага ({шаг.имя.json.id} - в следующих запросах того же шага).
    http?: HttpCall | HttpCall[];
    webhook?: { channel: string; username: string; text: string }; // сообщение вебхука без учётки
    decision?: string; // команда, которую человек выполняет сам вживую
  };
  // Итог шага: задача Jira - по метке (label, с заголовком match), по ключу (key) или среди
  // зависимостей задачи (deps, с отбором по метке и заголовку match); PR - по номеру или началу имени ветки, со статусом;
  // newer - PR засчитывается, только когда на нём новый коммит (вершина уже не этот sha).
  // Метки через "|" - любая из них.
  wait?: {
    timeout?: number; // секунды
    discord?: { channel: string; contains?: string; retry?: number }; // retry - через сколько секунд повторить реплику шага
    jira?: { label?: string; comment?: string; key?: string; deps?: string; match?: string; count?: number; open?: boolean };
    github?: { pr?: string; head?: string; status?: string; success?: boolean; newer?: string };
  };
  show?: Shot[];
}

export interface Film {
  title: string;
  personas: Record<string, Persona>;
  browsers?: Record<string, string>; // ключ -> файл сохранённого входа в каталоге состояния
  steps: Step[];
}

// Файл вида ИМЯ=значение; комментарии и пустые строки пропускаются, кавычки снимаются.
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// Подстановки {шаг.поле.поле} из итогов прошлых шагов, {...|lower} - строчными; неизвестная -
// ошибка, а не пустая строка.
export function fill(text: string, ctx: Record<string, unknown>): string {
  return text.replace(/\{([a-z0-9_.-]+)(\|lower)?\}/gi, (_, path: string, lower?: string) => {
    let v: unknown = ctx;
    for (const k of path.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
    if (v === undefined || v === null) throw new Error(`нет значения {${path}}`);
    return lower ? String(v).toLowerCase() : String(v);
  });
}

// Новый текст файла по правке; замена требует ровно одного вхождения - иначе ошибка, а не тихий пропуск.
export function applyEdit(current: string | undefined, e: FileEdit, asset: (name: string) => string): string {
  let text = e.from ? asset(e.from) : (current ?? '');
  for (const r of e.replace ?? []) {
    if (current === undefined && !e.from) throw new Error(`${e.path}: нет файла`);
    const n = text.split(r.find).length - 1;
    if (n !== 1) throw new Error(`${e.path}: "${r.find}" встречается ${n} раз`);
    text = text.replace(r.find, () => r.with);
  }
  if (e.append !== undefined) text = `${text ? text.replace(/\n*$/, '\n') : ''}${e.append.replace(/\n*$/, '\n')}`;
  return text;
}

// Сценарий съёмки цел до прогона: участники шагов и кадров есть и у них есть нужные учётки,
// подстановки ссылаются на прошлые шаги (в ожидании и кадрах - и на свой), заготовки на месте.
export function checkFilm(film: Film, assetExists: (name: string) => boolean): string[] {
  const out: string[] = [];
  const known = new Set(['take']);
  const refs = (x: unknown) => [...JSON.stringify(x ?? '').matchAll(/\{([a-z0-9_-]+)[a-z0-9_.-]*(\|lower)?\}/gi)].map((m) => m[1] ?? '');
  const unknown = (id: string, x: unknown) => {
    for (const r of new Set(refs(x))) if (!known.has(r)) out.push(`${id}: {${r}...} - не прошлый шаг`);
  };
  for (const s of film.steps) {
    const who = film.personas[s.who];
    if (!who) out.push(`${s.id}: нет участника ${s.who}`);
    // Запросы к стенду в шаге могут ссылаться на итоги прошлых запросов того же шага.
    unknown(s.id, { ...s.do, http: undefined });
    known.add(s.id);
    unknown(s.id, [s.do?.http, s.wait, s.show]);
    if (s.do?.discord && !who?.discord) out.push(`${s.id}: у участника ${s.who} нет бота Discord`);
    if (s.do?.github && !who?.github) out.push(`${s.id}: у участника ${s.who} нет приложения GitHub`);
    for (const sh of s.show ?? []) {
      if (!film.personas[sh.who]) out.push(`${s.id}: в кадре нет участника ${sh.who}`);
      if (!sh.url && !sh.card) out.push(`${s.id}: у кадра нет ни страницы, ни карточки`);
      if (sh.login && !film.browsers?.[sh.login]) out.push(`${s.id}: нет входа камеры ${sh.login} в film.browsers`);
    }
    const file = s.do?.discord?.file;
    if (file && !assetExists(file)) out.push(`${s.id}: нет заготовки ${file}`);
    for (const f of s.do?.github?.pr?.files ?? []) if (f.from && !assetExists(f.from)) out.push(`${s.id}: нет заготовки ${f.from}`);
  }
  return out;
}

// Тег следующего выпуска по последнему тегу vX.Y.Z; тегов выпусков нет - v1.0.0.
export function nextVersion(tags: string[], bump: 'minor' | 'patch'): string {
  const vs = tags
    .map((t) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const last = vs.at(-1);
  if (!last) return 'v1.0.0';
  return bump === 'minor' ? `v${last[0]}.${last[1] + 1}.0` : `v${last[0]}.${last[1]}.${last[2] + 1}`;
}

// Номер сообщения Discord на момент времени: "сообщения после" для ответа без своей реплики.
export function snowflake(ms: number): string {
  return String((BigInt(ms) - 1_420_070_400_000n) << 22n);
}

// Фабрика просит повторить команду, когда площадка временно недоступна (images/coordinator/bot.ts):
// это не ответ на реплику, а повод сказать её снова.
export function asksRetry(text: string): boolean {
  return /повторите команду/i.test(text);
}

// Метка всего, что создаёт съёмка: по ней scripts/demo-reset.sh уводит прошлые дубли в архив.
export const FILM_LABEL = 'film';

// Имя дубля по местному времени начала: take-ММДД-ЧЧММ - годится в метку Jira и Confluence.
export function takeName(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `take-${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}

// Плашка участника в углу экрана: кто сейчас действует; ИИ-персонаж помечен.
export function badge(p: { name: string; ai: boolean }): void {
  const put = () => {
    if (document.getElementById('film-badge')) return;
    const el = document.createElement('div');
    el.id = 'film-badge';
    el.textContent = p.ai ? `${p.name} - ИИ-персонаж` : p.name;
    el.setAttribute(
      'style',
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:8px 14px;border-radius:10px;' +
        `font:600 16px/1.3 system-ui,sans-serif;color:#fff;background:${p.ai ? '#5B3FD6' : '#1F6F43'};` +
        'box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none',
    );
    document.documentElement.appendChild(el);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', put);
  else put();
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

// Карточка главы перед первым кадром шага.
export function chapterHtml(title: string, note: string): string {
  return `<!doctype html><html lang="ru"><body style="margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:14px;background:#14111F;color:#fff;font-family:system-ui,sans-serif"><div style="font-size:44px;font-weight:700;text-align:center;max-width:1000px">${esc(title)}</div><div style="font-size:22px;color:#C9C3E6;text-align:center;max-width:1000px">${esc(note)}</div></body></html>`;
}
