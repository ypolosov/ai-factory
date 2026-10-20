// Адаптер схем PlantUML (C4-PlantUML): вид модели -> файл .puml, картинку рядом рисует
// `make diagrams`. Читает обратно тот же файл: правка руками (в ветке) видна как разница с моделью.
// Псевдоним элемента - его идентификатор в модели, кодированный обратимо; тексты - тоже.
// Ограничение носителя: у рамки (группа, система с детьми) описание не показывается, у узла
// развёртывания - только технология.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type DiagramBlock,
  type DiagramEdge,
  type DiagramFlow,
  type DiagramNode,
  type Diagrams,
  type DiagramView,
  PortError,
} from './ports.ts';

export interface PlantUmlConfig {
  dir: string; // папка файлов .puml (docs/<раздел>/diagrams)
  includes?: string[]; // общий стиль схем C4: пути для !include относительно dir
  sequenceIncludes?: string[]; // общий стиль последовательностей (UML)
}

const MACRO: Record<string, string> = {
  person: 'Person',
  system: 'System',
  external: 'System_Ext',
  container: 'Container',
  database: 'ContainerDb',
  node: 'Deployment_Node',
  '@group': 'System_Boundary',
};
const KIND: Record<string, string> = Object.fromEntries(Object.entries(MACRO).map(([k, m]) => [m, k]));
const WITH_TECH = new Set(['Container', 'ContainerDb']);
const CODES: Record<string, string> = { u: '_', d: '.', a: '@', h: '-' };
const FOOTER = 'Источник: модель, версия ';

export const alias = (id: string) => `e_${id.replace(/_/g, '_u').replace(/\./g, '_d').replace(/@/g, '_a').replace(/-/g, '_h')}`;
export const unalias = (a: string) => a.replace(/^e_/, '').replace(/_([udah])/g, (_, c: string) => CODES[c] ?? '');

// Текст в строке PlantUML: кавычки, обратная косая и & - числовыми ссылками, перевод строки - \n.
export const enc = (t: string) => t.replace(/&/g, '&#38;').replace(/"/g, '&#34;').replace(/\\/g, '&#92;').replace(/\n/g, '\\n');
export const dec = (t: string) => t.replace(/\\n/g, '\n').replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)));

export function toPlantUml(view: DiagramView, includes: string[] = []): string {
  const out = [
    `@startuml ${view.id}`,
    "' Сгенерировано из модели (docs/model): правка - в модели, а не здесь.",
    '!include <C4/C4_Deployment>',
    ...includes.map((i) => `!include ${i}`),
    '',
    `title ${enc(view.title)}`,
    `footer ${FOOTER}${view.version}`,
    '',
  ];
  const q = (t?: string) => `"${enc(t ?? '')}"`;
  const element = (n: DiagramNode, pad: string) => {
    const children = view.nodes.filter((c) => c.parent === n.id);
    const frame = n.kind === '@group' || n.kind === 'node' || children.length > 0;
    const macro = frame ? (n.kind === 'node' ? 'Deployment_Node' : 'System_Boundary') : (MACRO[n.kind] ?? 'System');
    const args = [alias(n.id), q(n.title)];
    if (macro === 'Deployment_Node') args.push(q(n.technology));
    else if (WITH_TECH.has(macro)) args.push(q(n.technology), ...(n.description ? [q(n.description)] : []));
    else if (macro !== 'System_Boundary' && n.description) args.push(q(n.description));
    if (!frame) return out.push(`${pad}${macro}(${args.join(', ')})`);
    out.push(`${pad}${macro}(${args.join(', ')}) {`);
    for (const c of children) element(c, `${pad}  `);
    return out.push(`${pad}}`);
  };
  for (const n of view.nodes.filter((n) => !n.parent)) element(n, '');
  out.push('');
  for (const e of view.edges) out.push(`Rel(${alias(e.source)}, ${alias(e.target)}, "${enc(e.label ?? '')}")`);
  out.push('', 'SHOW_LEGEND()', '@enduml', '');
  return out.join('\n');
}

// Последовательность: участники по порядку, шаги с номерами, заметки к шагам, блоки
// alt/else, par/else, opt, loop, break, group. Ветки par в PlantUML - через else, при чтении
// они снова сливаются в один поток.
const BLOCKS = new Set(['opt', 'loop', 'break', 'group']);

export function toPlantUmlSequence(view: DiagramView, includes: string[] = []): string {
  const out = [
    `@startuml ${view.id}`,
    "' Сгенерировано из модели (docs/model): правка - в модели, а не здесь.",
    ...includes.map((i) => `!include ${i}`),
    '',
    `title ${enc(view.title)}`,
    `footer ${FOOTER}${view.version}`,
    '',
    ...view.nodes.map((n) => `${n.kind === 'person' ? 'actor' : 'participant'} "${enc(n.title)}" as ${alias(n.id)}`),
    'autonumber',
  ];
  const walk = (flow: DiagramFlow, pad: string) => {
    for (const x of flow) {
      if (typeof x !== 'number') block(x, pad);
      else {
        const e = view.edges[x];
        if (!e) throw new PortError('invalid', `шаг ${x} вида ${view.id}: нет такой связи`);
        out.push(`${pad}${alias(e.source)} -> ${alias(e.target)} : ${enc(e.label ?? '')}`);
        if (e.note) out.push(`${pad}note right of ${alias(e.target)} : ${enc(e.note)}`);
      }
    }
  };
  const block = (b: DiagramBlock, pad: string) => {
    const title = (t?: string) => (t ? ` ${enc(t)}` : '');
    if (b.kind === 'alt')
      for (const [i, br] of (b.branches ?? []).entries()) {
        out.push(`${pad}${i ? 'else' : 'alt'}${title(br.title)}`);
        walk(br.flow, `${pad}  `);
      }
    else if (b.kind === 'par')
      for (const [i, x] of (b.flow ?? []).entries()) {
        out.push(`${pad}${i ? 'else' : `par${title(b.title)}`}`);
        walk([x], `${pad}  `);
      }
    else if (BLOCKS.has(b.kind)) {
      out.push(`${pad}${b.kind}${title(b.title)}`);
      walk(b.flow ?? [], `${pad}  `);
    } else throw new PortError('invalid', `блок ${b.kind} в последовательности ${view.id} носитель не показывает`);
    out.push(`${pad}end`);
  };
  walk(view.flow ?? [], '');
  out.push('@enduml', '');
  return out.join('\n');
}

const PART = /^\s*(actor|participant)\s+"([^"]*)"\s+as\s+(\w+)\s*$/;
const MSG = /^\s*(\w+)\s*-+>+\s*(\w+)\s*:\s?(.*)$/;
const NOTE = /^\s*note\s+(?:right|left|over)\s+(?:of\s+)?(\w+)\s*:\s?(.*)$/;
const OPEN = /^\s*(alt|par|opt|loop|break|group)\b\s*(.*)$/;
const ELSE = /^\s*else\b\s*(.*)$/;

export function fromPlantUmlSequence(text: string): DiagramView {
  const lines = text.split(/\r?\n/);
  const id = /^@startuml\s+(\S+)/.exec(lines.find((l) => l.startsWith('@startuml')) ?? '')?.[1];
  if (!id) throw new PortError('invalid', 'в файле нет @startuml с именем вида');
  const view: DiagramView = { id, title: '', version: '', nodes: [], edges: [], flow: [] };
  const stack: { block?: DiagramBlock; flow: DiagramFlow }[] = [{ flow: view.flow ?? [] }];
  const top = () => stack[stack.length - 1] ?? { flow: [] };
  for (const line of lines) {
    const part = PART.exec(line);
    const msg = MSG.exec(line);
    const note = NOTE.exec(line);
    const open = OPEN.exec(line);
    const els = ELSE.exec(line);
    if (line.startsWith('title ')) view.title = dec(line.slice(6));
    else if (line.startsWith(`footer ${FOOTER}`)) view.version = line.slice(7 + FOOTER.length).trim();
    else if (part)
      view.nodes.push({ id: unalias(part[3] ?? ''), kind: part[1] === 'actor' ? 'person' : 'system', title: dec(part[2] ?? '') });
    else if (note) {
      const last = view.edges.at(-1);
      if (last) last.note = dec(note[2] ?? '');
    } else if (open) {
      const kind = open[1] ?? 'group';
      const title = dec(open[2] ?? '').trim();
      const block: DiagramBlock =
        kind === 'alt' ? { kind, branches: [{ ...(title ? { title } : {}), flow: [] }] } : { kind, ...(title ? { title } : {}), flow: [] };
      top().flow.push(block);
      stack.push({ block, flow: block.branches?.[0]?.flow ?? block.flow ?? [] });
    } else if (els) {
      const frame = top();
      if (frame.block?.kind === 'alt') {
        const title = dec(els[1] ?? '').trim();
        const branch = { ...(title ? { title } : {}), flow: [] as DiagramFlow };
        frame.block.branches?.push(branch);
        frame.flow = branch.flow;
      }
    } else if (/^\s*end\s*$/.test(line)) stack.pop();
    else if (msg) {
      const label = dec(msg[3] ?? '');
      view.edges.push({ source: unalias(msg[1] ?? ''), target: unalias(msg[2] ?? ''), ...(label ? { label } : {}) });
      top().flow.push(view.edges.length - 1);
    }
  }
  return view;
}

const STR = '"([^"]*)"';
const ELEMENT = /^\s*(\w+)\((\w+)((?:\s*,\s*"[^"]*")*)[^)]*\)\s*(\{)?\s*$/;
const REL = new RegExp(`^\\s*Rel(?:_[A-Za-z]+)?\\((\\w+),\\s*(\\w+),\\s*${STR}`);

export function fromPlantUml(text: string): DiagramView {
  const lines = text.split(/\r?\n/);
  const id = /^@startuml\s+(\S+)/.exec(lines.find((l) => l.startsWith('@startuml')) ?? '')?.[1];
  if (!id) throw new PortError('invalid', 'в файле нет @startuml с именем вида');
  const view: DiagramView = { id, title: '', version: '', nodes: [], edges: [] };
  const groups: string[] = [];
  for (const line of lines) {
    const m = ELEMENT.exec(line);
    const el = m && KIND[m[1] ?? ''] ? m : null;
    const rel = REL.exec(line);
    if (line.startsWith('title ')) view.title = dec(line.slice(6));
    else if (line.startsWith(`footer ${FOOTER}`)) view.version = line.slice(7 + FOOTER.length).trim();
    else if (el) {
      const [, macro = '', a = '', strings = '', open] = el;
      const [title = '', second, third] = [...strings.matchAll(/"([^"]*)"/g)].map((s) => dec(s[1] ?? ''));
      const technology = macro === 'Deployment_Node' || WITH_TECH.has(macro) ? second : undefined;
      const description = WITH_TECH.has(macro) ? third : macro === 'Deployment_Node' || macro === 'System_Boundary' ? undefined : second;
      const parent = groups.at(-1);
      view.nodes.push({
        id: unalias(a),
        kind: KIND[macro] ?? 'system',
        title,
        ...(technology ? { technology } : {}),
        ...(description ? { description } : {}),
        ...(parent ? { parent } : {}),
      });
      if (open) groups.push(unalias(a));
    } else if (/^\s*\}\s*$/.test(line)) groups.pop();
    else if (rel) {
      const [, s = '', t = '', label = ''] = rel;
      const edge: DiagramEdge = { source: unalias(s), target: unalias(t), ...(label ? { label: dec(label) } : {}) };
      view.edges.push(edge);
    }
  }
  return view;
}

export function plantumlDiagrams(cfg: PlantUmlConfig): Diagrams {
  const file = (viewId: string) => join(cfg.dir, `${viewId}.puml`);
  return {
    views: ['structure', 'sequence'],
    async publish(view) {
      if (!/^[A-Za-z][\w-]*$/.test(view.id)) throw new PortError('invalid', `имя вида ${view.id}: латиница, цифры, _ и -`);
      await mkdir(cfg.dir, { recursive: true });
      await writeFile(file(view.id), view.flow ? toPlantUmlSequence(view, cfg.sequenceIncludes) : toPlantUml(view, cfg.includes));
      return { url: file(view.id) };
    },
    async read(viewId) {
      const text = await readFile(file(viewId), 'utf8').catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return undefined;
        throw e;
      });
      if (text === undefined) return undefined;
      return text.split(/\r?\n/).some((l) => PART.test(l)) ? fromPlantUmlSequence(text) : fromPlantUml(text);
    },
  };
}
