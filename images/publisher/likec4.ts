// Виды модели LikeC4 (JSON после `likec4 export json`, расклад выполнен) -> нейтральные виды
// порта схем. Носители берут отсюда узлы, подписи, рамки, связи и координаты. Экземпляр в виде
// развёртывания получает вид своего элемента модели (контейнер, база); у рамки (узел с детьми)
// описание не показывается ни одним носителем C4, у участника последовательности - описание и
// технология: их нет и в нейтральном виде.
import type { DiagramFlow, DiagramView } from '../ports/ports.ts';

interface L4Node {
  id: string;
  kind: string;
  title: string;
  description?: { txt?: string; md?: string } | null;
  technology?: string | null;
  modelRef?: string | null; // экземпляр развёртывания -> элемент модели
  parent?: string | null;
  children?: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

interface L4Edge {
  id?: string;
  source: string;
  target: string;
  label?: string | null;
  notes?: { txt?: string; md?: string } | null; // заметка к шагу сценария
}

// Сценарий (dynamic view): шаги - идентификаторы связей, блоки - с видом и заголовком.
type L4Flow = (string | { _type: string; id: string; title?: string | null; flow: L4Flow })[];

interface L4View {
  id: string;
  title?: string | null;
  sourcePath?: string | null; // нет у вида, который LikeC4 построил сам (index)
  _type?: string;
  flow?: L4Flow;
  nodes: L4Node[];
  edges: L4Edge[];
}

export interface L4Model {
  _stage?: string;
  elements?: Record<string, { kind: string }>;
  views: Record<string, L4View>;
}

function mapFlow(view: string, flow: L4Flow, index: Map<string, number>): DiagramFlow {
  return flow.map((x) => {
    if (typeof x === 'string') {
      const i = index.get(x);
      if (i === undefined) throw new Error(`сценарий ${view}: шаг ${x} без связи`);
      return i;
    }
    const title = x.title ? { title: x.title } : {};
    if (x._type === 'alt')
      return {
        kind: 'alt',
        branches: x.flow.map((b) => {
          if (typeof b === 'string') throw new Error(`сценарий ${view}: в alt шаг ${b} вне ветки`);
          return { ...(b.title ? { title: b.title } : {}), flow: mapFlow(view, b.flow, index) };
        }),
      };
    if (['par', 'opt', 'loop', 'break'].includes(x._type)) return { kind: x._type, ...title, flow: mapFlow(view, x.flow, index) };
    throw new Error(`сценарий ${view}: блок ${x._type} носители пока не показывают`);
  });
}

export function viewsFromLikeC4(model: L4Model, version: string): DiagramView[] {
  if (model._stage !== 'layouted') throw new Error('нужен JSON с раскладом: likec4 export json без --skip-layout');
  // Публикуются только виды, описанные в модели: свой обзорный вид LikeC4 - не представление манифеста.
  return Object.values(model.views)
    .filter((v) => v.sourcePath)
    .map((v) => ({
      id: v.id,
      title: v.title ?? v.id,
      version,
      nodes: v.nodes.map((n) => {
        // Участник последовательности - только имя: описания и технологии носители там не показывают.
        const seq = v._type === 'dynamic';
        const description = n.children?.length || seq ? undefined : (n.description?.txt ?? n.description?.md);
        const kind = n.kind === 'instance' && n.modelRef ? (model.elements?.[n.modelRef]?.kind ?? n.kind) : n.kind;
        return {
          id: n.id,
          kind,
          title: n.title,
          ...(n.technology && !seq ? { technology: n.technology } : {}),
          ...(description ? { description } : {}),
          ...(n.parent ? { parent: n.parent } : {}),
          box: { x: n.x, y: n.y, width: n.width, height: n.height },
        };
      }),
      // LikeC4 переносит длинные подписи связей по строкам; перенос - дело носителя, не модели.
      edges: v.edges.map((e) => {
        const label = e.label?.replace(/\s*\n\s*/g, ' ').trim();
        const note = e.notes?.txt ?? e.notes?.md;
        return { source: e.source, target: e.target, ...(label ? { label } : {}), ...(note ? { note } : {}) };
      }),
      ...(v._type === 'dynamic' && v.flow ? { flow: mapFlow(v.id, v.flow, new Map(v.edges.map((e, i) => [e.id ?? '', i]))) } : {}),
    }));
}
