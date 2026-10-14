// Страж для всех PR цели: изменение из любого экзокортекса (человек со своим агентом, другая
// обвязка) проходит те же правила, что и изменение агента фабрики. PR, у головы которого уже
// есть вердикт фабрики (PR агентов фабрики, уже проверенные головы), пропускаются.
import type { Forge } from '../ports/ports.ts';
import { VERDICT_KEY } from './actions.ts';
import { type GuardOptions, guardPatch } from './guard.ts';

export interface PullGuardDeps {
  forge: Forge;
  guard: GuardOptions;
  // Настройки цели (.factory/config.yml) ветки по умолчанию; undefined - файла нет.
  targetConfig(): Promise<string | undefined>;
  log(message: string): void;
}

export function pullGuard(d: PullGuardDeps) {
  let busy = false;
  return {
    async tick() {
      if (busy) return;
      busy = true;
      try {
        for (const p of await d.forge.listPulls({ state: 'open' })) {
          if ((await d.forge.statuses(p.headSha)).some((s) => s.key === VERDICT_KEY)) continue;
          const v = guardPatch(await d.forge.pullDiff(p.number), 0, d.guard, await d.targetConfig());
          const ok = v.state === 'success';
          // Сначала комментарий, потом статус: сбой между ними не оставит вердикта без объяснения -
          // следующий проход повторит проверку.
          const text = v.findings.map((f) => `- ${f.message}`).join('\n') || '- замечаний нет';
          await d.forge.commentPull(
            p.number,
            `Вердикт стража фабрики (${ok ? 'зелёный' : 'красный'}) для ${p.headSha.slice(0, 7)}:\n${text}`,
          );
          await d.forge.setStatus(p.headSha, {
            key: VERDICT_KEY,
            state: ok ? 'success' : 'failure',
            description: ok ? 'страж: изменение в границах правил' : `страж: замечаний ${v.findings.length}`,
          });
          d.log(`PR ${p.number} ${p.headSha.slice(0, 7)}: ${v.state}`);
        }
      } catch (e) {
        d.log(`страж PR: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        busy = false;
      }
    },
  };
}
