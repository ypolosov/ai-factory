// Адаптер GitHub для порта хостинга (REST API v3). Носитель платформы цели в демо;
// трекер у цели - Jira, поэтому порта трекера здесь нет. Токен - fine-grained на репозиторий.
import {
  PortError,
  type Comment,
  type CommitStatus,
  type Forge,
  type Pull,
  type Review,
  type StatusState,
} from './ports.ts';

export interface GithubConfig {
  repo: string; // "владелец/имя"
  token: string;
  api?: string; // по умолчанию https://api.github.com
}

type Json = Record<string, unknown>;

function client(cfg: GithubConfig) {
  const base = `${(cfg.api ?? 'https://api.github.com').replace(/\/$/, '')}/repos/${cfg.repo}`;
  async function req(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<Response> {
    let r: Response;
    try {
      r = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${cfg.token}`,
          accept,
          'x-github-api-version': '2022-11-28',
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PortError('unavailable', `GitHub недоступен: ${(e as Error).message}`);
    }
    if (r.ok) return r;
    const text = (await r.text()).slice(0, 300);
    const code = r.status === 404 ? 'not_found' : r.status === 401 || r.status === 403 ? 'auth' : r.status === 409 ? 'conflict' : r.status === 422 ? 'invalid' : 'unavailable';
    throw new PortError(code, `${method} ${path}: ${r.status} ${text}`);
  }
  return {
    async json<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
      const r = await req(method, path, body);
      return (r.status === 204 ? undefined : await r.json()) as T;
    },
    async text(path: string, accept: string): Promise<string> {
      return (await req('GET', path, undefined, accept)).text();
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

const toComment = (c: Json): Comment => ({
  author: String((c.user as Json | undefined)?.login ?? ''),
  body: String(c.body ?? ''),
  createdAt: String(c.created_at ?? ''),
});

const reviewState = (s: unknown): Review['state'] =>
  s === 'APPROVED' ? 'approved' : s === 'CHANGES_REQUESTED' ? 'changes_requested' : 'commented';

const statusState = (s: unknown): StatusState => (s === 'success' || s === 'failure' || s === 'error' ? s : 'pending');

export function githubForge(cfg: GithubConfig): Forge {
  const api = client(cfg);
  const owner = cfg.repo.split('/')[0];
  const toPull = (p: Json): Pull => ({
    number: Number(p.number),
    title: String(p.title ?? ''),
    body: String(p.body ?? ''),
    state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open',
    sourceBranch: String((p.head as Json).ref),
    targetBranch: String((p.base as Json).ref),
    headSha: String((p.head as Json).sha),
    author: String((p.user as Json | undefined)?.login ?? ''),
    url: String(p.html_url ?? ''),
  });
  const forge: Forge = {
    async repo() {
      const r = await api.json('GET', '');
      return { webUrl: String(r.html_url), defaultBranch: String(r.default_branch) };
    },
    async branchHead(branch) {
      const b = await api.optional(`/branches/${encodeURIComponent(branch)}`);
      return b ? String((b.commit as Json).sha) : undefined;
    },
    async commitDate(sha) {
      const c = await api.json('GET', `/commits/${sha}`);
      return String(((c.commit as Json).committer as Json).date);
    },
    async getPull(n) {
      return toPull(await api.json('GET', `/pulls/${n}`));
    },
    async listPulls(q = {}) {
      const state = q.state ?? 'open';
      const apiState = state === 'merged' ? 'closed' : state;
      const ps = (await api.json<Json[]>('GET', `/pulls?state=${apiState}&per_page=${q.limit ?? 50}`)).map(toPull);
      return state === 'all' ? ps : ps.filter((p) => p.state === state);
    },
    async findPullByBranch(branch) {
      const ps = await api.json<Json[]>('GET', `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      return ps[0] ? toPull(ps[0]) : undefined;
    },
    async pullCommits(n) {
      return (await api.json<Json[]>('GET', `/pulls/${n}/commits?per_page=100`)).map((c) => ({
        sha: String(c.sha),
        author: String((c.author as Json | null)?.login ?? ((c.commit as Json).author as Json).name),
        date: String(((c.commit as Json).author as Json).date),
      }));
    },
    async pullDiff(n) {
      return api.text(`/pulls/${n}`, 'application/vnd.github.diff');
    },
    async pullReviews(n) {
      return (await api.json<Json[]>('GET', `/pulls/${n}/reviews`))
        .filter((r) => r.state !== 'PENDING' && r.state !== 'DISMISSED')
        .map((r) => ({ author: String((r.user as Json | undefined)?.login ?? ''), state: reviewState(r.state) }));
    },
    async commentPull(n, body) {
      await api.json('POST', `/issues/${n}/comments`, { body });
    },
    async listPullComments(n) {
      return (await api.json<Json[]>('GET', `/issues/${n}/comments?per_page=100`)).map(toComment);
    },
    async setStatus(sha, s) {
      await api.json('POST', `/statuses/${sha}`, {
        state: s.state,
        context: s.key,
        description: s.description.slice(0, 140),
        ...(s.url ? { target_url: s.url } : {}),
      });
    },
    async statuses(sha) {
      // Сводный статус: по каждому ключу - последнее значение.
      const c = await api.json('GET', `/commits/${sha}/status`);
      return ((c.statuses as Json[] | null) ?? []).map(
        (s): CommitStatus => ({
          key: String(s.context),
          state: statusState(s.state),
          description: String(s.description ?? ''),
          ...(s.target_url ? { url: String(s.target_url) } : {}),
        }),
      );
    },
    async requiredChecks(branch) {
      // Ответ о ветке показывает защиту и без прав администратора.
      const b = await api.optional(`/branches/${encodeURIComponent(branch)}`);
      const checks = ((b?.protection as Json | undefined)?.required_status_checks as Json | undefined)?.contexts;
      return ((checks as string[] | undefined) ?? []).map(String);
    },
  };
  return forge;
}
