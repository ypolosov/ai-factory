import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffViews } from '../diagrams.ts';
import { alias, dec, enc, plantumlDiagrams, unalias } from '../plantuml.ts';
import { diagramsContract, sampleView } from './contract.ts';

let dir = '';
diagramsContract(
  'PlantUML',
  async () => {
    dir = await mkdtemp(join(tmpdir(), 'puml-'));
    return {
      diagrams: plantumlDiagrams({ dir, includes: ['common.puml'], sequenceIncludes: ['common-uml.puml'] }),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  },
  { sequence: true },
);

describe('PlantUML: кодирование и правка руками', () => {
  it('псевдоним и текст обратимы', () => {
    for (const id of ['factory', 'ext.jira', 'my_kb-1', '@gr1', 'a_d.b']) {
      expect(alias(id)).toMatch(/^e_\w+$/);
      expect(unalias(alias(id))).toBe(id);
    }
    const t = 'кавычки "так", обратная \\ косая, & и\nперевод строки';
    expect(enc(t)).not.toMatch(/["\n]/);
    expect(dec(enc(t))).toBe(t);
  });

  it('правка в файле читается как разница с моделью', async () => {
    const d = await mkdtemp(join(tmpdir(), 'puml-'));
    try {
      const diagrams = plantumlDiagrams({ dir: d });
      const v = sampleView('edited');
      await diagrams.publish(v);
      const file = join(d, 'edited.puml');
      const text = await readFile(file, 'utf8');
      await writeFile(
        file,
        text
          .replace('"Инженеры"', '"Инженеры и дизайнеры"')
          .replace('SHOW_LEGEND()', 'System_Ext(e_cache, "Кэш ответов")\nRel(e_factory, e_cache, "кэширует")\nSHOW_LEGEND()'),
      );
      const shown = await diagrams.read('edited');
      expect(shown).toBeDefined();
      const diff = diffViews(v, shown ?? v);
      expect(diff.added.map((n) => n.id)).toEqual(['cache']);
      expect(diff.changed).toEqual([{ id: 'eng', field: 'title', from: 'Инженеры', to: 'Инженеры и дизайнеры' }]);
      expect(diff.edgesAdded).toEqual([{ source: 'factory', target: 'cache', label: 'кэширует' }]);
      expect(diff.removed).toEqual([]);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('имя вида не латиницей - отказ', async () => {
    await expect(plantumlDiagrams({ dir: tmpdir() }).publish(sampleView('вид'))).rejects.toThrow(/латиница/);
  });
});
