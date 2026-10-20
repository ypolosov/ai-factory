// Схемы на живой доске Miro: песочница - отдельная доска. Запуск - scripts/port-contract-saas.sh miro;
// без MIRO_TEST_TOKEN и MIRO_TEST_BOARD живой контракт пропускается, проверки разбора идут всегда.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, test } from 'vitest';
import { assignParents, attachments, htmlText, layout, miroDiagrams, nodeContent, parseContent, snaps } from '../miro.ts';
import { diagramsContract, sampleView } from './contract.ts';

describe('Miro: подписи, расклад и группы без сети', () => {
  it('подпись фигуры читается обратно той же', () => {
    for (const n of [{ title: 'Фабрика "ИИ" & <x>', description: 'строка 1\nстрока "2" & 3' }, { title: 'Jira' }]) {
      expect(parseContent(nodeContent(n))).toEqual(n);
    }
    // Miro кодирует кавычки числом, правка руками может быть без жирного заголовка
    expect(parseContent('<p><strong>А &#34;Б&#34;</strong></p><p>В</p>')).toEqual({ title: 'А "Б"', description: 'В' });
    expect(parseContent('<p>Кэш</p><p>ответов</p>')).toEqual({ title: 'Кэш', description: 'ответов' });
    expect(htmlText('читает, ведёт &amp; &#34;задачи&#34;')).toBe('читает, ведёт & "задачи"');
  });

  it('узлы без расклада - сеткой, рамка группы охватывает только своих', () => {
    const v = sampleView('a');
    const boxes = layout(v);
    for (const n of v.nodes) expect(boxes.get(n.id), n.id).toBeDefined();
    const withBoxes = v.nodes.map((n) => ({ ...n, parent: undefined, box: boxes.get(n.id) ?? { x: 0, y: 0, width: 0, height: 0 } }));
    const parents = Object.fromEntries(assignParents(withBoxes).map((n) => [n.id, n.parent]));
    expect(parents).toEqual(Object.fromEntries(v.nodes.map((n) => [n.id, n.parent])));
  });

  it('связь цепляется к сторонам, которые смотрят друг на друга', () => {
    const box = (x: number, y: number) => ({ x, y, width: 100, height: 50 });
    const ends = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const r = snaps(box(a.x, a.y), box(b.x, b.y), 's', 't');
      return [r.startItem.snapTo, r.endItem.snapTo];
    };
    expect(ends({ x: 0, y: 0 }, { x: 50, y: 300 })).toEqual(['bottom', 'top']);
    expect(ends({ x: 0, y: 300 }, { x: 0, y: 0 })).toEqual(['top', 'bottom']);
    expect(ends({ x: 0, y: 0 }, { x: 400, y: 20 })).toEqual(['right', 'left']);
    expect(ends({ x: 400, y: 0 }, { x: 0, y: 0 })).toEqual(['left', 'right']);
    // сосед в другом ряду, хоть и далеко в стороне, - всё равно снизу вверх
    expect(ends({ x: 0, y: 0 }, { x: 1000, y: 300 })).toEqual(['bottom', 'top']);
    expect(snaps(undefined, box(0, 0), 's', 't').startItem.snapTo).toBe('auto');
  });

  it('связи с одной стороны фигуры расходятся по ней по порядку соседей', () => {
    const b = (x: number, y: number) => ({ x, y, width: 100, height: 50 });
    const boxes = new Map([
      ['hub', b(500, 0)],
      ['left', b(0, 300)],
      ['mid', b(500, 300)],
      ['right', b(1000, 300)],
    ]);
    const p = attachments(
      [
        { source: 'hub', target: 'right' },
        { source: 'hub', target: 'left' },
        { source: 'hub', target: 'mid' },
      ],
      boxes,
    );
    expect(p.map((x) => x.start)).toEqual([
      { x: '75%', y: '100%' },
      { x: '25%', y: '100%' },
      { x: '50%', y: '100%' },
    ]);
    expect(p.map((x) => x.end)).toEqual([
      { x: '50%', y: '0%' },
      { x: '50%', y: '0%' },
      { x: '50%', y: '0%' },
    ]);
  });
});

const token = process.env.MIRO_TEST_TOKEN;
const board = process.env.MIRO_TEST_BOARD;

if (!token || !board) {
  test.skip('контракт Miro: нет MIRO_TEST_TOKEN и MIRO_TEST_BOARD', () => {});
} else {
  diagramsContract('Miro', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'miro-'));
    const mapFile = join(dir, 'miro.json');
    const diagrams = miroDiagrams({ token, board, mapFile });
    const published: string[] = [];
    return {
      diagrams: {
        publish: async (v) => {
          published.push(v.id);
          return diagrams.publish(v);
        },
        read: (id) => diagrams.read(id),
      },
      cleanup: async () => {
        for (const id of published) await diagrams.remove(id);
        await rm(dir, { recursive: true, force: true });
      },
    };
  });
}
