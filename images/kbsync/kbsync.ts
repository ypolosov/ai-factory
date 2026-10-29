// Загрузка Forgejo -> Hindsight. Служба забирает основную ветку, вики,
// задачи и PR с комментариями и сохраняет каждую исходную запись одним документом.
// Ссылки секций ведут на исходный файл или обсуждение в Forgejo.
// Окружение: FORGEJO_URL, FORGEJO_PUBLIC_URL, KB_URL, KB_BANK_ID, KB_REPOS,
// KB_SYNC_INTERVAL. Секреты в SECRETS_DIR: forgejo.token, hindsight.token.
import { readFileSync } from 'node:fs';

export type Fetch = typeof fetch;

export interface Config {
  forgejoUrl: string;
  publicUrl: string;
  kbUrl: string;
  bankId: string;
  forgejoToken: string;
  hindsightToken: string;
  repos: string[];
}

export interface Section {
  type: 'text';
  text: string;
  link: string;
}

export interface Doc {
  id: string;
  title: string;
  sections: Section[];
  metadata: Record<string, string>;
  strategy: 'documents' | 'discussions';
  timestamp?: string;
}

const TEXT_FILE = /\.(md|markdown|txt|ts|js|mjs|json|ya?ml|feature|sh|toml|html|css)$|(^|\/)(Dockerfile|Makefile|AGENTS\.md|README)$/i;
const SKIP_PATH = /(^|\/)(node_modules|\.git|dist|coverage|reports)\/|package-lock\.json$/;
const FILE_LIMIT = 200_000;
const CHUNK_LINES = 60;
const SOURCE_PAGE_SIZE = 50;
const HINDSIGHT_PAGE_SIZE = 100;

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

async function forgejoPages<T>(cfg: Config, fetchFn: Fetch, path: string): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; ; page++) {
    const separator = path.includes('?') ? '&' : '?';
    const batch = (await (await forgejo(cfg, fetchFn, `${path}${separator}limit=${SOURCE_PAGE_SIZE}&page=${page}`)).json()) as T[];
    result.push(...batch);
    if (batch.length < SOURCE_PAGE_SIZE) return result;
  }
}

interface ForgejoIssue {
  number: number;
  title: string;
  body: string;
  html_url: string;
  updated_at: string;
  state: string;
}

interface ForgejoComment {
  body: string;
  html_url: string;
  user: { login: string };
}

function documentStrategy(path: string): Doc['strategy'] {
  return /(^|\/)(?:adr|adrs|decisions)(\/|$)|(^|\/)design\.md$/i.test(path) ? 'discussions' : 'documents';
}

export async function repoDocs(cfg: Config, fetchFn: Fetch, repo: string): Promise<{ sha: string; docs: Doc[] }> {
  const branch = (await (await forgejo(cfg, fetchFn, `/repos/${repo}/branches/main`)).json()) as {
    commit: { id: string; timestamp?: string };
  };
  const sha = branch.commit.id;
  const tree = (await (await forgejo(cfg, fetchFn, `/repos/${repo}/git/trees/${sha}?recursive=true&per_page=10000`)).json()) as {
    tree: { path: string; type: string; size: number }[];
    truncated?: boolean;
  };
  if (tree.truncated) throw new Error(`Forgejo tree ${repo}@${sha} is incomplete`);
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
      title: `${name}: ${f.path}`,
      sections,
      metadata: { repo, kind: 'file', path: f.path, commit: sha },
      strategy: documentStrategy(f.path),
      ...(branch.commit.timestamp ? { timestamp: branch.commit.timestamp } : {}),
    });
  }

  // Вики репозитория: 404 означает отсутствие вики; остальные ошибки прерывают синхронизацию.
  const wikiPath = `/repos/${repo}/wiki/pages?limit=${SOURCE_PAGE_SIZE}&page=1`;
  const firstWikiPage = await fetchFn(`${cfg.forgejoUrl}/api/v1${wikiPath}`, {
    headers: { authorization: `token ${cfg.forgejoToken}` },
    signal: AbortSignal.timeout(30000),
  });
  if (firstWikiPage.ok) {
    const pages = [...((await firstWikiPage.json()) as { title: string; sub_url: string }[])];
    if (pages.length === SOURCE_PAGE_SIZE) {
      pages.push(
        ...(await forgejoPages<{ title: string; sub_url: string }>(cfg, fetchFn, `/repos/${repo}/wiki/pages`)).slice(SOURCE_PAGE_SIZE),
      );
    }
    for (const pg of pages) {
      const page = (await (await forgejo(cfg, fetchFn, `/repos/${repo}/wiki/page/${encodeURI(pg.sub_url)}`)).json()) as {
        content_base64: string;
        html_url: string;
        last_commit?: { created?: string };
      };
      const text = Buffer.from(page.content_base64 ?? '', 'base64').toString('utf-8');
      const sections = splitFile(text, `${pg.title}.md`, page.html_url.replace(cfg.forgejoUrl, cfg.publicUrl));
      if (sections.length === 0) continue;
      docs.push({
        id: `forgejo:${repo}:wiki:${pg.sub_url}`,
        title: `${name} вики: ${pg.title}`,
        sections,
        metadata: { repo, kind: 'wiki', page: pg.title },
        strategy: 'documents',
        ...(page.last_commit?.created ? { timestamp: page.last_commit.created } : {}),
      });
    }
  } else if (firstWikiPage.status !== 404) {
    throw new Error(`Forgejo ${wikiPath}: HTTP ${firstWikiPage.status}`);
  }

  // Задачи и PR - с обсуждением: там решения человека и причины изменений.
  for (const type of ['issues', 'pulls'] as const) {
    const items = await forgejoPages<ForgejoIssue>(cfg, fetchFn, `/repos/${repo}/issues?state=all&type=${type}`);
    for (const it of items) {
      const comments = await forgejoPages<ForgejoComment>(cfg, fetchFn, `/repos/${repo}/issues/${it.number}/comments`);
      const link = it.html_url.replace(cfg.forgejoUrl, cfg.publicUrl);
      const kind = type === 'issues' ? 'issue' : 'pr';
      docs.push({
        id: `forgejo:${repo}:${kind}:${it.number}`,
        title: `${name} ${kind === 'issue' ? 'задача' : 'PR'} #${it.number}: ${it.title}`,
        sections: [
          { type: 'text', text: `${it.title}\n\n${it.body ?? ''}`.trim(), link },
          ...comments
            .filter((c) => c.body?.trim())
            .map((c) => ({
              type: 'text' as const,
              text: `${c.user.login}: ${c.body}`,
              link: c.html_url.replace(cfg.forgejoUrl, cfg.publicUrl),
            })),
        ],
        metadata: { repo, kind, number: String(it.number), state: it.state },
        strategy: 'discussions',
        timestamp: it.updated_at,
      });
    }
  }
  return { sha, docs };
}

interface HindsightDocument {
  id: string;
}

async function hindsight(cfg: Config, fetchFn: Fetch, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetchFn(`${cfg.kbUrl}/v1/default/banks/${encodeURIComponent(cfg.bankId)}${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.hindsightToken}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(330000),
  });
  if (!res.ok) throw new Error(`Hindsight ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function hindsightDocuments(cfg: Config, fetchFn: Fetch): Promise<HindsightDocument[]> {
  const documents: HindsightDocument[] = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const result = (await hindsight(cfg, fetchFn, 'GET', `/documents?limit=${HINDSIGHT_PAGE_SIZE}&offset=${offset}`)) as {
      items: HindsightDocument[];
      total: number;
    };
    documents.push(...result.items);
    total = result.total;
    offset += result.items.length;
    if (result.items.length === 0 && offset < total) throw new Error('Hindsight documents pagination returned no items before total');
  }
  return documents;
}

function retainItems(doc: Doc): Record<string, unknown>[] {
  return doc.sections.map((section) => ({
    content: section.text,
    context: `${doc.title}\nSource: ${section.link}\nRepository: ${doc.metadata.repo}\nKind: ${doc.metadata.kind}`,
    metadata: { ...doc.metadata, title: doc.title, source_url: section.link },
    document_id: doc.id,
    ...(doc.timestamp ? { timestamp: doc.timestamp } : {}),
    strategy: doc.strategy,
  }));
}

// Загрузить все источники и текущий список до записей; удалять устаревшее только
// если все retain завершились успешно.
export async function syncRepo(cfg: Config, fetchFn: Fetch, repo: string): Promise<{ upserted: number; deleted: number }> {
  const { docs } = await repoDocs(cfg, fetchFn, repo);
  const have = await hindsightDocuments(cfg, fetchFn);
  for (const doc of docs) {
    await hindsight(cfg, fetchFn, 'POST', '/memories', { items: retainItems(doc), async: false });
  }
  const keep = new Set(docs.map((d) => d.id));
  const stale = have.map((d) => d.id).filter((id) => id.startsWith(`forgejo:${repo}:`) && !keep.has(id));
  for (const id of stale) await hindsight(cfg, fetchFn, 'DELETE', `/documents/${encodeURIComponent(id)}`);
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
  const dir = env.SECRETS_DIR ?? '/secrets';
  const secret = (name: string): string => readFileSync(`${dir}/${name}`, 'utf-8').trim();
  return {
    forgejoUrl: env.FORGEJO_URL ?? 'http://forgejo:3000',
    publicUrl: env.FORGEJO_PUBLIC_URL ?? 'http://127.0.0.1:3000',
    kbUrl: env.KB_URL ?? 'http://kb:8888',
    bankId: env.KB_BANK_ID ?? 'factory',
    forgejoToken: secret('forgejo.token'),
    hindsightToken: secret('hindsight.token'),
    repos: (env.KB_REPOS ?? '').split(/\s+/).filter(Boolean),
  };
}

if (import.meta.main) {
  const cfg = configFromEnv();
  const interval = Number(process.env.KB_SYNC_INTERVAL ?? 120) * 1000;
  console.log(`kbsync: ${cfg.repos.join(' ')} -> ${cfg.kbUrl}, банк ${cfg.bankId}, раз в ${interval / 1000} с`);
  void loop(cfg, fetch, interval, console.log);
}
