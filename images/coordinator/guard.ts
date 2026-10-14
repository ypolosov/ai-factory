// Страж изменения агента: детерминированные правила к патчу до публикации. "block" - патч
// не публикуется; "fail" - PR открывается, но вердикт фабрики красный и решает человек.
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

export function guardPatch(patch: string, agentExitCode: number, o: GuardOptions = DEFAULT_GUARD): Verdict {
  const files = patchFiles(patch);
  const findings: Finding[] = [];
  if (!patch.trim() || files.length === 0) findings.push({ level: 'block', message: 'агент ничего не изменил' });
  for (const f of files) {
    const hit = o.protectedPaths.find((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
    if (hit) findings.push({ level: 'block', message: `агент изменил защищённый путь ${f}` });
  }
  if (/^(new file mode|new mode) 120000$/m.test(patch)) findings.push({ level: 'block', message: 'патч добавляет символическую ссылку' });
  const bytes = Buffer.byteLength(patch);
  if (bytes > o.maxBytes) findings.push({ level: 'fail', message: `патч ${bytes} байт - больше предела ${o.maxBytes}` });
  if (files.length > o.maxFiles)
    findings.push({ level: 'fail', message: `изменено файлов: ${files.length} - больше предела ${o.maxFiles}` });
  if (agentExitCode !== 0) findings.push({ level: 'fail', message: `агент завершился с кодом ${agentExitCode}` });
  const state = findings.some((f) => f.level === 'block') ? 'blocked' : findings.length ? 'failure' : 'success';
  return { files, findings, state };
}
