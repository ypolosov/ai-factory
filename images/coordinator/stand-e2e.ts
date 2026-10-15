// e2e на стенде по просьбе QA (UC4, UC6): сквозные проверки цели с коммита, что сейчас на
// стенде, на своём раннере против стенда; итог - в канал, откуда попросили.
import type { Forge } from '../ports/ports.ts';
import { type CheckDeps, type CheckHandler, startCheck } from './checks.ts';
import type { Git } from './git.ts';

export interface StandE2eDeps extends CheckDeps {
  forge: Forge;
  git: Git;
  knowledgeDir: string; // рабочая копия ветки по умолчанию цели
  refreshKnowledge(): Promise<void>;
  post(channel: string, text: string): Promise<void>;
}

// Коммит стенда: самый новый коммит ветки по умолчанию со статусом factory/deploy success.
export async function deployedSha(forge: Forge): Promise<string | undefined> {
  const repo = await forge.repo();
  const head = await forge.branchHead(repo.defaultBranch);
  if (!head) return undefined;
  for (const c of (await forge.commits(undefined, head)).slice(-10).reverse()) {
    if ((await forge.statuses(c.sha)).some((s) => s.key === 'factory/deploy' && s.state === 'success')) return c.sha;
  }
  return undefined;
}

export async function startStandE2e(d: StandE2eDeps, channel: string): Promise<string> {
  const sha = await deployedSha(d.forge);
  if (!sha) return 'На стенде нет выложенного коммита - проверять нечего.';
  await d.refreshKnowledge();
  const tar = await d.git.archive(d.knowledgeDir, sha);
  const { jobUrl } = await startCheck(d, {
    kind: 'e2e',
    issue: 'e2e',
    subject: `${channel}:${sha}`,
    task: `e2e стенда, коммит ${sha}`,
    repoTar: tar,
  });
  return `Запустил e2e на стенде (коммит ${sha.slice(0, 7)}): ${jobUrl}`;
}

interface E2eResult {
  passed: number;
  failed: number;
  skipped: number;
  error?: string;
  specs: { title: string; ok: boolean }[];
}

export function e2eHandler(post: (channel: string, text: string) => Promise<void>): CheckHandler {
  return async (meta, result, job) => {
    const [channel = '', sha = ''] = (meta.subject ?? '').split(':');
    const r = result as E2eResult | undefined;
    if (!r || r.error) {
      await post(channel, `e2e на стенде (${sha.slice(0, 7)}) не прошли: ${r?.error ?? `шаг ${job.state}`}. ${job.url}`);
      return;
    }
    const failed = r.specs.filter((s) => !s.ok).map((s) => `- не прошла: ${s.title}`);
    await post(
      channel,
      [`e2e на стенде (${sha.slice(0, 7)}): прошли ${r.passed}, упали ${r.failed}, пропущены ${r.skipped}. ${job.url}`, ...failed].join(
        '\n',
      ),
    );
  };
}
