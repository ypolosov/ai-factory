import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryForge, memoryJobs } from '../../ports/test/memory.ts';
import { checkLoop } from '../checks.ts';
import { runStore } from '../runs.ts';
import {
  allowedLicenses,
  DEFAULT_LICENSES,
  licenseAllowed,
  licenseFindings,
  newVulns,
  prScan,
  SCAN_KEY,
  type ScanInput,
  scanHandler,
} from '../scan.ts';

const lock = (pkgs: Record<string, { version: string; license?: string }>) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'prize-draw' },
      api: { name: '@prize-draw/api', version: '0.1.0' },
      'node_modules/@prize-draw/api': { resolved: 'api', link: true },
      ...Object.fromEntries(Object.entries(pkgs).map(([n, p]) => [`node_modules/${n}`, p])),
    },
  });

describe('сканеры изменения', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('лицензии: альтернативы OR, все части AND, оговорки WITH', () => {
    const allow = DEFAULT_LICENSES;
    expect(licenseAllowed('MIT', allow)).toBe(true);
    expect(licenseAllowed('(MIT OR GPL-3.0)', allow)).toBe(true);
    expect(licenseAllowed('MIT AND GPL-3.0', allow)).toBe(false);
    expect(licenseAllowed('Apache-2.0 WITH LLVM-exception', allow)).toBe(true);
    expect(licenseAllowed('GPL-3.0-or-later', allow)).toBe(false);
    expect(licenseAllowed('', allow)).toBe(false);
    expect(allowedLicenses('licenses: [MIT, MPL-2.0]')).toEqual(['MIT', 'MPL-2.0']);
    expect(allowedLicenses('checks: {}')).toBe(DEFAULT_LICENSES);
  });

  it('замечания - только к новому: лицензии новых пакетов и новые уязвимости', () => {
    const files = [
      {
        path: 'package-lock.json',
        base: lock({ react: { version: '19.3.0', license: 'MIT' }, old: { version: '1.0.0', license: 'GPL-2.0' } }),
        head: lock({
          react: { version: '19.3.0', license: 'MIT' },
          old: { version: '1.0.0', license: 'GPL-2.0' },
          'left-pad': { version: '1.3.0', license: 'WTFPL' },
          'no-license': { version: '0.0.1' },
          'dual-ok': { version: '2.0.0', license: '(MIT OR GPL-3.0)' },
        }),
      },
    ];
    expect(licenseFindings(files, DEFAULT_LICENSES)).toEqual(['left-pad@1.3.0 (WTFPL)', 'no-license@0.0.1 (лицензия не указана)']);
    expect(
      newVulns({
        base: [{ name: 'lodash', version: '4.17.20', ids: ['GHSA-old'] }],
        head: [
          { name: 'lodash', version: '4.17.20', ids: ['GHSA-old'] },
          { name: 'minimist', version: '0.0.8', ids: ['GHSA-new'] },
        ],
      }),
    ).toEqual(['minimist@0.0.8: GHSA-new']);
  });

  it('любой PR -> задание сканеров с файлами блокировки -> статус и замечания', async () => {
    const runs = runStore(join(root, 'runs'));
    const m = memoryForge();
    m.setHead('deps', 'sha-deps', 'package-lock.json');
    const pr = await m.forge.openPull({ title: 'DRAW-7: зависимость', body: '', head: 'deps', base: 'main' });
    const clean = await m.openPull();
    const started: string[] = [];
    const jobs = memoryJobs({ 'agent-task': async (env) => (started.push(env.RUN_TOKEN ?? ''), 'success') });
    const asked: string[][] = [];
    const scan = prScan({
      runs,
      jobs,
      brokerUrl: 'http://broker',
      pipeline: () => 'agent-task',
      forge: m.forge,
      lockFiles: async (_p, paths) => (
        asked.push(paths),
        [{ path: 'package-lock.json', base: lock({}), head: lock({ 'left-pad': { version: '1.3.0', license: 'WTFPL' } }) }]
      ),
      log: () => {},
    });
    await scan.tick();
    await scan.tick(); // головы уже у сканеров - новых заданий нет
    expect(started).toHaveLength(2);
    expect(asked).toEqual([['package-lock.json']]);
    expect((await m.forge.statuses('sha-deps')).find((s) => s.key === SCAN_KEY)?.state).toBe('pending');

    const byPull = (n: number) => runs.list().find((r) => r.subject?.startsWith(`${n}:`));
    const deps = byPull(pr.number);
    expect(deps?.kind).toBe('scan');
    expect(deps?.issue).toBe('DRAW-7');
    const input = JSON.parse(runs.read(deps?.runId ?? '', 'input')?.toString() ?? '{}') as ScanInput;
    expect(input.files[0]?.path).toBe('package-lock.json');
    runs.write(
      deps?.runId ?? '',
      'result.json',
      JSON.stringify({
        secrets: [{ RuleID: 'generic-api-key', StartLine: 3 }],
        vulns: { base: [], head: [{ name: 'left-pad', version: '1.3.0', ids: ['GHSA-xxxx'] }] },
      }),
    );
    runs.write(byPull(clean.n)?.runId ?? '', 'result.json', JSON.stringify({ secrets: [], vulns: { base: [], head: [] } }));
    const handler = scanHandler({ forge: m.forge, runs, licenses: async () => DEFAULT_LICENSES });
    await checkLoop({ runs, jobs, handlers: { scan: handler }, log: () => {} }).tick();

    expect((await m.forge.statuses('sha-deps')).find((s) => s.key === SCAN_KEY)).toEqual(
      expect.objectContaining({ state: 'failure', description: 'сканеры: замечаний 3' }),
    );
    expect((await m.forge.listPullComments(pr.number)).at(-1)?.body).toBe(
      'Сканеры фабрики для sha-dep:\n' +
        '- в изменении найдены секреты (Gitleaks): generic-api-key\n' +
        '- уязвимость в зависимости left-pad@1.3.0: GHSA-xxxx (OSV)\n' +
        '- лицензия вне разрешённых: left-pad@1.3.0 (WTFPL)\n' +
        'Решает человек.',
    );
    const cleanHead = (await m.forge.getPull(clean.n)).headSha;
    expect((await m.forge.statuses(cleanHead)).find((s) => s.key === SCAN_KEY)).toEqual(
      expect.objectContaining({ state: 'success', description: 'сканеры: секретов, новых уязвимостей и чужих лицензий нет' }),
    );
    expect(await m.forge.listPullComments(clean.n)).toEqual([]);
  });
});
