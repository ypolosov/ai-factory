// Адаптер Confluence Cloud для порта вики (REST API v1 через api.atlassian.com: токен с
// классическими областями read:confluence-content.all и write:confluence-content; API v2
// требует гранулярных областей). Страница ищется по названию в пространстве.
import { PortError, type Wiki } from './ports.ts';

export interface ConfluenceConfig {
  site: string; // https://<сайт>.atlassian.net
  email: string;
  token: string;
  space: string; // ключ пространства
}

type Json = Record<string, unknown>;

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (t: string) => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');

// Текст -> формат хранения Confluence: "## " - заголовок, "- " - список, остальное - абзацы.
export function toStorage(text: string): string {
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('- ')) {
      list.push(line.slice(2));
      continue;
    }
    flush();
    if (line.startsWith('## ')) out.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('');
}

export const fromStorage = (html: string) =>
  html
    .replace(/<\/(p|h2|li)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();

export function confluenceWiki(cfg: ConfluenceConfig): Wiki {
  const site = cfg.site.replace(/\/$/, '');
  const auth = `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}`;
  let cloudId: Promise<string> | undefined;
  async function call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    cloudId ??= fetch(`${site}/_edge/tenant_info`)
      .then((r) => r.json() as Promise<Json>)
      .then((j) => String(j.cloudId));
    let r: Response;
    try {
      r = await fetch(`https://api.atlassian.com/ex/confluence/${await cloudId}/wiki/rest/api${path}`, {
        method,
        headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PortError('unavailable', `Confluence недоступен: ${(e as Error).message}`);
    }
    if (!r.ok) {
      const code =
        r.status === 404
          ? 'not_found'
          : r.status === 401 || r.status === 403
            ? 'auth'
            : r.status === 409
              ? 'conflict'
              : r.status === 400
                ? 'invalid'
                : 'unavailable';
      throw new PortError(code, `${method} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
    }
    return (r.status === 204 ? undefined : await r.json()) as T;
  }
  const url = (p: Json) => `${site}/wiki${String((p._links as Json | undefined)?.webui ?? '')}`;
  // Поиск - через CQL: этот путь токен с классическими областями пускает, а список и чтение
  // content по id - нет. Индекс поиска отстаёт от записи, поэтому свои записи адаптер помнит.
  const written = new Map<string, { id: string; version: number; body: string; url: string }>();
  async function find(title: string) {
    const cql = `space = "${cfg.space}" and type = page and title = "${title.replace(/["\\]/g, ' ')}"`;
    const q = new URLSearchParams({ cql, expand: 'body.storage,version', limit: '1' });
    const p = (await call<{ results: Json[] }>('GET', `/content/search?${q}`)).results[0];
    const mine = written.get(title);
    const found = p
      ? {
          id: String(p.id),
          version: Number((p.version as Json | undefined)?.number ?? 1),
          body: fromStorage(String(((p.body as Json | undefined)?.storage as Json | undefined)?.value ?? '')),
          url: url(p),
        }
      : undefined;
    return mine && (!found || found.version < mine.version) ? mine : found;
  }
  async function save(title: string, body: string, old?: { id: string; version: number }) {
    const page = {
      type: 'page',
      title,
      space: { key: cfg.space },
      body: { storage: { value: toStorage(body), representation: 'storage' } },
    };
    const saved = old
      ? await call('PUT', `/content/${old.id}`, { ...page, id: old.id, version: { number: old.version + 1 } })
      : await call('POST', '/content', page);
    const rec = {
      id: String(saved.id),
      version: Number((saved.version as Json | undefined)?.number ?? (old ? old.version + 1 : 1)),
      body,
      url: url(saved),
    };
    written.set(title, rec);
    return rec;
  }
  return {
    async getPage(title) {
      const p = await find(title);
      return p ? { id: p.id, url: p.url, body: p.body } : undefined;
    },
    async upsertPage(title, body) {
      let old = await find(title);
      if (!old) {
        try {
          const rec = await save(title, body);
          return { id: rec.id, url: rec.url };
        } catch (e) {
          // Страница есть, но поиск её ещё не видит: ждём индекс до 20 с.
          if (!(e instanceof PortError && e.code === 'invalid' && /already exists/.test(e.message))) throw e;
          for (let i = 0; i < 20 && !old; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            old = await find(title);
          }
          if (!old) throw e;
        }
      }
      const rec = await save(title, body, old);
      return { id: rec.id, url: rec.url };
    },
  };
}
