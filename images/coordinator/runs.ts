// Запуски координатора на диске: каталог на запуск с задачей, рабочей копией для шага
// (git bundle) и итогом шага. Разовый ключ запуска хранится только хэшем и живёт ограниченное время.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RunMeta {
  runId: string;
  issue: string;
  tokenHash: string;
  createdAt: string;
  envServed: boolean;
  done: boolean;
  baseBranch?: string;
  baseSha?: string;
  jobId?: string;
  jobUrl?: string;
  // Вид задания: агент (по умолчанию) или проверка - судья PR, сверка макета, e2e на стенде,
  // сканеры изменения.
  kind?: RunKind;
  subject?: string; // что проверяет проверка: PR и коммит, задача, коммит стенда
  reported?: boolean; // итог проверки уже разобран
  spec?: string; // изменение OpenSpec задачи в базе (openspec/changes/<ключ>-<имя>)
}

export type RunKind = 'agent' | 'judge' | 'design' | 'e2e' | 'scan';

export type RunFile =
  | 'task.md'
  | 'repo.bundle'
  | 'repo.tar.gz'
  | 'input'
  | 'agent.patch'
  | 'run.json'
  | 'agent.log'
  | 'secrets.json'
  | 'tests.json'
  | 'result.json'
  | 'codex-auth.json'
  | 'done.json';

export interface RunStore {
  create(runId: string, issue: string, extra?: Pick<RunMeta, 'kind' | 'subject'>): { meta: RunMeta; token: string };
  meta(runId: string): RunMeta | undefined;
  list(): RunMeta[]; // все запуски, старые первыми
  update(runId: string, patch: Partial<RunMeta>): RunMeta;
  byToken(token: string, now?: Date): RunMeta | undefined;
  dir(runId: string): string;
  write(runId: string, file: RunFile, data: string | Uint8Array): void;
  read(runId: string, file: RunFile): Buffer | undefined;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const safeId = (runId: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(runId)) throw new Error(`плохой идентификатор запуска: ${runId}`);
  return runId;
};

export function runStore(root: string, ttlMs = 3 * 60 * 60 * 1000): RunStore {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = (runId: string) => join(root, safeId(runId));
  const metaPath = (runId: string) => join(dir(runId), 'meta.json');
  const meta = (runId: string): RunMeta | undefined =>
    existsSync(metaPath(runId)) ? (JSON.parse(readFileSync(metaPath(runId), 'utf8')) as RunMeta) : undefined;
  const save = (m: RunMeta) => writeFileSync(metaPath(m.runId), JSON.stringify(m, null, 2), { mode: 0o600 });
  return {
    create(runId, issue, extra = {}) {
      if (meta(runId)) throw new Error(`запуск ${runId} уже есть`);
      mkdirSync(dir(runId), { recursive: true, mode: 0o700 });
      const token = randomBytes(32).toString('hex');
      const m: RunMeta = {
        runId,
        issue,
        tokenHash: hash(token),
        createdAt: new Date().toISOString(),
        envServed: false,
        done: false,
        ...extra,
      };
      save(m);
      return { meta: m, token };
    },
    meta,
    list() {
      return readdirSync(root)
        .map((id) => meta(id))
        .filter((m): m is RunMeta => !!m)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    update(runId, patch) {
      const m = meta(runId);
      if (!m) throw new Error(`нет запуска ${runId}`);
      const next = { ...m, ...patch, runId };
      save(next);
      return next;
    },
    byToken(token, now = new Date()) {
      if (!/^[0-9a-f]{64}$/.test(token)) return undefined;
      const h = hash(token);
      for (const id of readdirSync(root)) {
        const m = meta(id);
        if (m?.tokenHash === h) return now.getTime() - Date.parse(m.createdAt) < ttlMs ? m : undefined;
      }
      return undefined;
    },
    dir,
    write(runId, file, data) {
      writeFileSync(join(dir(runId), file), data, { mode: 0o600 });
    },
    read(runId, file) {
      const p = join(dir(runId), file);
      return existsSync(p) ? readFileSync(p) : undefined;
    },
  };
}
