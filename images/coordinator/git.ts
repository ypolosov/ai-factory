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
  token: string;
}

export interface Git {
  // Клон ветки цели в КАТАЛОГ/repo и bundle КАТАЛОГ/repo.bundle для шага.
  prepare(dir: string, branch: string): Promise<{ baseSha: string }>;
  // Патч КАТАЛОГ/agent.patch -> коммит в новой ветке поверх базы -> push. Возвращает голову ветки.
  publish(dir: string, p: { branch: string; message: string }): Promise<{ headSha: string }>;
  // Рабочая копия ветки в КАТАЛОГЕ - клон или обновление до вершины ветки.
  sync(dir: string, branch: string): Promise<{ sha: string }>;
  // Файлы -> коммит в новой ветке поверх клона КАТАЛОГ/repo (после prepare) -> push.
  commitFiles(dir: string, p: { branch: string; message: string; files: Record<string, string> }): Promise<{ headSha: string }>;
}

export interface GitConfig {
  url: string; // адрес клона цели
  read?: GitAuth;
  write?: GitAuth;
  author: { name: string; email: string };
}

function authEnv(url: string, auth?: GitAuth): Record<string, string> {
  if (!auth || !/^https?:/.test(url)) return {};
  const origin = new URL(url).origin;
  const basic = Buffer.from(`${auth.user}:${auth.token}`).toString('base64');
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
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...authEnv(cfg.url, auth) },
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout.trim();
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
      await g(repo, ['checkout', '--quiet', '-b', branch]);
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
    async sync(dir, branch) {
      if (!existsSync(join(dir, '.git'))) {
        mkdirSync(dirname(dir), { recursive: true });
        await g(dirname(dir), ['clone', '--quiet', '--single-branch', '--branch', branch, cfg.url, dir], cfg.read);
      } else {
        await g(dir, ['fetch', '--quiet', 'origin', branch], cfg.read);
        await g(dir, ['reset', '--quiet', '--hard', 'FETCH_HEAD']);
      }
      return { sha: await g(dir, ['rev-parse', 'HEAD']) };
    },
  };
}
