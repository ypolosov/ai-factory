// Сценарий съёмки и то, что камера рисует поверх экрана: чистые функции, проверяются тестами.

export interface Persona {
  name: string; // как зритель видит участника на плашке
  kind: 'human' | 'ai';
  discord?: string; // бот персонажа: .state/discord-<id>.env
  browser?: string; // вход браузера камеры: ключ в film.browsers
}

export interface Step {
  id: string;
  chapter: string; // заголовок главы языком зрителя
  note?: string; // подзаголовок главы
  who: string;
  do?: {
    discord?: { channel: string; text: string };
    wiki?: { title: string; body: string; label?: string };
    label?: { key: string; label: string };
    decision?: string; // команда, которую человек выполняет сам вживую
  };
  wait?: {
    timeout?: number; // секунды
    discord?: { channel: string; contains?: string };
    jira?: { label: string; comment?: string };
  };
  show?: { who: string; url: string; caption: string; seconds?: number; focus?: string }[]; // focus - текст, до которого прокрутить
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

// Подстановки {шаг.поле.поле} из итогов прошлых шагов; неизвестная - ошибка, а не пустая строка.
export function fill(text: string, ctx: Record<string, unknown>): string {
  return text.replace(/\{([a-z0-9_.-]+)\}/gi, (_, path: string) => {
    let v: unknown = ctx;
    for (const k of path.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
    if (v === undefined || v === null) throw new Error(`нет значения {${path}}`);
    return String(v);
  });
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
