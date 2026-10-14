import { describe, expect, it } from 'vitest';
import { DEFAULT_GUARD, guardPatch, patchFiles, targetChecks } from '../guard.ts';

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

  it('файлы блокировки зависимостей в размер патча не входят', () => {
    const lock = diff('api/package-lock.json') + 'x'.repeat(DEFAULT_GUARD.maxBytes);
    expect(guardPatch(diff('api/package.json') + lock, 0, DEFAULT_GUARD, CONFIG).state).toBe('success');
  });
});
