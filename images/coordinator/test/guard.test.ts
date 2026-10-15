import { describe, expect, it } from 'vitest';
import { DEFAULT_GUARD, guardPatch, patchFiles, roleAllowed, targetChecks, testFindings } from '../guard.ts';

const diff = (path: string, extra = '') => `diff --git a/${path} b/${path}\n${extra}--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;

const CONFIG = 'checks:\n  lint: npm run lint\n  format: npm run format:check\n';

describe('страж изменения агента', () => {
  it('цель обязана объявить команды линтера и форматирования', () => {
    expect(targetChecks(CONFIG)).toEqual([]);
    expect(targetChecks(undefined).map((f) => f.message)).toEqual([
      'цель не объявила команду lint (checks.lint в .factory/config.yml)',
      'цель не объявила команду format (checks.format в .factory/config.yml)',
    ]);
    expect(targetChecks('checks:\n  lint: npm run lint\n')).toHaveLength(1);
    expect(targetChecks('checks: [\n')[0]?.message).toContain('не читаются');
    expect(guardPatch(diff('src/draw.ts'), 0, DEFAULT_GUARD).state).toBe('blocked');
  });

  it('обычное изменение - зелёный вердикт', () => {
    const v = guardPatch(diff('src/draw.ts'), 0, DEFAULT_GUARD, CONFIG);
    expect(v.state).toBe('success');
    expect(v.files).toEqual(['src/draw.ts']);
  });

  it('пустой патч не публикуется', () => {
    expect(guardPatch('', 0, DEFAULT_GUARD, CONFIG).state).toBe('blocked');
  });

  it('настройки CI и фабрики агенту не меняются', () => {
    for (const p of ['.github/workflows/ci.yml', 'bitbucket-pipelines.yml', '.factory/config.yml']) {
      const v = guardPatch(diff(p), 0, DEFAULT_GUARD, CONFIG);
      expect(v.state, p).toBe('blocked');
      expect(v.findings[0]?.message).toContain(p);
    }
  });

  it('переименование в защищённый путь тоже ловится', () => {
    const patch = 'diff --git a/x.yml b/.github/x.yml\nsimilarity index 100%\nrename from x.yml\nrename to .github/x.yml\n';
    expect(patchFiles(patch)).toEqual(['x.yml', '.github/x.yml']);
    expect(guardPatch(patch, 0, DEFAULT_GUARD, CONFIG).state).toBe('blocked');
  });

  it('символическая ссылка не публикуется', () => {
    expect(guardPatch(diff('link', 'new file mode 120000\n'), 0, DEFAULT_GUARD, CONFIG).state).toBe('blocked');
  });

  it('пути в кавычках разбираются', () => {
    expect(patchFiles('diff --git "a/с пробелом.md" "b/с пробелом.md"\n')).toEqual(['с пробелом.md']);
  });

  it('большой патч и сбой агента - PR с красным вердиктом', () => {
    const big = guardPatch(diff('a.ts') + 'x'.repeat(DEFAULT_GUARD.maxBytes), 0, DEFAULT_GUARD, CONFIG);
    expect(big.state).toBe('failure');
    const crashed = guardPatch(diff('a.ts'), 1, DEFAULT_GUARD, CONFIG);
    expect(crashed.state).toBe('failure');
    expect(crashed.findings[0]?.message).toContain('кодом 1');
  });

  it('правило-страж цели: шаблон в добавленных строках под путями, кроме исключений', () => {
    const config = `${CONFIG}rules:
  - id: no-random
    source: ADR-3
    message: случайность вне зерна запрещена
    paths: [api/src/]
    exclude: [api/src/draws/seed.ts]
    forbid: 'Math\\.random'
`;
    const bad = guardPatch(diff('api/src/draws/redraw.ts', '').replace('+x', '+const i = Math.random();'), 0, DEFAULT_GUARD, config);
    expect(bad.state).toBe('failure');
    expect(bad.findings[0]?.message).toBe(
      'правило no-random (ADR-3): случайность вне зерна запрещена - api/src/draws/redraw.ts: const i = Math.random();',
    );
    expect(guardPatch(diff('api/src/draws/seed.ts').replace('+x', '+Math.random()'), 0, DEFAULT_GUARD, config).state).toBe('success');
    expect(guardPatch(diff('web/src/a.ts').replace('+x', '+Math.random()'), 0, DEFAULT_GUARD, config).state).toBe('success');
    const broken = guardPatch(diff('a.ts'), 0, DEFAULT_GUARD, `${CONFIG}rules:\n  - id: x\n    forbid: '('\n`);
    expect(broken.state).toBe('blocked');
  });

  it('секреты из отчёта сканера - изменение не публикуется', () => {
    const report = JSON.stringify([{ RuleID: 'github-pat', StartLine: 1, Secret: 'REDACTED' }]);
    const v = guardPatch(diff('a.ts'), 0, DEFAULT_GUARD, CONFIG, report);
    expect(v.state).toBe('blocked');
    expect(v.findings.at(-1)?.message).toBe('в изменении найдены секреты (Gitleaks): github-pat');
    expect(guardPatch(diff('a.ts'), 0, DEFAULT_GUARD, CONFIG, '[]').state).toBe('success');
  });

  it('файлы блокировки зависимостей в размер патча не входят', () => {
    const lock = diff('api/package-lock.json') + 'x'.repeat(DEFAULT_GUARD.maxBytes);
    expect(guardPatch(diff('api/package.json') + lock, 0, DEFAULT_GUARD, CONFIG).state).toBe('success');
  });
});

describe('тест до кода', () => {
  const report = (r: Record<string, unknown>) =>
    JSON.stringify({ tests: [], code: [], base: 'skipped', head: 'skipped', reason: '', ...r });
  const code = ['api/src/domain/rules.ts'];
  const tests = ['api/test/rules.test.ts'];

  it('тесты падали на базе и проходят с изменением - сведение, вердикт зелёный', () => {
    const r = report({ tests, code, base: 'failed', head: 'passed' });
    expect(testFindings(r)).toEqual([
      { level: 'info', message: 'тест до кода: тесты (api/test/rules.test.ts) падали на коде базы и проходят с изменением' },
    ]);
    const v = guardPatch(diff('api/src/domain/rules.ts'), 0, DEFAULT_GUARD, CONFIG, undefined, r);
    expect(v.state).toBe('success');
    expect(v.findings).toHaveLength(1);
  });

  it('замечания: код без тестов, тесты проходят и без кода, тесты падают, проверки не было', () => {
    expect(testFindings(undefined)).toEqual([]);
    expect(testFindings(report({ reason: 'в изменении нет модульных тестов' }))).toEqual([]);
    expect(testFindings(report({ code }))[0]?.message).toBe('код изменён без модульных тестов: api/src/domain/rules.ts');
    expect(testFindings(report({ tests, code, base: 'passed', head: 'passed' }))[0]?.message).toContain('проходят и на коде базы');
    expect(testFindings(report({ tests, code, base: 'failed', head: 'failed' }))[0]?.message).toBe(
      'модульные тесты не проходят с изменением',
    );
    expect(testFindings(report({ tests, code, reason: 'npm ci не прошёл' }))[0]?.message).toBe(
      'тест до кода не проверен: npm ci не прошёл',
    );
    expect(guardPatch(diff('api/src/a.ts'), 0, DEFAULT_GUARD, CONFIG, undefined, report({ code })).state).toBe('failure');
  });
});

describe('пути роли агента', () => {
  it('пути роли - из .factory/config.yml; нет раздела - весь репозиторий', () => {
    const cfg = `${CONFIG}roles:\n  frontend:\n    paths:\n      allowed: [web/, e2e/]\n`;
    expect(roleAllowed(cfg, 'frontend')).toEqual(['web/', 'e2e/']);
    expect(roleAllowed(cfg, 'backend')).toBeUndefined();
    expect(roleAllowed('roles: [', 'frontend')).toBeUndefined();
    const o = { ...DEFAULT_GUARD, role: 'frontend', allowed: ['web/', 'e2e/'] };
    expect(guardPatch(diff('web/src/App.tsx'), 0, o, CONFIG).state).toBe('success');
    const v = guardPatch(diff('api/src/draw.ts'), 0, o, CONFIG);
    expect(v.state).toBe('blocked');
    expect(v.findings[0]?.message).toBe('роль frontend меняет только web/, e2e/: api/src/draw.ts - вне её путей');
  });
});
