// Контракт хостинга на живом GitHub: песочница ypolosov/factory-contract-tests.
// Запуск - scripts/port-contract-saas.sh; без GITHUB_TEST_REPO и GITHUB_TEST_TOKEN - пропуск.
// Песочница не удаляется (у токена нет прав администратора): тесты закрывают свои PR
// и удаляют свои ветки.
import { test } from 'node:test';
import { githubForge } from '../github.ts';
import { forgeContract } from './contract.ts';

const repo = process.env.GITHUB_TEST_REPO;
const token = process.env.GITHUB_TEST_TOKEN;

if (!repo || !token) {
  test('контракт GitHub: нет GITHUB_TEST_REPO и GITHUB_TEST_TOKEN', { skip: true }, () => {});
} else {
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? undefined : r.json();
  };

  forgeContract('GitHub', async () => {
    const run = Math.random().toString(16).slice(2, 8);
    const made: { n: number; branch: string }[] = [];
    let seq = 0;
    return {
      forge: githubForge({ repo, token }),
      openPull: async () => {
        const base = ((await call('GET', '')) as { default_branch: string }).default_branch;
        const head = ((await call('GET', `/git/ref/heads/${base}`)) as { object: { sha: string } }).object.sha;
        const branch = `contract-${run}-${++seq}`;
        const file = `src/f-${run}-${seq}.ts`;
        await call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: head });
        await call('PUT', `/contents/${file}`, {
          message: `add ${file}`,
          content: Buffer.from(`export const f = ${seq};\n`).toString('base64'),
          branch,
        });
        const p = (await call('POST', '/pulls', { title: `contract ${run} ${seq}`, head: branch, base })) as { number: number };
        made.push({ n: p.number, branch });
        return { n: p.number, branch, file };
      },
      cleanup: async () => {
        for (const m of made) {
          await call('PATCH', `/pulls/${m.n}`, { state: 'closed' });
          await call('DELETE', `/git/refs/heads/${m.branch}`);
        }
      },
    };
  });
}
