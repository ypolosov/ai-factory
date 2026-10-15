// Адаптер макетов Figma (REST API): картинка рамки по ссылке figma.com/design/<ключ>/...?node-id=1-2.
// Без node-id - первая рамка первой страницы (ещё один запрос). Бесплатный план даёт мало
// запросов в месяц, поэтому одна сверка - один-два запроса. Файлы Figma Make API не отдаёт.
import { type Mockups, PortError } from './ports.ts';

export interface FigmaConfig {
  token: string;
  api?: string; // по умолчанию https://api.figma.com
}

type Json = Record<string, unknown>;

export function parseFigmaLink(link: string): { key: string; node?: string; kind: string } | undefined {
  let u: URL;
  try {
    u = new URL(link.trim().replace(/^"|"$/g, ''));
  } catch {
    return undefined;
  }
  if (!/(^|\.)figma\.com$/.test(u.hostname)) return undefined;
  const m = /^\/(file|design|proto|board|make)\/([A-Za-z0-9]+)/.exec(u.pathname);
  if (!m?.[1] || !m[2]) return undefined;
  const node = u.searchParams.get('node-id')?.replace(/-/g, ':');
  return { kind: m[1], key: m[2], ...(node ? { node } : {}) };
}

export function figmaMockups(cfg: FigmaConfig): Mockups {
  const api = (cfg.api ?? 'https://api.figma.com').replace(/\/$/, '');
  async function call(path: string): Promise<Json> {
    const r = await fetch(`${api}${path}`, { headers: { 'X-Figma-Token': cfg.token } });
    const body = (await r.json().catch(() => ({}))) as Json;
    if (!r.ok) {
      const code = r.status === 404 ? 'not_found' : r.status === 403 ? 'auth' : r.status === 429 ? 'unavailable' : 'invalid';
      throw new PortError(
        code,
        `Figma ${r.status}: ${String(body.err ?? body.message ?? '')}${r.status === 429 ? ' (лимит запросов плана)' : ''}`,
      );
    }
    return body;
  }
  return {
    async render(link) {
      const f = parseFigmaLink(link);
      if (!f) throw new PortError('invalid', 'нужна ссылка на рамку Figma (figma.com/design/...)');
      if (f.kind === 'make')
        throw new PortError('invalid', 'файлы Figma Make API не отдаёт - нужна ссылка на файл Figma Design или картинка макета');
      let node = f.node;
      if (!node) {
        const file = await call(`/v1/files/${f.key}?depth=2`);
        const pages = ((file.document as Json | undefined)?.children as Json[] | undefined) ?? [];
        node = String(((pages[0]?.children as Json[] | undefined) ?? []).find((n) => n.type === 'FRAME')?.id ?? '');
        if (!node) throw new PortError('not_found', 'в файле нет рамок');
      }
      const img = await call(`/v1/images/${f.key}?ids=${encodeURIComponent(node)}&format=png&scale=1`);
      const url = String((img.images as Json | undefined)?.[node] ?? '');
      if (!url) throw new PortError('not_found', `Figma не отрисовал рамку ${node}`);
      const png = new Uint8Array(await (await fetch(url)).arrayBuffer());
      return { png, source: `https://www.figma.com/design/${f.key}/?node-id=${node.replace(/:/g, '-')}` };
    },
  };
}
