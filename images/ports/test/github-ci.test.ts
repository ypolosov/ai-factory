// CI цели в GitHub Actions вживую: прогоны коммита в песочнице без workflows - пусто;
// перезапуск проверяется на цели демо (scripts/port-contract-saas.sh github + GITHUB_CI_RERUN_RUN).
import { expect, test } from 'vitest';
import { githubCi } from '../github.ts';

const repo = process.env.GITHUB_TEST_REPO;
const token = process.env.GITHUB_TEST_TOKEN;

if (!repo || !token) {
  test.skip('CI GitHub: нет GITHUB_TEST_REPO и GITHUB_TEST_TOKEN', () => {});
} else {
  test('у коммита без workflows прогонов нет', async () => {
    const head = (
      (await (
        await fetch(`https://api.github.com/repos/${repo}/commits/HEAD`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as { sha: string }
    ).sha;
    expect(await githubCi({ repo, token }).runs(head)).toEqual([]);
  });
}
