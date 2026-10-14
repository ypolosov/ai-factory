// Эталонные адаптеры в памяти: проверяют набор контрактных тестов и служат
// заменой носителя в модульных тестах потребителей.
import { type Comment, type CommitStatus, type Forge, type Issue, type LabelEvent, PortError, type Pull, type Tracker } from '../ports.ts';

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
  return {
    forge,
    openPull() {
      const n = ++seq;
      const branch = `feature-${n}`;
      const sha = `sha-${n}`;
      const file = `src/f${n}.ts`;
      commits.set(sha, { author: user, date: now(), file });
      heads.set(branch, sha);
      pulls.set(n, {
        number: n,
        title: `PR ${n}`,
        body: '',
        state: 'open',
        sourceBranch: branch,
        targetBranch: defaultBranch,
        headSha: sha,
        author: user,
        url: `http://memory/pulls/${n}`,
      });
      return { n, branch, file };
    },
  };
}
