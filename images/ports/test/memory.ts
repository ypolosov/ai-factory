// Эталонные адаптеры в памяти: проверяют набор контрактных тестов и служат
// заменой носителя в модульных тестах потребителей.
import {
  type Comment,
  type CommitStatus,
  type Forge,
  type Issue,
  type Job,
  type JobRunner,
  type Knowledge,
  type LabelEvent,
  PortError,
  type Pull,
  type Tracker,
} from '../ports.ts';

const now = () => new Date().toISOString();

export function memoryTracker(user = 'factory-bot'): Tracker {
  let seq = 0;
  const issues = new Map<string, Issue>();
  const comments = new Map<string, Comment[]>();
  const events = new Map<string, LabelEvent[]>();
  const deps = new Map<string, string[]>();
  const get = (key: string) => {
    const i = issues.get(key);
    if (!i) throw new PortError('not_found', `задача ${key} не найдена`);
    return i;
  };
  const label = (key: string, l: string, action: LabelEvent['action']) => {
    const i = get(key);
    i.labels = action === 'added' ? [...new Set([...i.labels, l])] : i.labels.filter((x) => x !== l);
    events.set(key, [...(events.get(key) ?? []), { label: l, action, at: now() }]);
  };
  return {
    async getIssue(key) {
      return { ...get(key), labels: [...get(key).labels] };
    },
    async listIssues(q = {}) {
      const state = q.state ?? 'open';
      return [...issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .filter((i) => !q.label || i.labels.includes(q.label))
        .filter((i) => !q.text || `${i.title}\n${i.body}`.toLowerCase().includes((q.text ?? '').toLowerCase()))
        .slice(0, q.limit ?? 50)
        .map((i) => ({ ...i, labels: [...i.labels] }));
    },
    async createIssue({ title, body, labels = [] }) {
      const key = String(++seq);
      const i: Issue = { key, title, body, state: 'open', labels: [], url: `http://memory/issues/${key}` };
      issues.set(key, i);
      for (const l of labels) label(key, l, 'added');
      return { ...i, labels: [...i.labels] };
    },
    async addComment(key, body) {
      get(key);
      comments.set(key, [...(comments.get(key) ?? []), { author: user, body, createdAt: now() }]);
    },
    async listComments(key) {
      get(key);
      return [...(comments.get(key) ?? [])];
    },
    async addLabel(key, l) {
      label(key, l, 'added');
    },
    async removeLabel(key, l) {
      label(key, l, 'removed');
    },
    async close(key) {
      get(key).state = 'closed';
    },
    async reopen(key) {
      get(key).state = 'open';
    },
    async linkDependency(key, dependsOn) {
      get(key);
      get(dependsOn);
      deps.set(key, [...new Set([...(deps.get(key) ?? []), dependsOn])]);
    },
    async listDependencies(key) {
      get(key);
      return [...(deps.get(key) ?? [])];
    },
    async labelEvents(key) {
      get(key);
      return [...(events.get(key) ?? [])];
    },
  };
}

export function memoryForge(user = 'factory-bot') {
  const defaultBranch = 'main';
  const heads = new Map<string, string>([[defaultBranch, 'sha-0']]);
  const commits = new Map<string, { author: string; date: string; file: string }>([
    ['sha-0', { author: user, date: now(), file: 'README.md' }],
  ]);
  const pulls = new Map<number, Pull>();
  const pullComments = new Map<number, Comment[]>();
  const statuses = new Map<string, CommitStatus[]>();
  let seq = 0;
  const pull = (n: number) => {
    const p = pulls.get(n);
    if (!p) throw new PortError('not_found', `PR ${n} не найден`);
    return p;
  };
  const forge: Forge = {
    async repo() {
      return { webUrl: 'http://memory/repo', defaultBranch };
    },
    async branchHead(branch) {
      return heads.get(branch);
    },
    async commitDate(sha) {
      const c = commits.get(sha);
      if (!c) throw new PortError('not_found', `коммит ${sha} не найден`);
      return c.date;
    },
    async getPull(n) {
      return { ...pull(n) };
    },
    async listPulls(q = {}) {
      const state = q.state ?? 'open';
      return [...pulls.values()].filter((p) => state === 'all' || p.state === state).slice(0, q.limit ?? 50);
    },
    async findPullByBranch(branch) {
      return [...pulls.values()].find((p) => p.sourceBranch === branch && p.state === 'open');
    },
    async openPull({ title, body, head, base }) {
      const headSha = heads.get(head);
      if (!headSha || !heads.has(base)) throw new PortError('not_found', `нет ветки ${headSha ? base : head}`);
      if (await forge.findPullByBranch(head)) throw new PortError('conflict', `PR из ${head} уже открыт`);
      const n = ++seq;
      const p: Pull = {
        number: n,
        title,
        body,
        state: 'open',
        sourceBranch: head,
        targetBranch: base,
        headSha,
        author: user,
        url: `http://memory/pulls/${n}`,
      };
      pulls.set(n, p);
      return { ...p };
    },
    async pullCommits(n) {
      const sha = pull(n).headSha;
      const c = commits.get(sha);
      return c ? [{ sha, author: c.author, date: c.date }] : [];
    },
    async pullDiff(n) {
      const c = commits.get(pull(n).headSha);
      return c ? `diff --git a/${c.file} b/${c.file}\n` : '';
    },
    async pullReviews(n) {
      pull(n);
      return [];
    },
    async commentPull(n, body) {
      pull(n);
      pullComments.set(n, [...(pullComments.get(n) ?? []), { author: user, body, createdAt: now() }]);
    },
    async listPullComments(n) {
      pull(n);
      return [...(pullComments.get(n) ?? [])];
    },
    async setStatus(sha, s) {
      statuses.set(sha, [...(statuses.get(sha) ?? []).filter((x) => x.key !== s.key), { ...s }]);
    },
    async statuses(sha) {
      return [...(statuses.get(sha) ?? [])];
    },
    async requiredChecks() {
      return [];
    },
  };
  let branches = 0;
  const pushBranch = () => {
    const k = ++branches;
    const branch = `feature-${k}`;
    const sha = `sha-${k}`;
    const file = `src/f${k}.ts`;
    commits.set(sha, { author: user, date: now(), file });
    heads.set(branch, sha);
    return { branch, file };
  };
  return {
    forge,
    pushBranch,
    // Ветка, отправленная мимо адаптера (например, git push потребителя в тесте).
    setHead(branch: string, sha: string, file = 'README.md') {
      commits.set(sha, { author: user, date: now(), file });
      heads.set(branch, sha);
    },
    async openPull() {
      const b = pushBranch();
      const p = await forge.openPull({ title: `PR ${b.branch}`, body: '', head: b.branch, base: defaultBranch });
      return { n: p.number, ...b };
    },
  };
}

// Задание в памяти - функция от переменных и секретов; её итог становится состоянием задания.
export type MemoryJob = (env: Record<string, string>) => Promise<'success' | 'failed'>;

export function memoryJobs(handlers: Record<string, MemoryJob>): JobRunner {
  const jobs = new Map<string, Job>();
  let seq = 0;
  const job = (id: string) => {
    const j = jobs.get(id);
    if (!j) throw new PortError('not_found', `задание ${id} не найдено`);
    return j;
  };
  return {
    async start({ job: name, variables = {}, secrets = {} }) {
      const handler = handlers[name];
      if (!handler) throw new PortError('invalid', `нет задания ${name}`);
      const id = `job-${++seq}`;
      const j: Job = { id, state: 'running', url: `http://memory/jobs/${id}` };
      jobs.set(id, j);
      handler({ ...variables, ...secrets }).then(
        (r) => {
          if (j.state === 'running') j.state = r;
        },
        () => {
          if (j.state === 'running') j.state = 'failed';
        },
      );
      return { ...j, state: 'pending' };
    },
    async get(id) {
      return { ...job(id) };
    },
    async stop(id) {
      const j = job(id);
      if (j.state === 'running' || j.state === 'pending') j.state = 'stopped';
    },
  };
}

// База знаний в памяти: отрывок - документ целиком, совпадение - по основам слов.
export function memoryKnowledge(docs: { path: string; text: string }[]): Knowledge {
  const stems = (t: string) => new Set((t.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((w) => w.slice(0, 6)));
  return {
    async search(query, limit = 8) {
      const q = stems(query);
      return docs
        .map((d) => ({ d, score: [...stems(d.text)].filter((w) => q.has(w)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ d }) => ({
          source: d.path,
          title: d.text.split('\n')[0]?.replace(/^#+\s*/, '') ?? d.path,
          text: d.text,
          url: `http://memory/${d.path}`,
        }));
    },
  };
}
