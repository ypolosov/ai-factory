// Сканеры изменения для любого PR цели - агента фабрики и человека из своего экзокортекса:
// секреты в добавленных строках (Gitleaks) и новые уязвимости зависимостей (OSV-Scanner по
// скачанной базе OSV) - в шаге на своём раннере; лицензии новых пакетов - здесь, по файлам
// блокировки на общем предке и на голове. Итог - статус factory/scan и замечания в PR; решает
// человек. Дальше проверяются только изменения: старые долги базы не красят каждый PR.
import { parse } from 'yaml';
import type { Forge, Pull } from '../ports/ports.ts';
import { type CheckDeps, type CheckHandler, startCheck } from './checks.ts';
import { message } from './errors.ts';
import { LOCKFILES, patchFiles, secretFindings } from './guard.ts';
import type { RunStore } from './runs.ts';

export const SCAN_KEY = 'factory/scan';

// Разрешительные лицензии. Цель задаёт свой список в .factory/config.yml (licenses) ветки по
// умолчанию - PR его не ослабит.
export const DEFAULT_LICENSES = [
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Unlicense',
  'Python-2.0',
  'Zlib',
];

export interface LockFile {
  path: string;
  base?: string; // нет - файла не было на общем предке
  head?: string; // нет - файл удалён
}

export interface ScanInput {
  diff: string;
  files: LockFile[];
}

export interface Vuln {
  name: string;
  version: string;
  ids: string[];
}

export interface ScanResult {
  secrets: unknown[]; // отчёт Gitleaks, значения скрыты
  vulns: { base: Vuln[]; head: Vuln[] };
}

export function allowedLicenses(config: string | undefined): string[] {
  try {
    const l = (parse(config ?? '') as { licenses?: unknown } | null)?.licenses;
    return Array.isArray(l) && l.length ? l.map(String) : DEFAULT_LICENSES;
  } catch {
    return DEFAULT_LICENSES;
  }
}

// Выражение SPDX разрешено, если хотя бы одна альтернатива (OR) целиком из разрешённых (AND).
// Скобки не разбираются: для лицензий пакетов npm этого хватает.
export function licenseAllowed(expr: string, allow: string[]): boolean {
  const e = expr.replace(/[()]/g, ' ').trim();
  if (!e) return false;
  return e
    .split(/\s+OR\s+/i)
    .some((alt) => alt.split(/\s+AND\s+/i).every((id) => allow.includes((id.split(/\s+WITH\s+/i)[0] ?? '').trim().replace(/\+$/, ''))));
}

// Пакеты файла блокировки npm (lockfileVersion 2 и 3): имя@версия -> лицензия ('' - не указана).
export function npmPackages(lock: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!lock?.trim()) return out;
  let j: { packages?: Record<string, { version?: string; license?: unknown; link?: boolean }> };
  try {
    j = JSON.parse(lock);
  } catch {
    return out;
  }
  for (const [path, p] of Object.entries(j.packages ?? {})) {
    const at = path.lastIndexOf('node_modules/');
    if (at < 0 || p.link) continue;
    const license = typeof p.license === 'string' ? p.license : '';
    out.set(`${path.slice(at + 'node_modules/'.length)}@${p.version ?? '?'}`, license);
  }
  return out;
}

// Новые пакеты с лицензией вне разрешённых.
export function licenseFindings(files: LockFile[], allow: string[]): string[] {
  const bad: string[] = [];
  for (const f of files.filter((x) => x.path.split('/').pop() === 'package-lock.json')) {
    const before = npmPackages(f.base);
    for (const [pkg, license] of npmPackages(f.head)) {
      if (before.has(pkg) || licenseAllowed(license, allow)) continue;
      bad.push(`${pkg} (${license || 'лицензия не указана'})`);
    }
  }
  return bad;
}

// Уязвимости головы, которых не было на общем предке.
export function newVulns(v: ScanResult['vulns']): string[] {
  const seen = new Set(v.base.flatMap((x) => x.ids.map((id) => `${x.name}@${x.version}:${id}`)));
  return v.head.flatMap((x) =>
    x.ids.filter((id) => !seen.has(`${x.name}@${x.version}:${id}`)).map((id) => `${x.name}@${x.version}: ${id}`),
  );
}

const isLock = (path: string) => LOCKFILES.includes(path.split('/').pop() ?? '');

export interface ScanDeps extends CheckDeps {
  forge: Forge;
  // Файлы блокировки на общем предке с веткой по умолчанию и на голове PR.
  lockFiles(p: Pull, paths: string[]): Promise<LockFile[]>;
  log(m: string): void;
}

export function prScan(d: ScanDeps) {
  let busy = false;
  return {
    // Новая голова PR -> задание сканеров; на голове - статус "проверяют".
    async tick() {
      if (busy) return;
      busy = true;
      try {
        for (const p of await d.forge.listPulls({ state: 'open' })) {
          if ((await d.forge.statuses(p.headSha)).some((s) => s.key === SCAN_KEY)) continue;
          const diff = await d.forge.pullDiff(p.number);
          const locks = patchFiles(diff).filter(isLock);
          const input: ScanInput = { diff, files: locks.length ? await d.lockFiles(p, locks) : [] };
          const key = /^([A-Z][A-Z0-9]+-\d+)/.exec(p.title)?.[1];
          const { jobUrl } = await startCheck(d, {
            kind: 'scan',
            issue: key ?? `pr-${p.number}`,
            subject: `${p.number}:${p.headSha}`,
            task: `PR ${p.number}: ${p.title}`,
            input: new TextEncoder().encode(JSON.stringify(input)),
          });
          await d.forge.setStatus(p.headSha, {
            key: SCAN_KEY,
            state: 'pending',
            description: 'сканеры проверяют: секреты, уязвимости, лицензии',
            url: jobUrl,
          });
          d.log(`сканеры: PR ${p.number} ${p.headSha.slice(0, 7)}${locks.length ? `, файлы блокировки: ${locks.join(', ')}` : ''}`);
        }
      } catch (e) {
        d.log(`сканеры PR: ${message(e)}`);
      } finally {
        busy = false;
      }
    },
  };
}

const isScan = (r: unknown): r is ScanResult =>
  !!r && typeof r === 'object' && Array.isArray((r as ScanResult).secrets) && Array.isArray((r as ScanResult).vulns?.head);

export function scanHandler(d: { forge: Forge; runs: RunStore; licenses(): Promise<string[]> }): CheckHandler {
  return async (meta, result, job) => {
    const [n = '', sha = ''] = (meta.subject ?? '').split(':');
    if (!isScan(result)) {
      await d.forge.setStatus(sha, { key: SCAN_KEY, state: 'error', description: `сканеры не дали итога (${job.state})`, url: job.url });
      return;
    }
    const input = JSON.parse(d.runs.read(meta.runId, 'input')?.toString('utf8') || '{}') as Partial<ScanInput>;
    const findings = [
      ...secretFindings(JSON.stringify(result.secrets)).map((f) => f.message),
      ...newVulns(result.vulns).map((v) => `уязвимость в зависимости ${v} (OSV)`),
      ...licenseFindings(input.files ?? [], await d.licenses()).map((l) => `лицензия вне разрешённых: ${l}`),
    ];
    await d.forge.setStatus(sha, {
      key: SCAN_KEY,
      state: findings.length ? 'failure' : 'success',
      description: findings.length ? `сканеры: замечаний ${findings.length}` : 'сканеры: секретов, новых уязвимостей и чужих лицензий нет',
      url: job.url,
    });
    if (findings.length) {
      await d.forge.commentPull(
        Number(n),
        `Сканеры фабрики для ${sha.slice(0, 7)}:\n${findings.map((f) => `- ${f}`).join('\n')}\nРешает человек.`,
      );
    }
  };
}
