// Публикация видов модели на носитель схем. Версия источника - хэш файлов модели: по ней страж
// узнаёт устаревшее представление. Запуск: make publications, или
// node images/publisher/publish.ts <likec4.json> <папка модели> plantuml <папка .puml> [!include ...] [seq:!include ...]
// node images/publisher/publish.ts <likec4.json> <папка модели> miro <файл карты>  (MIRO_TOKEN, MIRO_BOARD)
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagrams, DiagramView } from '../ports/ports.ts';
import { type DiagramsConfig, selectDiagrams } from '../ports/select.ts';
import { type L4Model, viewsFromLikeC4 } from './likec4.ts';

export async function modelVersion(dir: string): Promise<string> {
  const h = createHash('sha256');
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.c4')).sort()) {
    h.update(`${f}\n`);
    h.update(await readFile(join(dir, f)));
  }
  return h.digest('hex').slice(0, 12);
}

// Сторож без предмета падает: модель без своих видов - ошибка, а не тихий пустой успех.
export async function publishViews(model: L4Model, version: string, diagrams: Diagrams): Promise<{ view: DiagramView; url: string }[]> {
  const views = viewsFromLikeC4(model, version);
  if (!views.length) throw new Error('в модели нет видов для публикации: опишите view в docs/model');
  // Носитель получает только те роды видов, которые показывает (Miro - пока без последовательностей).
  const kinds = diagrams.views ?? ['structure'];
  const out: { view: DiagramView; url: string }[] = [];
  for (const view of views.filter((v) => kinds.includes(v.flow ? 'sequence' : 'structure')))
    out.push({ view, url: (await diagrams.publish(view)).url });
  return out;
}

async function main(): Promise<number> {
  const [json, modelDir, kind, out, ...includes] = process.argv.slice(2);
  const token = process.env.MIRO_TOKEN ?? '';
  const board = process.env.MIRO_BOARD ?? '';
  delete process.env.MIRO_TOKEN;
  const cfg: DiagramsConfig | undefined =
    kind === 'plantuml' && out
      ? {
          kind,
          dir: out,
          includes: includes.filter((i) => !i.startsWith('seq:')),
          sequenceIncludes: includes.filter((i) => i.startsWith('seq:')).map((i) => i.slice(4)),
        }
      : kind === 'miro' && out && token && board
        ? { kind, token, board, mapFile: out }
        : undefined;
  if (!json || !modelDir || !cfg) {
    console.error('использование: publish.ts <likec4.json> <папка модели> plantuml <папка .puml> [!include ...]');
    console.error('              publish.ts <likec4.json> <папка модели> miro <файл карты>, токен и доска - MIRO_TOKEN, MIRO_BOARD');
    return 2;
  }
  const diagrams = selectDiagrams(cfg);
  const model = JSON.parse(await readFile(json, 'utf8')) as L4Model;
  for (const { view, url } of await publishViews(model, await modelVersion(modelDir), diagrams))
    console.log(`${view.id} (${view.version}) -> ${url}`);
  return 0;
}

if (process.argv[1]?.endsWith('publish.ts')) {
  try {
    process.exit(await main());
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
