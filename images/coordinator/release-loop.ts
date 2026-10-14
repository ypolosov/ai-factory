// Цикл выпусков: новый тег vX.Y.Z на хостинге цели -> сценарий выпуска; подтверждение
// человека (команда в чате) возобновляет выкладку; статус factory/deploy на коммите тега от
// службы выкладки возобновляет публикацию. Теги, что были до первого запуска, не трогаются.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Forge } from '../ports/ports.ts';
import { message } from './errors.ts';
import { isRelease } from './release.ts';
import { CONFIRM_STEP, DEPLOYED_STEP, type ReleaseWorkflow } from './release-workflow.ts';

export interface ReleaseLoopDeps {
  workflow: ReleaseWorkflow;
  forge: Forge;
  seenFile: string; // теги, которые цикл уже видел
  missing(tag: string): Promise<string[]>; // образы выпуска, которых нет в реестре
  post(text: string): Promise<void>;
  log(message: string): void;
}

type Result = { status: string; error?: unknown; result?: unknown };

const runId = (tag: string) => `release-${tag}`;

export function releaseLoop(d: ReleaseLoopDeps) {
  let busy = false;
  const seen = (): Set<string> | undefined =>
    existsSync(d.seenFile) ? new Set(JSON.parse(readFileSync(d.seenFile, 'utf8')) as string[]) : undefined;

  async function settle(tag: string, r: Result) {
    d.log(`${runId(tag)}: ${r.status}${r.result ? ` ${JSON.stringify(r.result)}` : ''}`);
    if (r.status === 'failed') await d.post(`Выпуск ${tag} остановлен: ${message(r.error).slice(0, 500)}`);
  }

  async function startNew() {
    const tags = (await d.forge.tags()).filter((t) => isRelease(t.name)).map((t) => t.name);
    const known = seen();
    writeFileSync(d.seenFile, JSON.stringify([...new Set([...(known ?? []), ...tags])]));
    if (!known) return;
    for (const tag of tags.filter((t) => !known.has(t))) {
      const run = await d.workflow.createRun({ runId: runId(tag), resourceId: tag });
      await settle(tag, (await run.start({ inputData: { tag } })) as Result);
    }
  }

  async function resumeDeployed() {
    const { runs } = await d.workflow.listWorkflowRuns({ status: 'suspended' });
    for (const { runId: id, resourceId: tag } of runs) {
      if (!tag) continue;
      const sha = (await d.forge.tags()).find((t) => t.name === tag)?.sha;
      const st = sha ? (await d.forge.statuses(sha)).find((s) => s.key === 'factory/deploy' && s.description.includes(tag)) : undefined;
      if (!st || st.state === 'pending') continue;
      const run = await d.workflow.createRun({ runId: id, resourceId: tag });
      await settle(
        tag,
        (await run.resume({ step: DEPLOYED_STEP, resumeData: { ok: st.state === 'success', description: st.description } })) as Result,
      );
    }
  }

  return {
    async tick() {
      if (busy) return;
      busy = true;
      try {
        await startNew();
        await resumeDeployed();
      } catch (e) {
        d.log(`проход выпусков: ${message(e)}`);
      } finally {
        busy = false;
      }
    },
    // Подтверждение выкладки человеком (команда в чате).
    async confirm(tag: string, by: string): Promise<string> {
      const state = await d.workflow.getWorkflowRunById(runId(tag));
      if (!state) return `Выпуска ${tag} нет: тег ещё не собран или появился до запуска фабрики.`;
      if (state.status !== 'suspended') return `Выпуск ${tag} сейчас не ждёт подтверждения (${state.status}).`;
      const missing = await d.missing(tag);
      if (missing.length) return `Образов ${missing.join(', ')} ещё нет в реестре: CI цели собирает выпуск. Повторите команду позже.`;
      const run = await d.workflow.createRun({ runId: runId(tag), resourceId: tag });
      const r = (await run.resume({ step: CONFIRM_STEP, resumeData: { by } })) as Result;
      await settle(tag, r);
      return r.status === 'failed'
        ? `Выкладка ${tag} не началась: ${message(r.error)}`
        : `Выкладка ${tag} подтверждена (${by}): стенд переходит на выпуск.`;
    },
  };
}
