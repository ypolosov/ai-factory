import { describe, expect, it } from 'vitest';
import type { Passage } from '../../ports/ports.ts';
import { parseJudgement, prompt } from '../judge.ts';

const passages: Passage[] = [
  { source: 'docs/adr/ADR-3.md', title: 'ADR-3', text: 'Повтор "заново среди всех" противоречит решению.', url: 'http://x/adr3' },
  { source: 'README.md', title: 'Правила', text: 'R1. Одна заявка.', url: 'http://x/readme' },
];

describe('судья согласования', () => {
  it('в запросе - требование и пронумерованные отрывки с источниками', () => {
    const p = prompt({ issue: 'DRAW-9', title: 'Разыграть заново', body: 'среди всех' }, passages);
    expect(p).toContain('DRAW-9');
    expect(p).toContain('[1] docs/adr/ADR-3.md - ADR-3');
    expect(p).toContain('[2] README.md - Правила');
  });

  it('противоречие с цитатой и источником', () => {
    const j = parseJudgement(
      'вот ответ: {"verdict":"conflict","summary":"нельзя","conflicts":[{"passage":1,"quote":"противоречит решению","why":"ADR-3"}]}',
      passages,
    );
    expect(j.verdict).toBe('conflict');
    expect(j.conflicts).toEqual([{ source: 'docs/adr/ADR-3.md', url: 'http://x/adr3', quote: 'противоречит решению', why: 'ADR-3' }]);
  });

  it('цитата сверяется без учёта переносов строк', () => {
    const p: Passage[] = [{ source: 'a', title: 'a', text: 'R4. Победители\n  из зерна.', url: 'u' }];
    const j = parseJudgement(
      '{"verdict":"conflict","summary":"","conflicts":[{"passage":1,"quote":"R4. Победители из зерна.","why":""}]}',
      p,
    );
    expect(j.conflicts[0]?.quote).toBe('R4. Победители из зерна.');
  });

  it('цитата не из отрывка помечается пересказом', () => {
    const j = parseJudgement('{"verdict":"conflict","summary":"","conflicts":[{"passage":2,"quote":"выдумка","why":""}]}', passages);
    expect(j.conflicts[0]?.quote).toBe('(пересказ) выдумка');
  });

  it('противоречие без существующего отрывка не принимается', () => {
    const j = parseJudgement('{"verdict":"conflict","summary":"","conflicts":[{"passage":7,"quote":"x","why":""}]}', passages);
    expect(j.verdict).toBe('ok');
    expect(j.conflicts).toEqual([]);
  });
});
