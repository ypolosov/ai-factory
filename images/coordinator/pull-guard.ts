// Страж для всех PR цели: изменение из любого экзокортекса (человек со своим агентом, другая
// обвязка) проходит те же правила, что и изменение агента фабрики. PR, у головы которого уже
// есть вердикт фабрики (PR агентов фабрики, уже проверенные головы), пропускаются.
// Настройки фабрики (.factory/config.yml: проверки, пути ролей, правила-стражи) меняет автор PR,
// чья роль держит решение factory-config в реестре ролей цели; сам реестр (.factory/roles.yml) и
// настройки CI - только решение владельца.
import type { Forge } from '../ports/ports.ts';
import { VERDICT_KEY } from './actions.ts';
import { type GuardOptions, guardPatch } from './guard.ts';
import type { RoleRegistry } from './roles.ts';

export interface PullGuardDeps {
  forge: Forge;
  guard: GuardOptions;
  // Настройки цели (.factory/config.yml) ветки по умолчанию; undefined - файла нет.
  targetConfig(): Promise<string | undefined>;
  // Реестр ролей цели и инструмент, в котором учётки авторов PR (github, bitbucket).
  roles?: () => Promise<RoleRegistry>;
  tool?: string;
  log(message: string): void;
}

export const FACTORY_CONFIG = '.factory/config.yml';

export function pullGuard(d: PullGuardDeps) {
  let busy = false;
  // Право автора PR на настройки фабрики - у держателя роли по реестру ролей; в открытом реестре
  // (файла нет) держателей нет, и права нет ни у кого.
  const granted = async (author: string): Promise<GuardOptions['granted']> => {
    const c = (await d.roles?.())?.check('factory-config', d.tool ?? 'github', author);
    if (!c?.ok || !c.holder) return undefined;
    return { paths: [FACTORY_CONFIG], by: `${c.holder.name} (роль ${c.roles.filter((r) => c.need.includes(r)).join(', ')})` };
  };
  return {
    async tick() {
      if (busy) return;
      busy = true;
      try {
        for (const p of await d.forge.listPulls({ state: 'open' })) {
          if ((await d.forge.statuses(p.headSha)).some((s) => s.key === VERDICT_KEY)) continue;
          const grant = await granted(p.author);
          const v = guardPatch(
            await d.forge.pullDiff(p.number),
            0,
            { ...d.guard, ...(grant ? { granted: grant } : {}) },
            await d.targetConfig(),
          );
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
