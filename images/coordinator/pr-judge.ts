// Судья PR моделью другого семейства (Codex по подписке): агент пишет Claude-ом, судит Codex.
// Судья смотрит любой открытый PR, у головы которого есть вердикт стража; итог - статус
// factory/judge и комментарий с оценкой и главными замечаниями. Решает человек.
import type { Forge, Tracker } from '../ports/ports.ts';
import { VERDICT_KEY } from './actions.ts';
import { type CheckDeps, type CheckHandler, startCheck } from './checks.ts';

export const JUDGE_KEY = 'factory/judge';

export interface JudgeResult {
  score: number;
  security_concerns: string;
  merge_recommendation: 'approve' | 'changes_required';
  risk_level: string;
  key_issues: { file: string; header: string; content: string }[];
}

const MAX_DIFF = 200_000;

export function prJudge(d: CheckDeps & { forge: Forge; tracker: Tracker; log(m: string): void }) {
  let busy = false;
  return {
    // Новые головы PR с вердиктом стража -> задание судьи; на голове - статус "проверяет".
    async tick() {
      if (busy) return;
      busy = true;
      try {
        for (const p of await d.forge.listPulls({ state: 'open' })) {
          const sts = await d.forge.statuses(p.headSha);
          const verdict = sts.find((s) => s.key === VERDICT_KEY);
          if (!verdict || verdict.state === 'pending' || sts.some((s) => s.key === JUDGE_KEY)) continue;
          const diff = await d.forge.pullDiff(p.number);
          const key = /^([A-Z][A-Z0-9]+-\d+)/.exec(p.title)?.[1];
          let issue = '';
          if (key) {
            try {
              const i = await d.tracker.getIssue(key);
              issue = `\n\nЗадача ${key}: ${i.title}\n${i.body}`;
            } catch {
              issue = '';
            }
          }
          const { jobUrl } = await startCheck(d, {
            kind: 'judge',
            issue: key ?? `pr-${p.number}`,
            subject: `${p.number}:${p.headSha}`,
            task: `PR ${p.number}: ${p.title}\n\n${p.body}${issue}`,
            input: new TextEncoder().encode(diff.slice(0, MAX_DIFF)),
          });
          await d.forge.setStatus(p.headSha, { key: JUDGE_KEY, state: 'pending', description: 'судья (Codex) проверяет', url: jobUrl });
          d.log(`судья: PR ${p.number} ${p.headSha.slice(0, 7)}`);
        }
      } catch (e) {
        d.log(`судья PR: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        busy = false;
      }
    },
  };
}

const isJudge = (r: unknown): r is JudgeResult => !!r && typeof r === 'object' && Number.isInteger((r as JudgeResult).score);

export function judgeHandler(forge: Forge): CheckHandler {
  return async (meta, result, job) => {
    const [n = '', sha = ''] = (meta.subject ?? '').split(':');
    if (!isJudge(result)) {
      await forge.setStatus(sha, { key: JUDGE_KEY, state: 'error', description: `судья не дал оценки (${job.state})`, url: job.url });
      return;
    }
    const ok = result.score >= 60 && !result.security_concerns.trim();
    await forge.setStatus(sha, {
      key: JUDGE_KEY,
      state: ok ? 'success' : 'failure',
      description: `судья (Codex): ${result.score}/100, ${result.merge_recommendation === 'approve' ? 'можно сливать' : 'нужна доработка'}`,
      url: job.url,
    });
    const issues = result.key_issues.map((i) => `- ${i.file}: ${i.header} - ${i.content}`).join('\n') || '- замечаний нет';
    await forge.commentPull(
      Number(n),
      `Судья фабрики (Codex, другое семейство моделей) для ${sha.slice(0, 7)}: ${result.score}/100, риск ${result.risk_level}, ${result.merge_recommendation === 'approve' ? 'можно сливать' : 'нужна доработка'}.${result.security_concerns ? `\nБезопасность: ${result.security_concerns}` : ''}\n${issues}\nРешает человек.`,
    );
  };
}
