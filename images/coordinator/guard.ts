// Страж изменения агента: детерминированные правила к патчу до публикации. "block" - патч
// не публикуется; "fail" - PR открывается, но вердикт фабрики красный и решает человек.
import { parse } from 'yaml';
export interface GuardOptions {
  // Пути, которые агент не меняет: настройки CI и фабрики. Каталог - с "/" в конце.
  protectedPaths: string[];
  maxBytes: number;
  maxFiles: number;
}

export interface Finding {
  level: 'block' | 'fail';
  message: string;
}

export interface Verdict {
  files: string[];
  findings: Finding[];
  state: 'blocked' | 'failure' | 'success';
}

export const DEFAULT_GUARD: GuardOptions = {
  protectedPaths: ['.github/', '.forgejo/', '.gitea/', '.factory/', 'bitbucket-pipelines.yml', '.gitlab-ci.yml'],
  maxBytes: 200_000,
  maxFiles: 40,
};

const unquote = (p: string) => (p.startsWith('"') ? (JSON.parse(p) as string) : p);

// Файлы блокировки зависимостей пишет менеджер пакетов: в размер патча для ревью они не входят.
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock'];

function reviewBytes(patch: string): number {
  return patch
    .split(/^(?=diff --git )/m)
    .filter((section) => {
      const files = patchFiles(section.split('\n', 1)[0] ?? '');
      return !files.length || !files.every((f) => LOCKFILES.includes(f.split('/').pop() ?? ''));
    })
    .reduce((n, section) => n + Buffer.byteLength(section), 0);
}

// Пути файлов патча git diff: и старые, и новые (переименование трогает оба).
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split('\n')) {
    const m = /^diff --git ("a\/.*?"|a\/\S+) ("b\/.*"|b\/\S+)$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    files.add(unquote(m[1]).slice(2));
    files.add(unquote(m[2]).slice(2));
  }
  return [...files];
}

// Цель обязана объявить команды линтера и проверки форматирования (.factory/config.yml,
// раздел checks): без них изменение не проверить, и страж его не пропускает.
export function targetChecks(config: string | undefined): Finding[] {
  let checks: Record<string, unknown> = {};
  try {
    checks = ((parse(config ?? '') as { checks?: Record<string, unknown> } | null)?.checks ?? {}) as Record<string, unknown>;
  } catch {
    return [{ level: 'block', message: 'настройки цели .factory/config.yml не читаются' }];
  }
  return ['lint', 'format']
    .filter((k) => typeof checks[k] !== 'string' || !(checks[k] as string).trim())
    .map((k) => ({ level: 'block' as const, message: `цель не объявила команду ${k} (checks.${k} в .factory/config.yml)` }));
}

// Правило-страж цели (.factory/config.yml, раздел rules): запрет шаблона в добавленных
// строках файлов под paths, кроме exclude. Правило утверждает человек слиянием PR.
export interface Rule {
  id: string;
  source?: string; // откуда правило: ADR, замечания ревью
  message: string;
  paths: string[]; // префиксы путей
  exclude: string[];
  forbid: RegExp;
}

export function targetRules(config: string | undefined): { rules: Rule[]; findings: Finding[] } {
  const rules: Rule[] = [];
  const findings: Finding[] = [];
  let raw: unknown[] = [];
  try {
    raw = ((parse(config ?? '') as { rules?: unknown[] } | null)?.rules ?? []) as unknown[];
  } catch {
    return { rules, findings };
  }
  for (const r of raw) {
    const x = (r ?? {}) as Record<string, unknown>;
    const id = String(x.id ?? '?');
    try {
      rules.push({
        id,
        ...(x.source ? { source: String(x.source) } : {}),
        message: String(x.message ?? ''),
        paths: ((x.paths as unknown[] | undefined) ?? ['']).map(String),
        exclude: ((x.exclude as unknown[] | undefined) ?? []).map(String),
        forbid: new RegExp(String(x.forbid ?? '(?!)')),
      });
    } catch {
      findings.push({ level: 'block', message: `правило ${id} в .factory/config.yml не читается` });
    }
  }
  return { rules, findings };
}

// Нарушения правил в добавленных строках патча: по находке на правило и файл.
export function ruleFindings(patch: string, rules: Rule[]): Finding[] {
  const out: Finding[] = [];
  for (const section of patch.split(/^(?=diff --git )/m)) {
    const file = patchFiles(section.split('\n', 1)[0] ?? '').at(-1);
    if (!file) continue;
    const added = section.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    for (const r of rules) {
      if (!r.paths.some((p) => file.startsWith(p)) || r.exclude.some((p) => file.startsWith(p))) continue;
      const hit = added.find((l) => r.forbid.test(l.slice(1)));
      if (hit)
        out.push({
          level: 'fail',
          message: `правило ${r.id}${r.source ? ` (${r.source})` : ''}: ${r.message} - ${file}: ${hit.slice(1).trim().slice(0, 100)}`,
        });
    }
  }
  return out;
}

export function guardPatch(patch: string, agentExitCode: number, o: GuardOptions = DEFAULT_GUARD, targetConfig?: string): Verdict {
  const files = patchFiles(patch);
  const { rules, findings: bad } = targetRules(targetConfig);
  const findings: Finding[] = [...targetChecks(targetConfig), ...bad, ...ruleFindings(patch, rules)];
  if (!patch.trim() || files.length === 0) findings.push({ level: 'block', message: 'агент ничего не изменил' });
  for (const f of files) {
    const hit = o.protectedPaths.find((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
    if (hit) findings.push({ level: 'block', message: `изменён защищённый путь ${f}: агенту нельзя, человеку - решение владельца` });
  }
  if (/^(new file mode|new mode) 120000$/m.test(patch)) findings.push({ level: 'block', message: 'патч добавляет символическую ссылку' });
  const bytes = reviewBytes(patch);
  if (bytes > o.maxBytes) findings.push({ level: 'fail', message: `патч ${bytes} байт - больше предела ${o.maxBytes}` });
  if (files.length > o.maxFiles)
    findings.push({ level: 'fail', message: `изменено файлов: ${files.length} - больше предела ${o.maxFiles}` });
  if (agentExitCode !== 0) findings.push({ level: 'fail', message: `агент завершился с кодом ${agentExitCode}` });
  const state = findings.some((f) => f.level === 'block') ? 'blocked' : findings.length ? 'failure' : 'success';
  return { files, findings, state };
}
