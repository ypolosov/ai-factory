// Выполняет scripts/reconcile-test.sh в отдельном образе задания.
// Обычный make test не запускает команды смены пользователя на машине разработчика.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, test } from 'vitest';

if (process.env.FACTORY_RECONCILE_TEST !== '1') {
  test.skip('сверщик: изолированный образ задания, make reconcile-test', () => {});
} else {
  let root = '';
  let url = '';
  let sha = '';
  let server: Server | undefined;
  let findings: unknown[] = [];
  let createStatus = 201;
  let posts: string[] = [];
  const web = 'https://forge.example/test/project';
  const script = fileURLToPath(new URL('../factory-reconcile', import.meta.url));
  const model = fileURLToPath(new URL('./fixtures/opencode.mjs', import.meta.url));
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org', ...args], { cwd })
      .toString()
      .trim();
  const body = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  };

  beforeAll(async () => {
    assert.equal(process.getuid?.(), 0, 'этот набор запускается только внутри образа задания');
    root = mkdtempSync(join(tmpdir(), 'reconcile-test-'));
    chmodSync(root, 0o755);
    const repo = join(root, 'repo');
    const wiki = join(root, 'wiki');
    for (const [directory, filename, text] of [
      [repo, 'limit.txt', '16 KiB\n'],
      [wiki, 'Home.md', '64 KiB\n'],
    ] as const) {
      mkdirSync(directory);
      git(directory, 'init', '-q', '-b', 'main');
      writeFileSync(join(directory, filename), text);
      git(directory, 'add', '--', filename);
      git(directory, 'commit', '-qm', 'fixture');
    }
    sha = git(repo, 'rev-parse', 'HEAD');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // Подменяется транспорт клонирования, но коммит и снимки файлов - настоящие.
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh
set -eu
if [ "$1" = clone ]; then
  source=; destination=
  for argument; do source=$destination; destination=$argument; done
  case $source in
    *.wiki.git) source=${quote(wiki)} ;;
    *) source=${quote(repo)} ;;
  esac
  exec /usr/bin/git clone -q --depth 1 "file://$source" "$destination"
fi
exec /usr/bin/git "$@"
`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, 'opencode'), `#!/bin/sh\nexec /usr/local/bin/node ${quote(model)}\n`, { mode: 0o755 });
    server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      const path = new URL(request.url ?? '/', 'http://fixture').pathname;
      if (path === '/test/findings') {
        response.end(JSON.stringify({ findings }));
      } else if (path === '/v1/chat/completions') {
        response.end('{}');
      } else if (path === '/api/v1/repos/test/project/labels') {
        response.end(JSON.stringify([{ id: 7, name: 'kb:расхождение' }]));
      } else if (path === '/api/v1/repos/test/project/issues' && request.method === 'GET') {
        response.end('[]');
      } else if (path === '/api/v1/repos/test/project/issues' && request.method === 'POST') {
        posts.push(await body(request));
        response.writeHead(createStatus).end(JSON.stringify({ number: 17 }));
      } else if (path === '/api/v1/repos/test/project') {
        response.end(JSON.stringify({ html_url: web }));
      } else {
        response.writeHead(404).end('{}');
      }
    });
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      const closing = Promise.withResolvers<void>();
      server.close((error) => (error ? closing.reject(error) : closing.resolve()));
      await closing.promise;
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const run = async (result: unknown[], status = 201) => {
    findings = result;
    createStatus = status;
    posts = [];
    const directory = mkdtempSync(join(root, 'run-'));
    chmodSync(directory, 0o755);
    const stdoutPath = join(directory, 'stdout');
    const stderrPath = join(directory, 'stderr');
    const stdoutFd = openSync(stdoutPath, 'w');
    const stderrFd = openSync(stderrPath, 'w');
    try {
      const child = spawn('sh', [script], {
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          TMPDIR: directory,
          FORGEJO_URL: url,
          REPO: 'test/project',
          BOT_TOKEN: 'fixture',
          GATEWAY_URL: url,
          GATEWAY_KEY: 'fixture',
          KB_MCP_URL: '',
        },
        stdio: ['ignore', stdoutFd, stderrFd],
      });
      const exiting = Promise.withResolvers<number | null>();
      child.once('error', exiting.reject);
      child.once('exit', exiting.resolve);
      const code = await exiting.promise;
      return { code, posts, stdout: readFileSync(stdoutPath, 'utf8'), stderr: readFileSync(stderrPath, 'utf8') };
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  };

  const finding = {
    title: 'Разный предел размера',
    kind: 'wiki-vs-code',
    claim: { path: 'wiki/Home.md', line: 1, quote: '64 KiB' },
    evidence: { path: 'repo/limit.txt', line: 1, quote: '16 KiB' },
    explanation: 'Вики и код задают разные пределы.',
    action: 'Уточнить действующий предел и поправить источник.',
  };

  test('нет расхождений: ноль POST и ноль новых задач', async () => {
    const result = await run([]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.posts.length, 0, 'пустой результат не должен создавать задачу');
    assert.match(result.stdout, /новых задач: 0/);
    assert.doesNotMatch(result.stdout, /заведена #/);
  });

  test('одно расхождение: одна задача с обеими цитатами и ссылками', async () => {
    const result = await run([finding]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.posts.length, 1);
    const posted = result.posts.at(0);
    assert.ok(posted);
    const issue = JSON.parse(posted) as { body: string };
    assert.ok(issue.body.includes(`${web}/wiki/Home`));
    assert.ok(issue.body.includes(`${web}/src/commit/${sha}/limit.txt#L1`));
    assert.ok(issue.body.includes('> 64 KiB'));
    assert.ok(issue.body.includes('> 16 KiB'));
    assert.match(result.stdout, /заведена #17/);
    assert.match(result.stdout, /новых задач: 1/);
  });

  test('ошибка POST: ненулевой код без сообщения об успешной публикации', async () => {
    const result = await run([finding], 500);
    assert.equal(result.posts.length, 1);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /500/);
    assert.doesNotMatch(result.stdout, /заведена #/);
    assert.doesNotMatch(result.stdout, /новых задач: 1/);
  });
}
