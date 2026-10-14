// Порты фабрики: трекер задач, git-хостинг, исполнитель заданий, база знаний и канал команды.
// Потребители (агенты, мосты, отчёты, координатор) знают только эти контракты; носитель
// (Forgejo, Bitbucket, Jira, GitHub, Discord, документы в git) - адаптер за ними.
// Семантика выровнена по harness: задача - ключ строкой, метки по имени, статусы PR
// и коммитов без меток PR (у Bitbucket их нет).

export type PortErrorCode = 'not_found' | 'conflict' | 'auth' | 'unavailable' | 'invalid';

export class PortError extends Error {
  readonly code: PortErrorCode;
  constructor(code: PortErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type IssueState = 'open' | 'closed';

// Ключ задачи - строка: "12" у Forgejo, "GRM-12" у Jira.
export interface Issue {
  key: string;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  url: string;
}

export interface Comment {
  author: string;
  body: string;
  createdAt: string;
}

export interface LabelEvent {
  label: string;
  action: 'added' | 'removed';
  at: string;
}

export interface IssueQuery {
  state?: IssueState | 'all';
  label?: string;
  text?: string; // поиск по названию и описанию; "слово*" - по началу слова
  limit?: number;
}

// Трекер одного проекта: у Forgejo - задачи репозитория, у Jira - проект.
export interface Tracker {
  getIssue(key: string): Promise<Issue>;
  listIssues(q?: IssueQuery): Promise<Issue[]>;
  createIssue(i: { title: string; body: string; labels?: string[] }): Promise<Issue>;
  addComment(key: string, body: string): Promise<void>;
  listComments(key: string): Promise<Comment[]>;
  addLabel(key: string, label: string): Promise<void>;
  removeLabel(key: string, label: string): Promise<void>;
  close(key: string): Promise<void>;
  reopen(key: string): Promise<void>;
  linkDependency(key: string, dependsOn: string): Promise<void>;
  listDependencies(key: string): Promise<string[]>;
  labelEvents(key: string): Promise<LabelEvent[]>;
}

export type PullState = 'open' | 'merged' | 'closed';

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: PullState;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  author: string;
  url: string;
}

export interface PullCommit {
  sha: string;
  author: string;
  date: string;
}

export interface Review {
  author: string;
  state: 'approved' | 'changes_requested' | 'commented';
}

export type StatusState = 'pending' | 'success' | 'failure' | 'error';

export interface CommitStatus {
  key: string;
  state: StatusState;
  description: string;
  url?: string;
}

export interface RepoInfo {
  webUrl: string;
  defaultBranch: string;
}

// Git-хостинг одного репозитория.
export interface Forge {
  repo(): Promise<RepoInfo>;
  branchHead(branch: string): Promise<string | undefined>;
  commitDate(sha: string): Promise<string>;
  getPull(n: number): Promise<Pull>;
  listPulls(q?: { state?: PullState | 'all'; limit?: number }): Promise<Pull[]>;
  findPullByBranch(branch: string): Promise<Pull | undefined>;
  // Открыть PR из уже отправленной ветки head в base.
  openPull(p: { title: string; body: string; head: string; base: string }): Promise<Pull>;
  pullCommits(n: number): Promise<PullCommit[]>;
  pullDiff(n: number): Promise<string>;
  pullReviews(n: number): Promise<Review[]>;
  commentPull(n: number, body: string): Promise<void>;
  listPullComments(n: number): Promise<Comment[]>;
  setStatus(sha: string, s: CommitStatus): Promise<void>;
  statuses(sha: string): Promise<CommitStatus[]>;
  requiredChecks(branch: string): Promise<string[]>;
  // Теги репозитория с коммитами; новые - первыми.
  tags(): Promise<{ name: string; sha: string }[]>;
  // Коммиты, достижимые из head и недостижимые из base (base не задан - последние из head).
  commits(base: string | undefined, head: string): Promise<{ sha: string; message: string }[]>;
}

export type JobState = 'pending' | 'running' | 'success' | 'failed' | 'stopped';

export interface Job {
  id: string;
  state: JobState;
  url: string;
}

// Исполнитель заданий (CI) репозитория фабрики: запуск названного задания с переменными.
// Секреты исполнитель скрывает в журналах; данные задания туда не кладутся.
export interface JobRunner {
  start(p: { job: string; variables?: Record<string, string>; secrets?: Record<string, string> }): Promise<Job>;
  get(id: string): Promise<Job>;
  stop(id: string): Promise<void>;
}

// Отрывок знания с источником: по ссылке человек проверяет, откуда взято.
export interface Passage {
  source: string; // путь или ключ источника
  title: string; // заголовок раздела
  text: string;
  url: string;
}

// База знаний: поиск отрывков по вопросу. Носители - документы в git (сейчас), ядро на
// PostgreSQL (решение 14.10).
export interface Knowledge {
  search(query: string, limit?: number): Promise<Passage[]>;
}

// Канал команды: сообщение людям.
export interface Notifier {
  post(text: string): Promise<void>;
}

export interface ChatMessage {
  id: string;
  channel: string; // имя канала
  text: string;
  author: string;
  mentionsMe: boolean; // сообщение обращено к боту фабрики
}

// Чат команды: входящие сообщения, ответы и сообщения в канал по имени.
export interface Chat {
  listen(onMessage: (m: ChatMessage) => Promise<void>): { close(): void };
  reply(to: ChatMessage, text: string): Promise<void>;
  post(channel: string, text: string): Promise<void>;
}
