// GitHub для участников съёмки: ИИ-персонаж действует в репозитории цели своим приложением GitHub
// (GitHub App, scripts/persona-github-app-add.sh) - ветка с коммитом, PR, слияние. Коммиты и PR
// подписаны приложением ("<имя>[bot]"). Ключ приложения - из каталога состояния, в журнал не идёт.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from './script.ts';

const API = 'https://api.github.com';
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export interface PullRef {
  number: number;
  url: string;
  head: string;
  sha: string;
}

export function persona(state: string, id: string) {
  const env = parseEnv(readFileSync(join(state, `github-app-${id}.env`), 'utf8'));
  const pem = readFileSync(join(state, `github-app-${id}.pem`), 'utf8');
  const repo = env.GITHUB_TARGET_REPO ?? '';
  let token: { value: string; until: number } | undefined;

  // Токен установки приложения живёт час; берём новый за пять минут до конца.
  async function auth(): Promise<string> {
    if (token && token.until - Date.now() > 300_000) return token.value;
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }))}`;
    const jwt = `${body}.${b64url(createSign('RSA-SHA256').update(body).sign(pem))}`;
    const r = await fetch(`${API}/app/installations/${env.GITHUB_APP_INSTALLATION}/access_tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json' },
    });
    if (!r.ok) throw new Error(`GitHub: токен приложения ${env.GITHUB_APP_SLUG}: ${r.status}`);
    const t = (await r.json()) as { token: string; expires_at: string };
    token = { value: t.token, until: Date.parse(t.expires_at) };
    return token.value;
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${API}/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await auth()}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (r.status === 204 ? undefined : await r.json()) as T;
  }

  return {
    slug: env.GITHUB_APP_SLUG ?? id,
    // Текст файла в ветке; нет файла - undefined.
    async read(path: string, ref = 'main'): Promise<string | undefined> {
      try {
        const f = await call<{ content: string }>('GET', `/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`);
        return Buffer.from(f.content, 'base64').toString('utf8');
      } catch (e) {
        if (String(e).includes(': 404')) return undefined;
        throw e;
      }
    },
    // Ветка от base с одним коммитом всех файлов и PR из неё.
    async openPull(p: { base: string; branch: string; title: string; body: string; files: Record<string, string> }): Promise<PullRef> {
      const base = await call<{ object: { sha: string } }>('GET', `/git/ref/heads/${p.base}`);
      const parent = await call<{ tree: { sha: string } }>('GET', `/git/commits/${base.object.sha}`);
      const tree = await call<{ sha: string }>('POST', '/git/trees', {
        base_tree: parent.tree.sha,
        tree: Object.entries(p.files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
      });
      const commit = await call<{ sha: string }>('POST', '/git/commits', {
        message: p.title,
        tree: tree.sha,
        parents: [base.object.sha],
      });
      await call('POST', '/git/refs', { ref: `refs/heads/${p.branch}`, sha: commit.sha });
      const pr = await call<{ number: number; html_url: string }>('POST', '/pulls', {
        title: p.title,
        body: p.body,
        head: p.branch,
        base: p.base,
      });
      return { number: pr.number, url: pr.html_url, head: p.branch, sha: commit.sha };
    },
    async merge(n: number, title: string): Promise<void> {
      await call('PUT', `/pulls/${n}/merge`, { merge_method: 'squash', commit_title: `${title} (#${n})` });
    },
    async comment(n: number, text: string): Promise<void> {
      await call('POST', `/issues/${n}/comments`, { body: text });
    },
    async closePull(n: number): Promise<void> {
      await call('PATCH', `/pulls/${n}`, { state: 'closed' });
    },
    // Лёгкий тег на вершине ветки.
    async tag(name: string, branch = 'main'): Promise<string> {
      const head = await call<{ object: { sha: string } }>('GET', `/git/ref/heads/${branch}`);
      await call('POST', '/git/refs', { ref: `refs/tags/${name}`, sha: head.object.sha });
      return head.object.sha;
    },
  };
}
