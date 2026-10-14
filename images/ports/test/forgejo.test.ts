// Контракт на живом Forgejo: запускает scripts/port-contract.sh в одноразовом
// контейнере. Без FORGEJO_TEST_URL и FORGEJO_TEST_TOKEN (обычный make test) - пропуск.
import { test } from 'vitest';
import { type ForgejoConfig, forgejoForge, forgejoTracker } from '../forgejo.ts';
import { forgeContract, trackerContract } from './contract.ts';

const url = process.env.FORGEJO_TEST_URL;
const token = process.env.FORGEJO_TEST_TOKEN;

if (!url || !token) {
  test.skip('контракт Forgejo: нет FORGEJO_TEST_URL и FORGEJO_TEST_TOKEN', () => {});
} else {
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${url}/api/v1${path}`, {
      method,
      headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? undefined : r.json();
  };
  // Свой репозиторий на каждый набор: наборы не мешают друг другу и удаляются после.
  const makeRepo = async () => {
    const owner = ((await call('GET', '/user')) as { login: string }).login;
    const name = `contract-${Math.random().toString(16).slice(2, 8)}`;
    await call('POST', '/user/repos', { name, auto_init: true, default_branch: 'main' });
    const cfg: ForgejoConfig = { url, publicUrl: url, token, repo: `${owner}/${name}` };
    return { cfg, cleanup: async () => void (await call('DELETE', `/repos/${cfg.repo}`)) };
  };

  trackerContract('Forgejo', async () => {
    const { cfg, cleanup } = await makeRepo();
    return { tracker: forgejoTracker(cfg), cleanup };
  });

  forgeContract('Forgejo', async () => {
    const { cfg, cleanup } = await makeRepo();
    let seq = 0;
    const pushBranch = async () => {
      const branch = `feature-${++seq}`;
      const file = `src/f${seq}.ts`;
      await call('POST', `/repos/${cfg.repo}/contents/${file}`, {
        content: Buffer.from(`export const f = ${seq};\n`).toString('base64'),
        message: `add ${file}`,
        branch: 'main',
        new_branch: branch,
      });
      return { branch, file };
    };
    return {
      forge: forgejoForge(cfg),
      cleanup,
      pushBranch,
      tag: async (name: string, sha: string) => void (await call('POST', `/repos/${cfg.repo}/tags`, { tag_name: name, target: sha })),
      openPull: async () => {
        const b = await pushBranch();
        const p = (await call('POST', `/repos/${cfg.repo}/pulls`, { head: b.branch, base: 'main', title: `PR ${seq}` })) as {
          number: number;
        };
        return { n: p.number, ...b };
      },
    };
  });
}
