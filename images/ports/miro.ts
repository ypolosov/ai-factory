// Адаптер схем Miro (REST API v2): вид модели -> рамка на доске публикаций. Узлы - фигуры по
// раскладу модели (LikeC4), группы - пунктирные прямоугольники под ними, связи - коннекторы с
// подписями, версия источника - текст в рамке. У элементов Miro нет своих меток через REST,
// поэтому карта "элемент модели -> элемент доски" лежит у фабрики (файл в git). Чтение обратно
// собирает вид с доски: правка руками - разница с моделью, то есть предложение, а не правда.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type DiagramBox, type DiagramNode, type Diagrams, type DiagramView, PortError } from './ports.ts';

export interface MiroConfig {
  token: string;
  board: string; // идентификатор доски (из адреса miro.com/app/board/<id>)
  mapFile: string; // карта вид -> рамка и элементы доски
  api?: string;
  retryMs?: number; // первая пауза перед повтором на 429 и 5xx, дальше вдвое, но не больше 10 с
}

interface NodeRef {
  item: string;
  kind: string;
}

interface ViewMap {
  frame: string;
  x: number; // центр рамки по горизонтали: новые рамки встают правее
  width: number;
  version?: string;
  versionItem?: string;
  nodes: Record<string, NodeRef>;
  edges: Record<string, string>;
}

type MiroMap = Record<string, ViewMap>;

interface Item {
  id: string;
  type: string;
  data?: { content?: string; title?: string };
  position?: { x: number; y: number };
  geometry?: { width?: number; height?: number };
}

interface Connector {
  id: string;
  startItem?: { id: string };
  endItem?: { id: string };
  captions?: { content?: string }[];
}

// Цвета - как у C4-PlantUML: одна палитра на всех носителях.
const STYLE: Record<string, { shape: string; fill: string }> = {
  person: { shape: 'round_rectangle', fill: '#08427b' },
  system: { shape: 'rectangle', fill: '#1168bd' },
  external: { shape: 'rectangle', fill: '#999999' },
  container: { shape: 'rectangle', fill: '#438dd5' },
  database: { shape: 'can', fill: '#438dd5' },
};

// Рамка - узел, внутри которого другие: группа вида, система с детьми, узел развёртывания.
// Рисуется под детьми, без описания (как у C4-PlantUML).
const isFrame = (view: DiagramView, n: DiagramNode) =>
  n.kind === '@group' || n.kind === 'node' || view.nodes.some((c) => c.parent === n.id);
const depth = (view: DiagramView, n: DiagramNode): number => {
  const p = n.parent && view.nodes.find((c) => c.id === n.parent);
  return p ? 1 + depth(view, p) : 0;
};
const MARGIN = 100;
const HEADER = 60;
const GAP = 400;
const VERSION = 'Источник: модель, версия ';

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;');

export const htmlText = (html: string) =>
  html
    .replace(/<\/p>\s*/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\n+$/, '');

export function nodeContent(n: Pick<DiagramNode, 'title' | 'description' | 'technology'>): string {
  const technology = n.technology ? `<p><em>[${esc(n.technology)}]</em></p>` : '';
  const description = n.description ? n.description.split('\n').map((l) => `<p>${esc(l)}</p>`) : [];
  return `<p><strong>${esc(n.title)}</strong></p>${technology}${description.join('')}`;
}

// Подпись фигуры: заголовок - жирная первая строка, технология - курсивом в скобках, дальше
// описание; правка руками без жирного - первая строка заголовок, остальное описание.
export function parseContent(html: string): { title: string; technology?: string; description?: string } {
  const m = /^\s*<p[^>]*>\s*<strong>([\s\S]*?)<\/strong>\s*<\/p>(?:\s*<p[^>]*>\s*<em>\[([\s\S]*?)\]<\/em>\s*<\/p>)?([\s\S]*)$/.exec(html);
  if (!m) {
    const [title = '', ...rest] = htmlText(html).split('\n');
    const description = rest.join('\n');
    return { title, ...(description ? { description } : {}) };
  }
  const technology = m[2] === undefined ? '' : htmlText(m[2]);
  const description = htmlText(m[3] ?? '');
  return { title: htmlText(m[1] ?? ''), ...(technology ? { technology } : {}), ...(description ? { description } : {}) };
}

// Боксы узлов в координатах вида. Узлы без расклада - сеткой: дети каждой рамки своими
// строками (чтобы рамка охватила только их), затем остальные; рамка без расклада охватывает
// своих детей, вложенные рамки считаются раньше внешних.
export function layout(view: DiagramView): Map<string, DiagramBox> {
  const boxes = new Map<string, DiagramBox>();
  let y = 0;
  for (const n of view.nodes) {
    if (!n.box) continue;
    boxes.set(n.id, n.box);
    y = Math.max(y, n.box.y + n.box.height + 120);
  }
  const buckets = new Map<string, DiagramNode[]>();
  for (const n of view.nodes.filter((n) => !n.box && !isFrame(view, n))) {
    const key = n.parent ?? '';
    buckets.set(key, [...(buckets.get(key) ?? []), n]);
  }
  for (const key of [...[...buckets.keys()].filter((k) => k), '']) {
    const list = buckets.get(key) ?? [];
    for (const [i, n] of list.entries()) boxes.set(n.id, { x: (i % 4) * 420, y: y + Math.floor(i / 4) * 260, width: 320, height: 180 });
    if (list.length) y += Math.ceil(list.length / 4) * 260 + 120;
  }
  const frames = view.nodes.filter((n) => !n.box && isFrame(view, n)).sort((a, b) => depth(view, b) - depth(view, a));
  for (const g of frames) {
    const kids = view.nodes.flatMap((c) => (c.parent === g.id ? [boxes.get(c.id)] : [])).filter((b) => b !== undefined);
    if (!kids.length) {
      boxes.set(g.id, { x: 0, y, width: 320, height: 180 });
      y += 300;
      continue;
    }
    const x0 = Math.min(...kids.map((k) => k.x)) - 40;
    const y0 = Math.min(...kids.map((k) => k.y)) - 60;
    const x1 = Math.max(...kids.map((k) => k.x + k.width)) + 40;
    const y1 = Math.max(...kids.map((k) => k.y + k.height)) + 40;
    boxes.set(g.id, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return boxes;
}

// Рамка узла - самая маленькая из бОльших фигур, в которую попадает его центр: в раскладе C4
// фигуры не накрывают друг друга, кроме рамок.
export function assignParents<T extends DiagramNode & { box: DiagramBox }>(nodes: T[]): T[] {
  const area = (b: DiagramBox) => b.width * b.height;
  const groups = nodes;
  return nodes.map((n) => {
    const cx = n.box.x + n.box.width / 2;
    const cy = n.box.y + n.box.height / 2;
    const [g] = groups
      .filter((g) => g !== n && area(g.box) > area(n.box))
      .filter((g) => cx > g.box.x && cx < g.box.x + g.box.width && cy > g.box.y && cy < g.box.y + g.box.height)
      .sort((a, b) => area(a.box) - area(b.box));
    return g ? { ...n, parent: g.id } : n;
  });
}

const edgeKey = (source: string, target: string, label = '') => JSON.stringify([source, target, label]);

// Связь - горизонтальными и вертикальными отрезками: конец цепляется к стороне, которая смотрит
// на соседа (снизу вверх, если сосед в ряду ниже, справа налево, если в том же ряду). Так линии меньше
// пересекаются; точек излома REST Miro не принимает, остальное - расклад модели.
export function snaps(a: DiagramBox | undefined, b: DiagramBox | undefined, s: string, t: string) {
  if (!a || !b) return { startItem: { id: s, snapTo: 'auto' }, endItem: { id: t, snapTo: 'auto' } };
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  // Соседи в разных рядах - выход снизу или сверху: горизонтальный отрезок пройдёт в промежутке
  // между рядами, а не сквозь фигуры ряда.
  const rows = Math.abs(dy) > (a.height + b.height) / 2;
  const [from, to] = rows ? (dy > 0 ? ['bottom', 'top'] : ['top', 'bottom']) : dx > 0 ? ['right', 'left'] : ['left', 'right'];
  return { startItem: { id: s, snapTo: from }, endItem: { id: t, snapTo: to } };
}

type Side = 'top' | 'bottom' | 'left' | 'right';
const at = (side: Side, f: number) => {
  const p = `${Math.round(f * 100)}%`;
  return side === 'top'
    ? { x: p, y: '0%' }
    : side === 'bottom'
      ? { x: p, y: '100%' }
      : side === 'left'
        ? { x: '0%', y: p }
        : { x: '100%', y: p };
};

// Точки крепления связей: у каждой стороны фигуры связи расходятся по ней равномерно, по порядку
// положения соседей - вертикальные отрезки не сливаются в один, у фигур меньше пересечений.
export function attachments(edges: { source: string; target: string }[], boxes: Map<string, DiagramBox>) {
  const ends = edges.map((e) => {
    const a = boxes.get(e.source);
    const b = boxes.get(e.target);
    if (!a || !b) return undefined;
    const r = snaps(a, b, e.source, e.target);
    return { from: r.startItem.snapTo as Side, to: r.endItem.snapTo as Side, a, b };
  });
  const slots = new Map<string, { edge: number; end: 'start' | 'end'; key: number }[]>();
  const centre = (box: DiagramBox, side: Side) => (side === 'top' || side === 'bottom' ? box.x + box.width / 2 : box.y + box.height / 2);
  ends.forEach((x, i) => {
    const e = edges[i];
    if (!x || !e) return;
    for (const [node, side, end, other] of [
      [e.source, x.from, 'start', x.b],
      [e.target, x.to, 'end', x.a],
    ] as const) {
      const k = `${node}\u0000${side}`;
      slots.set(k, [...(slots.get(k) ?? []), { edge: i, end, key: centre(other, side) }]);
    }
  });
  const out = edges.map(() => ({}) as { start?: { x: string; y: string }; end?: { x: string; y: string } });
  for (const [k, list] of slots) {
    const side = k.split('\u0000')[1] as Side;
    list.sort((p, q) => p.key - q.key);
    list.forEach((slot, j) => {
      const o = out[slot.edge];
      if (o) o[slot.end] = at(side, (j + 1) / (list.length + 1));
    });
  }
  return out;
}

const orUndefined = (e: unknown): undefined => {
  if (e instanceof PortError && e.code === 'not_found') return undefined;
  throw e;
};

export function miroDiagrams(cfg: MiroConfig): Diagrams & { remove(viewId: string): Promise<void> } {
  const base = `${(cfg.api ?? 'https://api.miro.com').replace(/\/$/, '')}/v2/boards/${encodeURIComponent(cfg.board)}`;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let wait = cfg.retryMs ?? 1000;
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(path.startsWith('http') ? path : base + path, {
        method,
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Miro отвечает 500 сериями до полуминуты (создание рамки): 7 повторов - около 45 с.
      if ((r.status === 429 || r.status >= 500) && attempt < 7) {
        const after = Number(r.headers.get('retry-after'));
        await new Promise((res) => setTimeout(res, after > 0 ? after * 1000 : wait));
        wait = Math.min(wait * 2, 10_000);
        continue;
      }
      const text = await r.text();
      if (r.ok) return (text ? JSON.parse(text) : undefined) as T;
      const s = r.status;
      const code =
        s === 401 || s === 403 ? 'auth' : s === 404 ? 'not_found' : s === 409 ? 'conflict' : s === 400 ? 'invalid' : 'unavailable';
      throw new PortError(code, `Miro ${method} ${path.split('?')[0]} -> ${s} ${text.slice(0, 200)}`);
    }
  }

  async function all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: { data: T[]; links?: { next?: string } } = await call('GET', next);
      out.push(...page.data);
      next = page.links?.next;
    }
    return out;
  }

  const drop = (path: string) => call('DELETE', path).catch(orUndefined);

  async function loadMap(): Promise<MiroMap> {
    const text = await readFile(cfg.mapFile, 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return '{}';
      throw e;
    });
    return JSON.parse(text) as MiroMap;
  }

  async function saveMap(map: MiroMap) {
    await mkdir(dirname(cfg.mapFile), { recursive: true });
    await writeFile(`${cfg.mapFile}.tmp`, `${JSON.stringify(map, null, 2)}\n`);
    await rename(`${cfg.mapFile}.tmp`, cfg.mapFile);
  }

  return {
    views: ['structure'], // последовательности на доске - следующим кругом
    async publish(view) {
      if (view.flow) throw new PortError('invalid', `вид ${view.id} - последовательность: на доске Miro пока не рисуется`);
      const map = await loadMap();
      let vm = map[view.id];
      const current = vm && (await call<Item>('GET', `/frames/${vm.frame}`).catch(orUndefined));
      if (!current) vm = undefined; // рамку убрали руками - заново
      const boxes = layout(view);
      const placed = [...boxes.values()];
      const minX = Math.min(...placed.map((b) => b.x));
      const minY = Math.min(...placed.map((b) => b.y));
      const width = Math.max(...placed.map((b) => b.x + b.width)) - minX + 2 * MARGIN;
      const height = Math.max(...placed.map((b) => b.y + b.height)) - minY + 2 * MARGIN + HEADER;
      if (!vm) {
        const right = Object.values(map).reduce((m, v) => Math.max(m, v.x + v.width / 2), -GAP);
        const x = right + GAP + width / 2;
        const frame = await call<{ id: string }>('POST', '/frames', {
          data: { title: view.title, format: 'custom', type: 'freeform' },
          position: { x, y: 0 },
          geometry: { width, height },
        });
        vm = { frame: frame.id, x, width, nodes: {}, edges: {} };
      } else {
        // Miro не даёт уменьшить рамку, пока в ней элементы за новой границей: сначала - не меньше
        // прежней, точный размер - после того как узлы встали на место.
        const grow = { width: Math.max(width, current?.geometry?.width ?? 0), height: Math.max(height, current?.geometry?.height ?? 0) };
        await call('PATCH', `/frames/${vm.frame}`, { data: { title: view.title }, geometry: grow });
      }
      const old: ViewMap = { ...vm, width };
      map[view.id] = old;
      await saveMap(map); // рамка уже на доске: уборка найдёт её, даже если дальше будет сбой

      const parent = { id: old.frame };
      const nodes: Record<string, NodeRef> = {};
      const frames = view.nodes.filter((n) => isFrame(view, n)).sort((a, b) => depth(view, a) - depth(view, b));
      for (const n of [...frames, ...view.nodes.filter((n) => !isFrame(view, n))]) {
        const b = boxes.get(n.id) ?? { x: 0, y: 0, width: 320, height: 180 };
        const group = isFrame(view, n);
        const st = STYLE[n.kind] ?? { shape: 'rectangle', fill: '#1168bd' };
        const body = {
          data: { shape: group ? 'rectangle' : st.shape, content: nodeContent(group ? { title: n.title, technology: n.technology } : n) },
          style: group
            ? {
                fillColor: '#ffffff',
                fillOpacity: '0.0',
                borderColor: n.kind === 'node' ? '#666666' : '#444444',
                borderStyle: n.kind === 'node' ? 'normal' : 'dashed',
                borderWidth: '2.0',
                color: '#444444',
                fontSize: '14', // заголовок рамки - в полосе, которую расклад LikeC4 оставляет над детьми
                textAlign: 'left',
                textAlignVertical: 'top',
              }
            : {
                fillColor: st.fill,
                borderColor: st.fill,
                color: '#ffffff',
                fontSize: '20',
                textAlign: 'center',
                textAlignVertical: 'middle',
              },
          position: { x: b.x - minX + MARGIN + b.width / 2, y: b.y - minY + MARGIN + HEADER + b.height / 2 },
          geometry: { width: b.width, height: b.height },
          parent,
        };
        const was = old.nodes[n.id];
        const item =
          (was && (await call<{ id: string }>('PATCH', `/shapes/${was.item}`, body).catch(orUndefined))) ||
          (await call<{ id: string }>('POST', '/shapes', body));
        nodes[n.id] = { item: item.id, kind: n.kind };
      }

      const edges: Record<string, string> = {};
      const seen = new Map<string, number>();
      const points = attachments(view.edges, boxes);
      for (const [i, e] of view.edges.entries()) {
        const k0 = edgeKey(e.source, e.target, e.label);
        const k = `${k0}#${seen.get(k0) ?? 0}`;
        seen.set(k0, (seen.get(k0) ?? 0) + 1);
        const s = nodes[e.source]?.item;
        const t = nodes[e.target]?.item;
        if (!s || !t) throw new PortError('invalid', `связь ${e.source} -> ${e.target}: нет узла в виде ${view.id}`);
        // Связь с теми же концами обновляется на месте (стиль), иначе - новая.
        const was = old.edges[k];
        const same = was && old.nodes[e.source]?.item === s && old.nodes[e.target]?.item === t;
        const body = {
          startItem: points[i]?.start ? { id: s, position: points[i].start } : { id: s, snapTo: 'auto' },
          endItem: points[i]?.end ? { id: t, position: points[i].end } : { id: t, snapTo: 'auto' },
          shape: 'elbowed',
          ...(e.label ? { captions: [{ content: e.label }] } : {}),
          style: { endStrokeCap: 'arrow', strokeColor: '#666666', fontSize: '14', textOrientation: 'horizontal' },
        };
        const item =
          (same && (await call<{ id: string }>('PATCH', `/connectors/${was}`, body).catch(orUndefined))) ||
          (await call<{ id: string }>('POST', '/connectors', body));
        edges[k] = item.id;
      }
      for (const [k, id] of Object.entries(old.edges)) if (edges[k] !== id) await drop(`/connectors/${id}`);
      for (const [id, r] of Object.entries(old.nodes)) if (nodes[id]?.item !== r.item) await drop(`/items/${r.item}`);

      const text = {
        data: { content: `<p>${esc(VERSION + view.version)}</p>` },
        position: { x: MARGIN + 250, y: height - MARGIN / 2 },
        geometry: { width: 500 },
        parent,
      };
      const v =
        (old.versionItem && (await call<{ id: string }>('PATCH', `/texts/${old.versionItem}`, text).catch(orUndefined))) ||
        (await call<{ id: string }>('POST', '/texts', text));
      await call('PATCH', `/frames/${old.frame}`, { geometry: { width, height } });
      map[view.id] = { ...old, version: view.version, versionItem: v.id, nodes, edges };
      await saveMap(map);
      return { url: `https://miro.com/app/board/${cfg.board}/?moveToWidget=${old.frame}` };
    },

    async read(viewId) {
      const vm = (await loadMap())[viewId];
      if (!vm) return undefined;
      const frame = await call<Item>('GET', `/frames/${vm.frame}`).catch(orUndefined);
      if (!frame) return undefined;
      const items = await all<Item>(`/items?parent_item_id=${vm.frame}&limit=50`);
      const byItem = new Map(Object.entries(vm.nodes).map(([id, r]) => [r.item, { id, kind: r.kind }]));
      let version = '';
      const found: (DiagramNode & { box: DiagramBox })[] = [];
      for (const it of items) {
        const content = it.data?.content ?? '';
        const w = it.geometry?.width ?? 0;
        const h = it.geometry?.height ?? 0;
        const box = { x: (it.position?.x ?? 0) - w / 2, y: (it.position?.y ?? 0) - h / 2, width: w, height: h };
        const text = htmlText(content);
        if (it.type === 'text' && text.startsWith(VERSION)) version = text.slice(VERSION.length).trim();
        else if (it.type === 'shape') {
          const ref = byItem.get(it.id);
          found.push({ id: ref?.id ?? `miro:${it.id}`, kind: ref?.kind ?? 'system', ...parseContent(content), box });
        } else if (it.type === 'text' || it.type === 'sticky_note') found.push({ id: `miro:${it.id}`, kind: 'note', title: text, box });
      }
      const inFrame = new Set(items.map((i) => i.id));
      const node = (item: string) => byItem.get(item)?.id ?? `miro:${item}`;
      const edges = (await all<Connector>('/connectors?limit=50'))
        .filter((c) => inFrame.has(c.startItem?.id ?? '') && inFrame.has(c.endItem?.id ?? ''))
        .map((c) => {
          const label = htmlText(c.captions?.[0]?.content ?? '');
          return { source: node(c.startItem?.id ?? ''), target: node(c.endItem?.id ?? ''), ...(label ? { label } : {}) };
        });
      return { id: viewId, title: htmlText(frame.data?.title ?? ''), version, nodes: assignParents(found), edges };
    },

    // Убрать вид с доски вместе с тем, что дорисовали в его рамке руками.
    async remove(viewId) {
      const map = await loadMap();
      const vm = map[viewId];
      if (!vm) return;
      for (const id of Object.values(vm.edges)) await drop(`/connectors/${id}`);
      const inFrame = await all<Item>(`/items?parent_item_id=${vm.frame}&limit=50`).catch(orUndefined);
      for (const it of inFrame ?? []) await drop(`/items/${it.id}`);
      await drop(`/frames/${vm.frame}`);
      await saveMap(Object.fromEntries(Object.entries(map).filter(([k]) => k !== viewId)));
    },
  };
}
