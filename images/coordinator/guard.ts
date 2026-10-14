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

export function guardPatch(patch: string, agentExitCode: number, o: GuardOptions = DEFAULT_GUARD, targetConfig?: string): Verdict {
  const files = patchFiles(patch);
  const findings: Finding[] = [...targetChecks(targetConfig)];
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
