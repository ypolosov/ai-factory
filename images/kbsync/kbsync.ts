// Загрузка Forgejo -> база знаний (Onyx). Коннектора Forgejo у Onyx нет: служба сама
// забирает из репозиториев основную ветку (текстовые файлы, разбитые по заголовкам и
// кускам с номерами строк), задачи и PR с комментариями и кладёт их в Onyx через его API
// загрузки. Ссылка каждого куска ведёт на файл в Forgejo на этом коммите с номером строки:
// по ней ответ базы цитирует источник. Удалённое из репозитория удаляется и из базы.
//
// Окружение: FORGEJO_URL (внутренний адрес), FORGEJO_PUBLIC_URL (адрес для ссылок),
// KB_URL (Onyx), KB_REPOS ("владелец/имя ..."), KB_SYNC_INTERVAL (с, по умолчанию 120).
// Секреты - файлы в SECRETS_DIR (/secrets): forgejo.token (чтение репозиториев и задач),
// onyx.token (личный токен администратора Onyx).
import { readFileSync } from 'node:fs';

export type Fetch = typeof fetch;

export interface Config {
  forgejoUrl: string;
  publicUrl: string;
  kbUrl: string;
  forgejoToken: string;
  onyxToken: string;
  repos: string[];
}

export interface Section {
  type: 'text';
  text: string;
  link: string;
}

export interface Doc {
  id: string;
  semantic_identifier: string;
  title: string;
  source: 'ingestion_api';
  sections: Section[];
  metadata: Record<string, string>;
  doc_updated_at?: string;
}

const TEXT_FILE = /\.(md|markdown|txt|ts|js|mjs|json|ya?ml|feature|sh|toml|html|css)$|(^|\/)(Dockerfile|Makefile|AGENTS\.md|README)$/i;
const SKIP_PATH = /(^|\/)(node_modules|\.git|dist|coverage|reports)\/|package-lock\.json$/;
const FILE_LIMIT = 200_000;
const CHUNK_LINES = 60;

export function isIndexed(path: string, size: number): boolean {
  return TEXT_FILE.test(path) && !SKIP_PATH.test(path) && size <= FILE_LIMIT;
}

// Текст файла -> куски: Markdown - по заголовкам, остальное - по CHUNK_LINES строк.
// Ссылка куска - на первую строку куска.
export function splitFile(text: string, path: string, fileUrl: string): Section[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  if (/\.(md|markdown)$/i.test(path)) {
    let inFence = false;
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
      if (!inFence && /^#{1,4}\s/.test(l)) starts.push(i);
    });
  }
  if (starts[0] !== 0) starts.unshift(0);
  const sections: Section[] = [];
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1]! : lines.length;
    for (let from = s; from < end; from += CHUNK_LINES) {
      const to = Math.min(end, from + CHUNK_LINES);
      const chunk = lines.slice(from, to).join('\n').trim();
      if (chunk) sections.push({ type: 'text', text: chunk, link: `${fileUrl}#L${from + 1}` });
    }
  });
  return sections;
}

async function forgejo(cfg: Config, fetchFn: Fetch, path: string): Promise<Response> {
  const res = await fetchFn(`${cfg.forgejoUrl}/api/v1${path}`, {
    headers: { authorization: `token ${cfg.forgejoToken}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Forgejo ${path}: HTTP ${res.status}`);
  return res;
}

async function onyx(cfg: Config, fetchFn: Fetch, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetchFn(`${cfg.kbUrl}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.onyxToken}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Onyx ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function repoDocs(cfg: Config, fetchFn: Fetch, repo: string): Promise<{ sha: string; docs: Doc[] }> {
  const branch = (await (await forgejo(cfg, fetchFn, `/repos/${repo}/branches/main`)).json()) as { commit: { id: string; timestamp?: string } };
  const sha = branch.commit.id;
  const tree = (await (await forgejo(cfg, fetchFn, `/repos/${repo}/git/trees/${sha}?recursive=true&per_page=10000`)).json()) as {
    tree: { path: string; type: string; size: number }[];
  };
  const docs: Doc[] = [];
  const name = repo.split('/')[1]!;
  for (const f of tree.tree) {
    if (f.type !== 'blob' || !isIndexed(f.path, f.size)) continue;
    const text = await (await forgejo(cfg, fetchFn, `/repos/${repo}/raw/${encodeURI(f.path)}?ref=${sha}`)).text();
    const fileUrl = `${cfg.publicUrl}/${repo}/src/commit/${sha}/${encodeURI(f.path)}`;
    const sections = splitFile(text, f.path, fileUrl);
    if (sections.length === 0) continue;
    docs.push({
      id: `forgejo:${repo}:file:${f.path}`,
      semantic_identifier: `${name}: ${f.path}`,
      title: `${name}: ${f.path}`,
      source: 'ingestion_api',
      sections,
      metadata: { repo, kind: 'file', path: f.path, commit: sha },
      ...(branch.commit.timestamp ? { doc_updated_at: branch.commit.timestamp } : {}),
    });
  }
  // Задачи и PR - с обсуждением: там решения человека и причины изменений.
  for (const type of ['issues', 'pulls'] as const) {
    const items = (await (await forgejo(cfg, fetchFn, `/repos/${repo}/issues?state=all&type=${type}&limit=50`)).json()) as {
      number: number;
      title: string;
      body: string;
      html_url: string;
      updated_at: string;
      state: string;
    }[];
    for (const it of items) {
      const comments = (await (await forgejo(cfg, fetchFn, `/repos/${repo}/issues/${it.number}/comments?limit=50`)).json()) as {
        body: string;
        html_url: string;
        user: { login: string };
      }[];
      const link = it.html_url.replace(cfg.forgejoUrl, cfg.publicUrl);
      const kind = type === 'issues' ? 'issue' : 'pr';
      docs.push({
        id: `forgejo:${repo}:${kind}:${it.number}`,
        semantic_identifier: `${name} ${kind === 'issue' ? 'задача' : 'PR'} #${it.number}: ${it.title}`,
        title: `${name} ${kind === 'issue' ? 'задача' : 'PR'} #${it.number}: ${it.title}`,
        source: 'ingestion_api',
        sections: [
          { type: 'text', text: `${it.title}\n\n${it.body ?? ''}`.trim(), link },
          ...comments
            .filter((c) => c.body?.trim())
            .map((c) => ({ type: 'text' as const, text: `${c.user.login}: ${c.body}`, link: c.html_url.replace(cfg.forgejoUrl, cfg.publicUrl) })),
        ],
        metadata: { repo, kind, number: String(it.number), state: it.state },
        doc_updated_at: it.updated_at,
      });
    }
  }
  return { sha, docs };
}

// Один проход: загрузить документы репозитория, удалить из базы пропавшие.
export async function syncRepo(cfg: Config, fetchFn: Fetch, repo: string): Promise<{ upserted: number; deleted: number }> {
  const { docs } = await repoDocs(cfg, fetchFn, repo);
  for (const doc of docs) await onyx(cfg, fetchFn, 'POST', '/onyx-api/ingestion', { document: doc });
  const have = ((await onyx(cfg, fetchFn, 'GET', '/onyx-api/ingestion')) ?? []) as { document_id: string }[];
  const keep = new Set(docs.map((d) => d.id));
  const stale = have.map((d) => d.document_id).filter((id) => id.startsWith(`forgejo:${repo}:`) && !keep.has(id));
  for (const id of stale) await onyx(cfg, fetchFn, 'DELETE', `/onyx-api/ingestion/${encodeURIComponent(id)}`);
  return { upserted: docs.length, deleted: stale.length };
}

// Цикл: репозиторий загружается заново, когда меняется его main или прошёл час
// (задачи и комментарии меняются без коммитов).
export async function loop(cfg: Config, fetchFn: Fetch, intervalMs: number, log: (m: string) => void, rounds = Infinity): Promise<void> {
  const seen = new Map<string, { sha: string; at: number }>();
  for (let r = 0; r < rounds; r++) {
    for (const repo of cfg.repos) {
      try {
        const b = (await (await forgejo(cfg, fetchFn, `/repos/${repo}/branches/main`)).json()) as { commit: { id: string } };
        const last = seen.get(repo);
        if (last && last.sha === b.commit.id && Date.now() - last.at < 3600_000) continue;
        const res = await syncRepo(cfg, fetchFn, repo);
        seen.set(repo, { sha: b.commit.id, at: Date.now() });
        log(`${repo}@${b.commit.id.slice(0, 7)}: загружено ${res.upserted}, удалено ${res.deleted}`);
      } catch (err) {
        log(`${repo}: сбой - ${String(err)}`);
      }
    }
    if (r + 1 < rounds) await new Promise((res) => setTimeout(res, intervalMs));
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const dir = env['SECRETS_DIR'] ?? '/secrets';
  const secret = (name: string): string => readFileSync(`${dir}/${name}`, 'utf-8').trim();
  return {
    forgejoUrl: env['FORGEJO_URL'] ?? 'http://forgejo:3000',
    publicUrl: env['FORGEJO_PUBLIC_URL'] ?? 'http://127.0.0.1:3000',
    kbUrl: env['KB_URL'] ?? 'http://kb',
    forgejoToken: secret('forgejo.token'),
    onyxToken: secret('onyx.token'),
    repos: (env['KB_REPOS'] ?? '').split(/\s+/).filter(Boolean),
  };
}

if (import.meta.main) {
  const cfg = configFromEnv();
  const interval = Number(process.env['KB_SYNC_INTERVAL'] ?? 120) * 1000;
  console.log(`kbsync: ${cfg.repos.join(' ')} -> ${cfg.kbUrl}, раз в ${interval / 1000} с`);
  void loop(cfg, fetch, interval, console.log);
}
