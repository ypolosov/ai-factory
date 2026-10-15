import { describe, expect, it } from 'vitest';
import { summarize } from '../factory-e2e.ts';

describe('итог e2e на стенде', () => {
  it('отчёт Playwright -> счёт и названия проверок', () => {
    const report = {
      stats: { expected: 2, unexpected: 1, flaky: 1, skipped: 0 },
      suites: [
        {
          title: 'entries.spec.ts',
          specs: [{ title: 'одна заявка (R1)', ok: true }],
          suites: [{ title: 'вложенный', specs: [{ title: 'R3', ok: false }] }],
        },
        { title: 'seed.spec.ts', specs: [{ title: 'зерно (R4)', ok: true }] },
      ],
    };
    expect(summarize(report)).toEqual({
      passed: 3,
      failed: 1,
      skipped: 0,
      specs: [
        { title: 'entries.spec.ts > одна заявка (R1)', ok: true },
        { title: 'entries.spec.ts > вложенный > R3', ok: false },
        { title: 'seed.spec.ts > зерно (R4)', ok: true },
      ],
    });
  });
});
