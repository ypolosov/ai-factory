// Шаг "e2e на стенде" на своём раннере: берёт у посредника координатора исходники цели (архив
// коммита стенда) и адрес стенда, запускает сквозные проверки цели (Playwright) против стенда
// и сдаёт итог. Вход: BROKER_URL, RUN_TOKEN (разовый ключ запуска). Запуск: node factory-e2e.ts
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const broker = process.env.BROKER_URL ?? '';
const auth = { authorization: `Bearer ${process.env.RUN_TOKEN ?? ''}` };
delete process.env.RUN_TOKEN;

async function get(path: string): Promise<Response> {
  const r = await fetch(`${broker}/v1/${path}`, { headers: auth });
  if (!r.ok) throw new Error(`посредник ${path}: ${r.status}`);
  return r;
}

async function put(name: string, body: string): Promise<void> {
  await fetch(`${broker}/v1/files/${name}`, { method: 'PUT', headers: auth, body });
}

interface Spec {
  title: string;
  ok: boolean;
}

// Отчёт Playwright JSON -> счёт и названия проверок.
export function summarize(report: { stats?: Record<string, number>; suites?: unknown[] }) {
  const specs: Spec[] = [];
  const walk = (s: { title?: string; specs?: { title: string; ok: boolean }[]; suites?: unknown[] }, path: string[]) => {
    for (const sp of s.specs ?? []) specs.push({ title: [...path, sp.title].filter(Boolean).join(' > '), ok: sp.ok });
    for (const child of (s.suites ?? []) as (typeof s)[]) walk(child, [...path, child.title ?? '']);
  };
  for (const s of (report.suites ?? []) as Parameters<typeof walk>[0][]) walk(s, [s.title ?? '']);
  const st = report.stats ?? {};
  return { passed: (st.expected ?? 0) + (st.flaky ?? 0), failed: st.unexpected ?? 0, skipped: st.skipped ?? 0, specs };
}

// Стенд - по адресу в сети шагов, а браузер считает защищённым (crypto.subtle и т. п.) только
// https и localhost: стенд пробрасывается на localhost шага, проверки идут как у человека.
async function viaLocalhost(base: string): Promise<{ url: string; server?: Server }> {
  const u = new URL(base);
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return { url: base };
  const port = Number(u.port || 80);
  const server = createServer((c) => {
    const up = createConnection(port, u.hostname);
    c.pipe(up).pipe(c);
    c.on('error', () => up.destroy());
    up.on('error', () => c.destroy());
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return { url: `${u.protocol}//127.0.0.1:${port}${u.pathname === '/' ? '' : u.pathname}`, server };
}

async function main(): Promise<number> {
  const env = (await (await get('env')).json()) as Record<string, string>;
  for (const [k, v] of Object.entries(env)) if (/^[A-Z][A-Z0-9_]*$/.test(k)) process.env[k] = v;
  const stand = process.env.E2E_BASE_URL ?? '';
  const local = await viaLocalhost(stand);
  process.env.E2E_BASE_URL = local.url;
  const work = mkdtempSync(join(tmpdir(), 'e2e-'));
  writeFileSync(join(work, 'repo.tar.gz'), new Uint8Array(await (await get('repo')).arrayBuffer()));
  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: join(work, 'repo'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  mkdirSync(join(work, 'repo'));
  spawnSync('tar', ['-xzf', join(work, 'repo.tar.gz'), '-C', join(work, 'repo')]);
  const ci = run('npm', ['ci', '--no-audit', '--no-fund']);
  let log = `npm ci: ${ci.status}\n${(ci.stderr ?? '').slice(-3000)}\n`;
  if (ci.status !== 0) {
    await put('agent.log', log);
    await put('result.json', JSON.stringify({ error: 'npm ci не прошёл', passed: 0, failed: 0, skipped: 0, specs: [] }));
    return 1;
  }
  const pw = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    // Асинхронно: проброс стенда работает в этом же процессе.
    const child = spawn('npx', ['playwright', 'test', '--config', 'e2e/playwright.config.ts', '--reporter=json'], {
      cwd: join(work, 'repo'),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  local.server?.close();
  log += `playwright: ${pw.status}\n${(pw.stderr ?? '').slice(-5000)}\n`;
  let result: object;
  try {
    result = { base: stand, ...summarize(JSON.parse(pw.stdout)) };
  } catch {
    result = { error: 'отчёт Playwright не читается', passed: 0, failed: 0, skipped: 0, specs: [] };
  }
  await put('agent.log', log);
  await put('result.json', JSON.stringify(result));
  return pw.status ?? 1;
}

if (process.argv[1]?.endsWith('factory-e2e.ts')) {
  let code = 1;
  try {
    code = await main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
  }
  await fetch(`${broker}/v1/done`, { method: 'POST', headers: auth, body: JSON.stringify({ exit_code: code }) }).catch(() => undefined);
  console.log(`e2e на стенде закончены с кодом ${code}`);
  process.exit(code);
}
