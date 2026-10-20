import { describe, expect, it } from 'vitest';
import { diffViews, isEmptyDiff } from '../diagrams.ts';
import { sampleView } from './contract.ts';

describe('разница вида модели и показанного носителем', () => {
  it('одинаковые - пусто, расклад и вид элемента не в счёт', () => {
    const v = sampleView('a');
    const shown = { ...v, nodes: v.nodes.map((n) => ({ ...n, kind: 'system', box: undefined })) };
    expect(isEmptyDiff(diffViews(v, shown))).toBe(true);
  });

  it('добавлено, удалено, изменено, связи и версия', () => {
    const v = sampleView('a');
    const shown = {
      ...v,
      version: 'v0',
      nodes: [...v.nodes.filter((n) => n.id !== 'eng'), { id: 'cache', kind: 'external', title: 'Кэш' }].map((n) =>
        n.id === 'target' ? { ...n, parent: undefined } : n,
      ),
      edges: [...v.edges.slice(1), { source: 'factory', target: 'cache' }],
    };
    const d = diffViews(v, shown);
    expect(d.added.map((n) => n.id)).toEqual(['cache']);
    expect(d.removed.map((n) => n.id)).toEqual(['eng']);
    expect(d.changed).toEqual([{ id: 'target', field: 'parent', from: '@gr1', to: undefined }]);
    expect(d.edgesAdded).toEqual([{ source: 'factory', target: 'cache' }]);
    expect(d.edgesRemoved).toEqual([v.edges[0]]);
    expect(d.version).toEqual({ from: 'v1', to: 'v0' });
    expect(isEmptyDiff(d)).toBe(false);
  });

  it('одинаковые связи считаются по числу, а не схлопываются', () => {
    const v = sampleView('a');
    const e = { source: 'eng', target: 'factory', label: 'ещё раз' };
    expect(diffViews({ ...v, edges: [...v.edges, e, e] }, { ...v, edges: [...v.edges, e] }).edgesRemoved).toEqual([e]);
  });
});
