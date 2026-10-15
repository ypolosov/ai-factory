// Эталонные адаптеры в памяти: проверяют набор контрактных тестов и служат
// заменой носителя в модульных тестах потребителей.
import {
  type Chat,
  type ChatMessage,
  type Comment,
  type CommitStatus,
  type Forge,
  type Incident,
  type Incidents,
  type Issue,
  type Job,
  type JobRunner,
  type Knowledge,
  type LabelEvent,
  PortError,
  type Pull,
  type Tracker,
  type Wiki,
} from '../ports.ts';
import { stems } from '../text.ts';

const now = () => new Date().toISOString();

// Поиск по тексту: каждое слово запроса - в тексте; "слово*" - начало слова.
const matches = (text: string, query: string) => {
  const ws: string[] = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((q) => (q.endsWith('*') ? ws.some((w) => w.startsWith(q.slice(0, -1))) : ws.includes(q)));
};

// keyPrefix - ключи задач как у Jira ("DRAW-"); по умолчанию - номера, как у Forgejo.
// as(учётка) - тот же трекер от лица другой учётки (человек ставит метку руками).
export function memoryTracker(user = 'factory-bot', keyPrefix = ''): Tracker & { as(user: string): Tracker } {
  let seq = 0;
  const issues = new Map<string, Issue>();
  const comments = new Map<string, Comment[]>();
  const events = new Map<string, LabelEvent[]>();
  const deps = new Map<string, string[]>();
  const view = (user: string): Tracker => {
    const get = (key: string) => {
      const i = issues.get(key);
      if (!i) throw new PortError('not_found', `задача ${key} не найдена`);
      return i;
    };
    const label = (key: string, l: string, action: LabelEvent['action']) => {
      const i = get(key);
      i.labels = action === 'added' ? [...new Set([...i.labels, l])] : i.labels.filter((x) => x !== l);
      events.set(key, [...(events.get(key) ?? []), { label: l, action, at: now(), author: user }]);
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
          .filter((i) => !q.text || matches(`${i.title}\n${i.body}`, q.text))
          .slice(0, q.limit ?? 50)
          .map((i) => ({ ...i, labels: [...i.labels] }));
      },
      async createIssue({ title, body, labels = [] }) {
        const key = `${keyPrefix}${++seq}`;
        const i: Issue = { key, title, body, state: 'open', labels: [], url: `http://memory/issues/${key}`, author: user };
        issues.set(key, i);
        for (const l of labels) label(key, l, 'added');
        return { ...i, labels: [...i.labels] };
      },
      async updateIssue(key, { title, body }) {
        const i = get(key);
        if (title !== undefined) i.title = title;
        if (body !== undefined) i.body = body;
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
      async me() {
        return user;
      },
      async assign(key, account) {
        get(key).assignee = account;
      },
      async estimate(key, hours) {
        get(key).estimateSeconds = Math.round(hours * 3600);
      },
      async logWork(key, seconds, comment) {
        const i = get(key);
        i.spentSeconds = (i.spentSeconds ?? 0) + Math.max(60, Math.round(seconds));
        comments.set(key, [...(comments.get(key) ?? []), { author: user, body: comment, createdAt: now() }]);
      },
    };
  };
  return { ...view(user), as: view };
}

export function memoryForge(user = 'factory-bot') {
  const defaultBranch = 'main';
  const heads = new Map<string, string>([[defaultBranch, 'sha-0']]);
  const commits = new Map<string, { author: string; date: string; file: string; parent?: string; message?: string }>([
    ['sha-0', { author: user, date: now(), file: 'README.md', message: 'init' }],
  ]);
  const tags = new Map<string, string>();
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
    async tags() {
      return [...tags].reverse().map(([name, sha]) => ({ name, sha }));
    },
    async commits(base, head) {
      const out: { sha: string; message: string }[] = [];
      for (let sha: string | undefined = head; sha && sha !== base; sha = commits.get(sha)?.parent) {
        out.push({ sha, message: commits.get(sha)?.message ?? '' });
      }
      return out.reverse();
    },
  };
  let branches = 0;
  const pushBranch = () => {
    const k = ++branches;
    const branch = `feature-${k}`;
    const sha = `sha-${k}`;
    const file = `src/f${k}.ts`;
    commits.set(sha, { author: user, date: now(), file, parent: heads.get(defaultBranch), message: `add ${file}` });
    heads.set(branch, sha);
    return { branch, file };
  };
  return {
    forge,
    pushBranch,
    // Ветка, отправленная мимо адаптера (например, git push потребителя в тесте).
    setHead(branch: string, sha: string, file = 'README.md', message = `change ${file}`) {
      commits.set(sha, { author: user, date: now(), file, parent: heads.get(branch) ?? heads.get(defaultBranch), message });
      heads.set(branch, sha);
    },
    async tag(name: string, sha: string) {
      tags.set(name, sha);
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

// Чат в памяти: тест говорит в канал через say, ответы и сообщения бота - в sent.
export function memoryChat() {
  const sent: { channel: string; text: string; replyTo?: string }[] = [];
  let handler: ((m: ChatMessage) => Promise<void>) | undefined;
  let seq = 0;
  const chat: Chat = {
    listen(onMessage) {
      handler = onMessage;
      return { close: () => (handler = undefined) };
    },
    async reply(to, text) {
      sent.push({ channel: to.channel, text, replyTo: to.id });
    },
    async post(channel, text) {
      sent.push({ channel, text });
    },
  };
  return {
    chat,
    sent,
    // authorId - учётка в чате; вебхук - сообщение без учётки.
    async say(channel: string, text: string, mentionsMe = false, authorId = 'u-1', viaWebhook = false) {
      await handler?.({ id: `m-${++seq}`, channel, text, author: 'человек', authorId, mentionsMe, ...(viaWebhook ? { viaWebhook } : {}) });
    },
  };
}

type MemoryPage = { id: string; body: string; labels: string[]; version: number; comments: string[]; author?: string };

// user - учётка, от лица которой пишутся страницы; автора версии тест может сменить в pages.
export function memoryWiki(user = 'factory-bot'): Wiki & { pages: Map<string, MemoryPage> } {
  const pages = new Map<string, MemoryPage>();
  let seq = 0;
  const page = (title: string, p: MemoryPage) => ({
    id: p.id,
    title,
    url: `http://memory/wiki/${p.id}`,
    body: p.body,
    version: p.version,
    ...(p.author ? { author: p.author } : {}),
  });
  const byId = (id: string) => [...pages.entries()].find(([, p]) => p.id === id);
  return {
    pages,
    async upsertPage(title, body) {
      const old = pages.get(title);
      const id = old?.id ?? String(++seq);
      pages.set(title, {
        id,
        body,
        labels: old?.labels ?? [],
        version: (old?.version ?? 0) + 1,
        comments: old?.comments ?? [],
        author: user,
      });
      return { id, url: `http://memory/wiki/${id}` };
    },
    async getPage(title) {
      const p = pages.get(title);
      return p ? { id: p.id, body: p.body, url: `http://memory/wiki/${p.id}` } : undefined;
    },
    async pagesByLabel(label) {
      return [...pages.entries()].filter(([, p]) => p.labels.includes(label)).map(([t, p]) => page(t, p));
    },
    async search(text, limit = 8) {
      const q = stems(text);
      return [...pages.entries()]
        .filter(([t, p]) => [...stems(`${t} ${p.body}`)].some((w) => q.has(w)))
        .slice(0, limit)
        .map(([t, p]) => page(t, p));
    },
    async addLabel(pageId, label) {
      const e = byId(pageId);
      if (!e) throw new PortError('not_found', `нет страницы ${pageId}`);
      e[1].labels = [...new Set([...e[1].labels, label])];
    },
    async comment(pageId, text) {
      const e = byId(pageId);
      if (!e) throw new PortError('not_found', `нет страницы ${pageId}`);
      e[1].comments.push(text);
    },
  };
}

// Сбор ошибок в памяти: тест заводит ошибку и повторяет её событиями.
export function memoryIncidents() {
  const list = new Map<string, Incident & { resolved: boolean }>();
  let seq = 0;
  const incidents: Incidents = {
    async open() {
      return [...list.values()].filter((i) => !i.resolved).map(({ resolved: _, ...i }) => ({ ...i }));
    },
    async resolve(id) {
      const i = list.get(id);
      if (i) i.resolved = true;
    },
  };
  return {
    incidents,
    // Событие ошибки: новая ошибка или повтор той же (count растёт, решённая открывается снова).
    event(title: string, culprit = 'POST /api/draws/:id/entries') {
      const old = [...list.values()].find((i) => i.title === title);
      if (old) {
        old.count++;
        old.resolved = false;
        return old.id;
      }
      const id = String(++seq);
      list.set(id, {
        id,
        title,
        culprit,
        count: 1,
        lastSeen: new Date().toISOString(),
        url: `http://memory/issues/${id}`,
        resolved: false,
      });
      return id;
    },
  };
}
