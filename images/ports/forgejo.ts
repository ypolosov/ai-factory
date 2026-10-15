// Адаптер Forgejo для портов трекера и хостинга (REST API v1). Задачи и PR живут
// в одном репозитории; ключ задачи - её номер строкой.
import {
  type Comment,
  type CommitStatus,
  type Forge,
  type Issue,
  PortError,
  type Pull,
  type Review,
  type StatusState,
  type Tracker,
} from './ports.ts';

export interface ForgejoConfig {
  url: string; // адрес API изнутри сети стенда
  publicUrl: string; // адрес для людей: ссылки в задачах и отчётах
  token: string;
  repo: string; // "владелец/имя"
}

type Json = Record<string, unknown>;

function client(cfg: ForgejoConfig) {
  const root = `${cfg.url.replace(/\/$/, '')}/api/v1`;
  const base = `${root}/repos/${cfg.repo}`;
  async function req(method: string, path: string, body?: unknown, accept = 'application/json', at = base): Promise<Response> {
    let r: Response;
    try {
      r = await fetch(`${at}${path}`, {
        method,
        headers: { authorization: `token ${cfg.token}`, 'content-type': 'application/json', accept },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PortError('unavailable', `Forgejo недоступен: ${(e as Error).message}`);
    }
    if (r.ok) return r;
    const text = (await r.text()).slice(0, 300);
    const code =
      r.status === 404
        ? 'not_found'
        : r.status === 401 || r.status === 403
          ? 'auth'
          : r.status === 409
            ? 'conflict'
            : r.status === 422
              ? 'invalid'
              : 'unavailable';
    throw new PortError(code, `${method} ${path}: ${r.status} ${text}`);
  }
  return {
    async json<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
      const r = await req(method, path, body);
      return (r.status === 204 ? undefined : await r.json()) as T;
    },
    async text(path: string): Promise<string> {
      return (await req('GET', path, undefined, 'text/plain')).text();
    },
    // Учётка токена - вне репозитория.
    async user(): Promise<Json> {
      return (await req('GET', '/user', undefined, 'application/json', root)).json() as Promise<Json>;
    },
    async optional<T = Json>(path: string): Promise<T | undefined> {
      try {
        return await this.json<T>('GET', path);
      } catch (e) {
        if (e instanceof PortError && e.code === 'not_found') return undefined;
        throw e;
      }
    },
  };
}

const publicLink = (cfg: ForgejoConfig, url: string) => url.replace(cfg.url.replace(/\/$/, ''), cfg.publicUrl.replace(/\/$/, ''));

const toComment = (c: Json): Comment => ({
  author: String((c.user as Json | undefined)?.login ?? ''),
  body: String(c.body ?? ''),
  createdAt: String(c.created_at ?? ''),
});

export function forgejoTracker(cfg: ForgejoConfig): Tracker {
  const api = client(cfg);
  let self: Promise<string> | undefined;
  const toIssue = (i: Json): Issue => ({
    key: String(i.number),
    title: String(i.title ?? ''),
    body: String(i.body ?? ''),
    state: i.state === 'closed' ? 'closed' : 'open',
    labels: ((i.labels as Json[] | null) ?? []).map((l) => String(l.name)),
    url: publicLink(cfg, String(i.html_url ?? '')),
    ...((i.user as Json | undefined)?.login ? { author: String((i.user as Json).login) } : {}),
  });
  // Метки у Forgejo - по номеру; порт работает с именами и заводит недостающие.
  async function labelId(name: string, create: boolean): Promise<number | undefined> {
    const all = await api.json<Json[]>('GET', '/labels?limit=100');
    const found = all.find((l) => l.name === name);
    if (found) return Number(found.id);
    if (!create) return undefined;
    const made = await api.json<Json>('POST', '/labels', { name, color: '#cccccc' });
    return Number(made.id);
  }
  return {
    async getIssue(key) {
      const i = await api.json('GET', `/issues/${encodeURIComponent(key)}`);
      if (i.pull_request) throw new PortError('not_found', `${key} - это PR, а не задача`);
      return toIssue(i);
    },
    async listIssues(q = {}) {
      const params = new URLSearchParams({ type: 'issues', state: q.state ?? 'open', limit: String(q.limit ?? 50) });
      if (q.label) params.set('labels', q.label);
      // Поиск Forgejo ищет подстроку: "слово*" - то же без звёздочки.
      if (q.text) params.set('q', q.text.replace(/\*/g, ''));
      return (await api.json<Json[]>('GET', `/issues?${params}`)).map(toIssue);
    },
    async createIssue({ title, body, labels = [] }) {
      const ids = [];
      for (const l of labels) ids.push(await labelId(l, true));
      return toIssue(await api.json('POST', '/issues', { title, body, labels: ids }));
    },
    async updateIssue(key, { title, body }) {
      await api.json('PATCH', `/issues/${key}`, { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) });
    },
    async addComment(key, body) {
      await api.json('POST', `/issues/${key}/comments`, { body });
    },
    async listComments(key) {
      return (await api.json<Json[]>('GET', `/issues/${key}/comments?limit=50`)).map(toComment);
    },
    async addLabel(key, label) {
      await api.json('POST', `/issues/${key}/labels`, { labels: [await labelId(label, true)] });
    },
    async removeLabel(key, label) {
      const id = await labelId(label, false);
      if (id !== undefined) await api.json('DELETE', `/issues/${key}/labels/${id}`);
    },
    async close(key) {
      await api.json('PATCH', `/issues/${key}`, { state: 'closed' });
    },
    async reopen(key) {
      await api.json('PATCH', `/issues/${key}`, { state: 'open' });
    },
    async linkDependency(key, dependsOn) {
      const [owner, repo] = cfg.repo.split('/');
      await api.json('POST', `/issues/${key}/dependencies`, { owner, repo, index: Number(dependsOn) });
    },
    async listDependencies(key) {
      return (await api.json<Json[]>('GET', `/issues/${key}/dependencies`)).map((i) => String(i.number));
    },
    async labelEvents(key) {
      const tl = await api.json<Json[]>('GET', `/issues/${key}/timeline?limit=100`);
      return tl
        .filter((e) => e.type === 'label' && e.label)
        .map((e) => ({
          label: String((e.label as Json).name),
          // Forgejo пишет в тело "1", когда метку ставят, и пустую строку, когда снимают.
          action: e.body === '1' ? ('added' as const) : ('removed' as const),
          at: String(e.created_at),
          ...((e.user as Json | undefined)?.login ? { author: String((e.user as Json).login) } : {}),
        }));
    },
    async me() {
      self ??= api
        .user()
        .then((u) => String(u.login))
        .catch((e) => {
          self = undefined;
          throw e;
        });
      return self;
    },
  };
}

const reviewState = (s: unknown): Review['state'] =>
  s === 'APPROVED' ? 'approved' : s === 'REQUEST_CHANGES' ? 'changes_requested' : 'commented';

const statusState = (s: unknown): StatusState =>
  s === 'success' || s === 'failure' || s === 'error' ? s : s === 'warning' ? 'failure' : 'pending';

export function forgejoForge(cfg: ForgejoConfig): Forge {
  const api = client(cfg);
  const toPull = (p: Json): Pull => ({
    number: Number(p.number),
    title: String(p.title ?? ''),
    body: String(p.body ?? ''),
    state: p.merged ? 'merged' : p.state === 'closed' ? 'closed' : 'open',
    sourceBranch: String((p.head as Json).ref),
    targetBranch: String((p.base as Json).ref),
    headSha: String((p.head as Json).sha),
    author: String((p.user as Json | undefined)?.login ?? ''),
    url: publicLink(cfg, String(p.html_url ?? '')),
  });
  const forge: Forge = {
    async repo() {
      const r = await api.json('GET', '');
      return { webUrl: publicLink(cfg, String(r.html_url)), defaultBranch: String(r.default_branch) };
    },
    async branchHead(branch) {
      const b = await api.optional(`/branches/${encodeURIComponent(branch)}`);
      return b ? String((b.commit as Json).id) : undefined;
    },
    async commitDate(sha) {
      const c = await api.json('GET', `/git/commits/${sha}`);
      return String(c.created ?? ((c.commit as Json).committer as Json).date);
    },
    async getPull(n) {
      return toPull(await api.json('GET', `/pulls/${n}`));
    },
    async listPulls(q = {}) {
      const state = q.state ?? 'open';
      const api_state = state === 'merged' ? 'closed' : state;
      const ps = (await api.json<Json[]>('GET', `/pulls?state=${api_state}&limit=${q.limit ?? 50}`)).map(toPull);
      return state === 'all' ? ps : ps.filter((p) => p.state === state);
    },
    async findPullByBranch(branch) {
      return (await forge.listPulls({ state: 'open' })).find((p) => p.sourceBranch === branch);
    },
    async openPull({ title, body, head, base }) {
      return toPull(await api.json('POST', '/pulls', { title, body, head, base }));
    },
    async pullCommits(n) {
      return (await api.json<Json[]>('GET', `/pulls/${n}/commits?limit=50`)).map((c) => ({
        sha: String(c.sha),
        author: String((c.author as Json | null)?.login ?? ((c.commit as Json).author as Json).name),
        date: String(((c.commit as Json).author as Json).date),
      }));
    },
    async pullDiff(n) {
      return api.text(`/pulls/${n}.diff`);
    },
    async pullReviews(n) {
      return (await api.json<Json[]>('GET', `/pulls/${n}/reviews`))
        .filter((r) => r.state !== 'PENDING')
        .map((r) => ({ author: String((r.user as Json | undefined)?.login ?? ''), state: reviewState(r.state) }));
    },
    async commentPull(n, body) {
      await api.json('POST', `/issues/${n}/comments`, { body });
    },
    async listPullComments(n) {
      return (await api.json<Json[]>('GET', `/issues/${n}/comments?limit=50`)).map(toComment);
    },
    async setStatus(sha, s) {
      await api.json('POST', `/statuses/${sha}`, {
        context: s.key,
        state: s.state,
        description: s.description,
        target_url: s.url ?? '',
      });
    },
    async statuses(sha) {
      // Сводный статус: по каждому ключу - последнее значение.
      const c = await api.json('GET', `/commits/${sha}/status`);
      return ((c.statuses as Json[] | null) ?? []).map(
        (s): CommitStatus => ({
          key: String(s.context),
          state: statusState(s.status ?? s.state),
          description: String(s.description ?? ''),
          ...(s.target_url ? { url: String(s.target_url) } : {}),
        }),
      );
    },
    async tags() {
      return (await api.json<Json[]>('GET', '/tags?limit=50')).map((t) => ({ name: String(t.name), sha: String((t.commit as Json).sha) }));
    },
    async commits(base, head) {
      const list = base
        ? ((await api.json('GET', `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`)).commits as Json[])
        : (await api.json<Json[]>('GET', `/commits?sha=${encodeURIComponent(head)}&limit=50&stat=false`)).reverse();
      return list.map((c) => ({ sha: String(c.sha), message: String((c.commit as Json).message) }));
    },
    async requiredChecks(branch) {
      const p = await api.optional(`/branch_protections/${encodeURIComponent(branch)}`);
      return ((p?.status_check_contexts as string[] | null) ?? []).map(String);
    },
  };
  return forge;
}
