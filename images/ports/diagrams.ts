// Разница вида модели с тем, что носитель показывает сейчас: основа стража соответствия и
// канала предложений с доски. Сравниваются смысловые части - узлы, подписи, группы и связи;
// расклад и вид элемента носитель вправе огрубить.
import type { DiagramEdge, DiagramFlow, DiagramNode, DiagramView } from './ports.ts';

export interface DiagramChange {
  id: string;
  field: 'title' | 'description' | 'technology' | 'parent';
  from?: string;
  to?: string;
}

export interface DiagramDiff {
  added: DiagramNode[]; // есть у носителя, нет в модели
  removed: DiagramNode[]; // есть в модели, нет у носителя
  changed: DiagramChange[];
  edgesAdded: DiagramEdge[];
  edgesRemoved: DiagramEdge[];
  flow?: { from: string; to: string }; // порядок шагов, блоки или заметки последовательности
  version?: { from: string; to: string };
}

// Запись последовательности: шаги по порядку с подписями и заметками, блоки с заголовками.
export function flowText(view: DiagramView): string {
  const step = (i: number) => {
    const e = view.edges[i];
    return e ? `${e.source} -> ${e.target}: ${e.label ?? ''}${e.note ? ` [${e.note}]` : ''}` : `? ${i}`;
  };
  const walk = (flow: DiagramFlow, pad: string): string[] =>
    flow.flatMap((x) =>
      typeof x === 'number'
        ? [`${pad}${step(x)}`]
        : [
            `${pad}${x.kind}${x.title ? ` ${x.title}` : ''}`,
            ...(x.branches ?? []).flatMap((b) => [`${pad}  | ${b.title ?? ''}`, ...walk(b.flow, `${pad}    `)]),
            ...walk(x.flow ?? [], `${pad}  `),
          ],
    );
  return view.flow ? walk(view.flow, '').join('\n') : '';
}

const edgeKey = (e: DiagramEdge) => JSON.stringify([e.source, e.target, e.label ?? '']);

// Связи - мультимножество: две одинаковые связи модели не схлопываются в одну.
function edgesMissing(from: DiagramEdge[], in_: DiagramEdge[]): DiagramEdge[] {
  const left = new Map<string, number>();
  for (const e of in_) left.set(edgeKey(e), (left.get(edgeKey(e)) ?? 0) + 1);
  return from.filter((e) => {
    const n = left.get(edgeKey(e)) ?? 0;
    if (n > 0) left.set(edgeKey(e), n - 1);
    return n === 0;
  });
}

export function diffViews(model: DiagramView, shown: DiagramView): DiagramDiff {
  const shownById = new Map(shown.nodes.map((n) => [n.id, n]));
  const modelIds = new Set(model.nodes.map((n) => n.id));
  const changed: DiagramChange[] = [];
  for (const n of model.nodes) {
    const s = shownById.get(n.id);
    if (!s) continue;
    for (const field of ['title', 'description', 'technology', 'parent'] as const) {
      if ((n[field] ?? '') !== (s[field] ?? '')) changed.push({ id: n.id, field, from: n[field], to: s[field] });
    }
  }
  return {
    added: shown.nodes.filter((n) => !modelIds.has(n.id)),
    removed: model.nodes.filter((n) => !shownById.has(n.id)),
    changed,
    edgesAdded: edgesMissing(shown.edges, model.edges),
    edgesRemoved: edgesMissing(model.edges, shown.edges),
    ...(flowText(model) === flowText(shown) ? {} : { flow: { from: flowText(model), to: flowText(shown) } }),
    ...(model.version === shown.version ? {} : { version: { from: model.version, to: shown.version } }),
  };
}

export const isEmptyDiff = (d: DiagramDiff) =>
  !d.added.length && !d.removed.length && !d.changed.length && !d.edgesAdded.length && !d.edgesRemoved.length && !d.flow && !d.version;
