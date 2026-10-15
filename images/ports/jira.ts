// Адаптер Jira Cloud для порта трекера (REST API v3 через api.atlassian.com, токен с областями
// read:jira-work, write:jira-work, read:jira-user). Ключ задачи - ключ Jira (DRAW-12).
// Описание и комментарии в Jira - документ ADF; порт работает с простым текстом.
import { type Comment, type Issue, type LabelEvent, PortError, type Tracker } from './ports.ts';

export interface JiraConfig {
  site: string; // https://<сайт>.atlassian.net - для адресов задач и поиска cloudId
  email: string;
  token: string;
  project: string; // ключ проекта
  issueType?: string; // по умолчанию Task
}

type Json = Record<string, unknown>;
type Adf = { type: string; version?: number; text?: string; content?: Adf[] };

// Простой текст -> ADF: абзац на строку.
export function textToAdf(text: string): Adf {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
  };
}

// ADF -> простой текст: текст узлов, блоки - через перевод строки.
export function adfToText(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  const blocks: string[] = [];
  const inline = (n: Adf): string => (n.type === 'text' ? (n.text ?? '') : (n.content ?? []).map(inline).join(''));
  for (const b of (doc as Adf).content ?? []) blocks.push(inline(b));
  return blocks.join('\n');
}

export function jiraTracker(cfg: JiraConfig): Tracker {
  const site = cfg.site.replace(/\/$/, '');
  const auth = `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}`;
  let cloudId: Promise<string> | undefined;
  // Поиск JQL согласован в конечном счёте; недавно изменённые задачи передаём поиску явно.
  const touched: number[] = [];
  const touch = (id: unknown) => {
    const n = Number(id);
    if (!Number.isFinite(n)) return;
    const i = touched.indexOf(n);
    if (i >= 0) touched.splice(i, 1);
    touched.push(n);
    if (touched.length > 50) touched.shift();
  };

  async function base(): Promise<string> {
    cloudId ??= fetch(`${site}/_edge/tenant_info`)
      .then((r) => r.json() as Promise<Json>)
      .then((j) => String(j.cloudId));
    return `https://api.atlassian.com/ex/jira/${await cloudId}/rest/api/3`;
  }

  async function call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${await base()}${path}`, {
        method,
        headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PortError('unavailable', `Jira недоступна: ${(e as Error).message}`);
    }
    if (!r.ok) {
      const text = (await r.text()).slice(0, 300);
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
      throw new PortError(code, `${method} ${path}: ${r.status} ${text}`);
    }
    return (r.status === 204 || r.headers.get('content-length') === '0' ? undefined : await r.json().catch(() => undefined)) as T;
  }

  const FIELDS = ['summary', 'description', 'labels', 'status', 'creator'];
  const toIssue = (i: Json): Issue => {
    const f = i.fields as Json;
    const cat = ((f.status as Json | undefined)?.statusCategory as Json | undefined)?.key;
    return {
      key: String(i.key),
      title: String(f.summary ?? ''),
      body: adfToText(f.description),
      state: cat === 'done' ? 'closed' : 'open',
      labels: ((f.labels as string[] | undefined) ?? []).map(String),
      url: `${site}/browse/${String(i.key)}`,
      ...((f.creator as Json | undefined)?.accountId ? { author: String((f.creator as Json).accountId) } : {}),
    };
  };
  const getRaw = async (key: string) => {
    const i = await call('GET', `/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(',')}`);
    touch(i.id);
    return i;
  };

  // Переход в состояние категории done (закрыть) или new (открыть снова).
  async function transition(key: string, category: 'done' | 'new') {
    const t = await call<{ transitions: Json[] }>('GET', `/issue/${encodeURIComponent(key)}/transitions`);
    const to = t.transitions.find((x) => ((x.to as Json).statusCategory as Json).key === category);
    if (!to) throw new PortError('invalid', `${key}: нет перехода в категорию ${category}`);
    await call('POST', `/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: to.id } });
  }

  return {
    async getIssue(key) {
      return toIssue(await getRaw(key));
    },
    async listIssues(q = {}) {
      const parts = [`project = "${cfg.project}"`];
      if (q.label) parts.push(`labels = "${q.label.replace(/"/g, '\\"')}"`);
      if (q.text) parts.push(`text ~ "${q.text.replace(/["\\]/g, ' ')}"`);
      const state = q.state ?? 'open';
      if (state === 'open') parts.push('statusCategory != Done');
      if (state === 'closed') parts.push('statusCategory = Done');
      const r = await call<{ issues: Json[] }>('POST', '/search/jql', {
        jql: `${parts.join(' AND ')} ORDER BY created ASC`,
        fields: FIELDS,
        maxResults: q.limit ?? 50,
        ...(touched.length ? { reconcileIssues: touched } : {}),
      });
      return (r.issues ?? []).map(toIssue);
    },
    async createIssue({ title, body, labels = [] }) {
      const made = await call('POST', '/issue', {
        fields: {
          project: { key: cfg.project },
          issuetype: { name: cfg.issueType ?? 'Task' },
          summary: title,
          ...(body ? { description: textToAdf(body) } : {}),
          labels,
        },
      });
      touch(made.id);
      return toIssue(await getRaw(String(made.key)));
    },
    async updateIssue(key, { title, body }) {
      await call('PUT', `/issue/${encodeURIComponent(key)}`, {
        fields: { ...(title !== undefined ? { summary: title } : {}), ...(body !== undefined ? { description: textToAdf(body) } : {}) },
      });
    },
    async addComment(key, body) {
      await call('POST', `/issue/${encodeURIComponent(key)}/comment`, { body: textToAdf(body) });
    },
    async listComments(key) {
      const r = await call<{ comments: Json[] }>('GET', `/issue/${encodeURIComponent(key)}/comment?orderBy=created`);
      return r.comments.map(
        (c): Comment => ({
          author: String((c.author as Json | undefined)?.displayName ?? ''),
          body: adfToText(c.body),
          createdAt: String(c.created ?? ''),
        }),
      );
    },
    async addLabel(key, label) {
      await call('PUT', `/issue/${encodeURIComponent(key)}`, { update: { labels: [{ add: label }] } });
    },
    async removeLabel(key, label) {
      await call('PUT', `/issue/${encodeURIComponent(key)}`, { update: { labels: [{ remove: label }] } });
    },
    async close(key) {
      await transition(key, 'done');
      touch((await getRaw(key)).id);
    },
    async reopen(key) {
      await transition(key, 'new');
      touch((await getRaw(key)).id);
    },
    async linkDependency(key, dependsOn) {
      // dependsOn блокирует key: связь Blocks, наружная сторона - блокирующая задача.
      await call('POST', '/issueLink', {
        type: { name: 'Blocks' },
        inwardIssue: { key },
        outwardIssue: { key: dependsOn },
      });
    },
    async listDependencies(key) {
      const i = await call('GET', `/issue/${encodeURIComponent(key)}?fields=issuelinks`);
      const links = ((i.fields as Json).issuelinks as Json[] | undefined) ?? [];
      return links.filter((l) => (l.type as Json).name === 'Blocks' && l.outwardIssue).map((l) => String((l.outwardIssue as Json).key));
    },
    async labelEvents(key) {
      const r = await call<{ values: Json[] }>('GET', `/issue/${encodeURIComponent(key)}/changelog?maxResults=100`);
      const events: LabelEvent[] = [];
      for (const h of r.values ?? []) {
        for (const item of (h.items as Json[]) ?? []) {
          if (item.field !== 'labels') continue;
          const from = new Set(
            String(item.fromString ?? '')
              .split(' ')
              .filter(Boolean),
          );
          const to = new Set(
            String(item.toString ?? '')
              .split(' ')
              .filter(Boolean),
          );
          const by = (h.author as Json | undefined)?.accountId;
          const author = by ? { author: String(by) } : {};
          for (const l of to) if (!from.has(l)) events.push({ label: l, action: 'added', at: String(h.created), ...author });
          for (const l of from) if (!to.has(l)) events.push({ label: l, action: 'removed', at: String(h.created), ...author });
        }
      }
      return events;
    },
  };
}
