// Контракт хостинга на живом GitHub: песочница ypolosov/factory-contract-tests.
// Запуск - scripts/port-contract-saas.sh; без GITHUB_TEST_REPO и GITHUB_TEST_TOKEN - пропуск.
// Песочница не удаляется (у токена нет прав администратора): тесты закрывают PR
// из своих веток и удаляют ветки.
import { test } from 'vitest';
import { githubForge } from '../github.ts';
import { forgeContract } from './contract.ts';

const repo = process.env.GITHUB_TEST_REPO;
const token = process.env.GITHUB_TEST_TOKEN;

if (!repo || !token) {
  test.skip('контракт GitHub: нет GITHUB_TEST_REPO и GITHUB_TEST_TOKEN', () => {});
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
    const forge = githubForge({ repo, token });
    const branches: string[] = [];
    const tags: string[] = [];
    let seq = 0;
    const base = async () => ((await call('GET', '')) as { default_branch: string }).default_branch;
    const pushBranch = async () => {
      const head = ((await call('GET', `/git/ref/heads/${await base()}`)) as { object: { sha: string } }).object.sha;
      const branch = `contract-${run}-${++seq}`;
      const file = `src/f-${run}-${seq}.ts`;
      await call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: head });
      branches.push(branch);
      await call('PUT', `/contents/${file}`, {
        message: `add ${file}`,
        content: Buffer.from(`export const f = ${seq};\n`).toString('base64'),
        branch,
      });
      return { branch, file };
    };
    return {
      forge,
      pushBranch,
      tag: async (name: string, sha: string) => {
        await call('POST', '/git/refs', { ref: `refs/tags/${name}`, sha });
        tags.push(name);
      },
      openPull: async () => {
        const b = await pushBranch();
        const p = (await call('POST', '/pulls', { title: `contract ${run} ${seq}`, head: b.branch, base: await base() })) as {
          number: number;
        };
        return { n: p.number, ...b };
      },
      cleanup: async () => {
        for (const t of tags) await call('DELETE', `/git/refs/tags/${t}`);
        for (const branch of branches) {
          const p = await forge.findPullByBranch(branch);
          if (p) await call('PATCH', `/pulls/${p.number}`, { state: 'closed' });
          await call('DELETE', `/git/refs/heads/${branch}`);
        }
      },
    };
  });
}
