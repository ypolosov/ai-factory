// Git координатора: рабочая копия цели для шага (bundle) и публикация патча агента в ветку.
// Ключ записи передаётся git только окружением процесса (http.<адрес>.extraHeader), не
// аргументами команды, и только для адреса цели.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitAuth {
  user: string; // x-access-token у GitHub, x-token-auth у Bitbucket
  token: string | (() => Promise<string>); // токен или его источник (приложение GitHub)
}

export interface Git {
  // Клон ветки цели в КАТАЛОГ/repo и bundle КАТАЛОГ/repo.bundle для шага.
  prepare(dir: string, branch: string): Promise<{ baseSha: string }>;
  // Патч КАТАЛОГ/agent.patch -> коммит в ветке поверх базы (новой или, при доработке, ветке прошлой
  // попытки) -> push. Возвращает голову ветки.
  publish(dir: string, p: { branch: string; message: string }): Promise<{ headSha: string }>;
  // Архив tar.gz коммита из рабочей копии КАТАЛОГ.
  archive(dir: string, sha: string): Promise<Buffer>;
  // Рабочая копия ветки в КАТАЛОГЕ - клон или обновление до вершины ветки.
  sync(dir: string, branch: string): Promise<{ sha: string }>;
  // Файлы на общем предке с веткой base и на голове ветки head (обе подтягиваются в рабочую
  // копию КАТАЛОГ). Голова ветки не совпала с headSha (PR сдвинулся) - ошибка.
  changedFiles(
    dir: string,
    p: { base: string; head: string; headSha: string; paths: string[] },
  ): Promise<{ path: string; base?: string; head?: string }[]>;
  // Файлы -> коммит в новой ветке поверх клона КАТАЛОГ/repo (после prepare) -> push.
  commitFiles(dir: string, p: { branch: string; message: string; files: Record<string, string> }): Promise<{ headSha: string }>;
}

export interface GitConfig {
  url: string; // адрес клона цели
  read?: GitAuth;
  write?: GitAuth;
  author: { name: string; email: string };
}

async function authEnv(url: string, auth?: GitAuth): Promise<Record<string, string>> {
  if (!auth || !/^https?:/.test(url)) return {};
  const origin = new URL(url).origin;
  const token = typeof auth.token === 'string' ? auth.token : await auth.token();
  const basic = Buffer.from(`${auth.user}:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

export function git(cfg: GitConfig): Git {
  const g = async (cwd: string, args: string[], auth?: GitAuth) =>
    (
      await run('git', args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(await authEnv(cfg.url, auth)) },
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout.trim();
  async function sync(dir: string, branch: string) {
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(dirname(dir), { recursive: true });
      await g(dirname(dir), ['clone', '--quiet', '--single-branch', '--branch', branch, cfg.url, dir], cfg.read);
    } else {
      await g(dir, ['fetch', '--quiet', 'origin', branch], cfg.read);
      await g(dir, ['reset', '--quiet', '--hard', 'FETCH_HEAD']);
    }
    return { sha: await g(dir, ['rev-parse', 'HEAD']) };
  }
  return {
    async prepare(dir, branch) {
      await g(dir, ['clone', '--quiet', '--single-branch', '--branch', branch, cfg.url, 'repo'], cfg.read);
      const repo = join(dir, 'repo');
      const baseSha = await g(repo, ['rev-parse', 'HEAD']);
      await g(repo, ['bundle', 'create', '--quiet', join(dir, 'repo.bundle'), 'HEAD', branch]);
      return { baseSha };
    },
    async publish(dir, { branch, message }) {
      const repo = join(dir, 'repo');
      const who = ['-c', `user.name=${cfg.author.name}`, '-c', `user.email=${cfg.author.email}`];
      // Доработка: рабочая копия уже на ветке прошлой попытки - коммит ложится поверх неё.
      if ((await g(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== branch) await g(repo, ['checkout', '--quiet', '-b', branch]);
      await g(repo, ['apply', '--index', '--whitespace=nowarn', join(dir, 'agent.patch')]);
      await g(repo, [...who, 'commit', '--quiet', '-m', message]);
      await g(repo, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], cfg.write);
      return { headSha: await g(repo, ['rev-parse', 'HEAD']) };
    },
    async commitFiles(dir, { branch, message, files }) {
      const repo = join(dir, 'repo');
      const who = ['-c', `user.name=${cfg.author.name}`, '-c', `user.email=${cfg.author.email}`];
      await g(repo, ['checkout', '--quiet', '-b', branch]);
      for (const [path, content] of Object.entries(files)) {
        if (path.split('/').includes('..')) throw new Error(`плохой путь ${path}`);
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), content);
        await g(repo, ['add', '--', path]);
      }
      await g(repo, [...who, 'commit', '--quiet', '-m', message]);
      await g(repo, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], cfg.write);
      return { headSha: await g(repo, ['rev-parse', 'HEAD']) };
    },
    async archive(dir, sha) {
      if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`плохой коммит ${sha}`);
      const r = await run('git', ['archive', '--format=tar.gz', sha], { cwd: dir, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
      return r.stdout;
    },
    sync,
    async changedFiles(dir, p) {
      for (const path of p.paths) if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`плохой путь ${path}`);
      await sync(dir, p.base);
      await g(dir, ['fetch', '--quiet', 'origin', p.head], cfg.read);
      const head = await g(dir, ['rev-parse', 'FETCH_HEAD']);
      if (head !== p.headSha) throw new Error(`ветка ${p.head} сдвинулась: ${head.slice(0, 7)} вместо ${p.headSha.slice(0, 7)}`);
      const base = await g(dir, ['merge-base', 'HEAD', head]);
      const show = (sha: string, path: string) => g(dir, ['show', `${sha}:${path}`]).catch(() => undefined);
      const out: { path: string; base?: string; head?: string }[] = [];
      for (const path of p.paths) {
        const [b, h] = [await show(base, path), await show(head, path)];
        out.push({ path, ...(b === undefined ? {} : { base: b }), ...(h === undefined ? {} : { head: h }) });
      }
      return out;
    },
  };
}
