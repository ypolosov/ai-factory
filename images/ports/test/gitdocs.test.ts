// Контракт базы знаний на документах в git: рабочая копия во временном каталоге.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anchor, gitDocsKnowledge, sections } from '../gitdocs.ts';
import { KNOWLEDGE_DOCS, knowledgeContract } from './contract.ts';

knowledgeContract('документы в git', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitdocs-'));
  for (const d of [...KNOWLEDGE_DOCS, { path: 'src/ignored.md', text: '# Повторный розыгрыш заново\n' }]) {
    mkdirSync(dirname(join(dir, d.path)), { recursive: true });
    writeFileSync(join(dir, d.path), d.text);
  }
  return {
    knowledge: gitDocsKnowledge({ dir, web: 'https://github.com/o/r', ref: () => 'abc123' }),
    cleanup: async () => rmSync(dir, { recursive: true, force: true }),
  };
});

describe('документы в git', () => {
  it('раздел - отрывок, якорь - как у GitHub', () => {
    expect(sections('a.md', '# A\n\nтекст\n\n## B. Второй\n\nещё').map((s) => s.title)).toEqual(['A', 'B. Второй']);
    expect(anchor('ADR-3. Результат воспроизводим из зерна')).toBe('adr-3-результат-воспроизводим-из-зерна');
  });

  it('спецификации OpenSpec - знание: живые требования и изменения в работе, без архива', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitdocs-'));
    const files: Record<string, string> = {
      'openspec/specs/draw/spec.md': '## Requirements\n\n### Requirement: Повтор розыгрыша\nСледующий кандидат.\n',
      'openspec/changes/draw-12-redraw/proposal.md': '## Why\n\nПовтор розыгрыша невостребованного приза.\n',
      'openspec/changes/archive/2026-10-01-old/proposal.md': '## Why\n\nПовтор розыгрыша по-старому.\n',
      'openspec/schemas/factory/templates/proposal.md': '## Why\n\nПовтор розыгрыша - шаблон.\n',
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const found = await gitDocsKnowledge({ dir, web: 'https://github.com/o/r', ref: () => 'abc' }).search('повтор розыгрыша', 10);
    expect([...new Set(found.map((p) => p.source))].sort()).toEqual([
      'openspec/changes/draw-12-redraw/proposal.md',
      'openspec/specs/draw/spec.md',
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ссылка ведёт на файл в коммите и раздел', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitdocs-'));
    writeFileSync(join(dir, 'README.md'), '# Розыгрыш\n\n## Правила\n\nR1. Одна заявка.\n');
    const [p] = await gitDocsKnowledge({ dir, web: 'https://github.com/o/r/', ref: () => 'abc' }).search('заявка');
    expect(p?.url).toBe('https://github.com/o/r/blob/abc/README.md#правила');
    rmSync(dir, { recursive: true, force: true });
  });
});
