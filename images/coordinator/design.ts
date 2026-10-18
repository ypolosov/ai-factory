// Сверка макета (UC3): дизайнер просит сверить макет экрана с задачей - картинкой в сообщении
// или ссылкой на рамку Figma. Судья макета - Codex по подписке (видит картинки) на своём
// раннере; итог - комментарий в задаче и в канале, метка design-ok или design-changes.
// Принятый макет (design-ok) хранится на задачу: его получает агент задачи.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, Knowledge, Mockups, Tracker } from '../ports/ports.ts';
import { type CheckDeps, type CheckHandler, startCheck } from './checks.ts';
import type { RunStore } from './runs.ts';

export interface DesignDeps extends CheckDeps {
  tracker: Tracker;
  knowledge: Knowledge;
  refreshKnowledge(): Promise<void>;
  mockups?: Mockups;
  defaultLink?: string; // макет по умолчанию (FIGMA_FILE_KEY)
}

const PNG = [0x89, 0x50, 0x4e, 0x47];

export async function startDesign(d: DesignDeps, issue: string, m: Pick<ChatMessage, 'channel' | 'text' | 'attachments'>): Promise<string> {
  const i = await d.tracker.getIssue(issue);
  const link = /(https:\/\/[^\s>]*figma\.com\/[^\s>]+)/.exec(m.text)?.[1] ?? d.defaultLink;
  const image = m.attachments?.find((a) => a.contentType?.startsWith('image/') || /\.png$/i.test(a.name));
  let png: Uint8Array;
  let source: string;
  if (image) {
    png = new Uint8Array(await (await fetch(image.url)).arrayBuffer());
    source = image.name;
  } else if (link && d.mockups) {
    ({ png, source } = await d.mockups.render(link));
  } else {
    return 'Приложите картинку макета (PNG) или дайте ссылку на рамку Figma Design.';
  }
  if (!PNG.every((b, n) => png[n] === b)) return 'Макет должен быть картинкой PNG.';
  await d.refreshKnowledge();
  const ps = (await d.knowledge.search(`${i.title}\n${i.body}`, 7)).filter((p) => p.source !== i.key).slice(0, 6);
  const { jobUrl } = await startCheck(d, {
    kind: 'design',
    issue: i.key,
    subject: `${i.key}:${m.channel}`,
    task: `Задача ${i.key}: ${i.title}\n${i.body}\n\nМакет: ${source}\n\nПравила и решения проекта:\n${ps.map((p) => `- ${p.source}: ${p.text.slice(0, 600)}`).join('\n')}`,
    input: png,
  });
  return `Сверяю макет с задачей ${i.key} (судья макета - Codex): ${jobUrl}`;
}

interface DesignResult {
  matches: boolean;
  score: number;
  summary: string;
  remarks: { area: string; issue: string; requirement: string }[];
}

// Принятые макеты на диске: последняя картинка, принятая судьёй макета, на задачу (<ключ>.png).
export interface AcceptedMockups {
  save(issue: string, png: Uint8Array): void;
  read(issue: string): Buffer | undefined;
}

export function acceptedMockups(root: string): AcceptedMockups {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = (issue: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(issue)) throw new Error(`плохой ключ задачи: ${issue}`);
    return join(root, `${issue}.png`);
  };
  return {
    save: (issue, png) => writeFileSync(path(issue), png, { mode: 0o600 }),
    read: (issue) => (existsSync(path(issue)) ? readFileSync(path(issue)) : undefined),
  };
}

// accepted - куда сохранить принятый макет: картинка - вход запуска сверки, заново не скачивается.
export function designHandler(
  tracker: Tracker,
  post: (channel: string, text: string) => Promise<void>,
  accepted: { runs: RunStore; mockups: AcceptedMockups },
): CheckHandler {
  return async (meta, result, job) => {
    const [issue = '', ...rest] = (meta.subject ?? '').split(':');
    const channel = rest.join(':');
    const r = result as DesignResult | undefined;
    if (!r || typeof r.score !== 'number') {
      await post(channel, `Сверка макета ${issue} не дала итога (${job.state}). ${job.url}`);
      return;
    }
    const remarks = r.remarks.map((x) => `- ${x.area}: ${x.issue} (${x.requirement})`).join('\n') || '- замечаний нет';
    const text = `Сверка макета с ${issue} (судья макета - Codex): ${r.matches ? 'соответствует' : 'нужны правки'}, ${r.score}/100.\n${r.summary}\n${remarks}`;
    await tracker.addComment(issue, text);
    const png = r.matches ? accepted.runs.read(meta.runId, 'input') : undefined;
    if (png) accepted.mockups.save(issue, png);
    await tracker.addLabel(issue, r.matches ? 'design-ok' : 'design-changes');
    await post(channel, `${text}\n${job.url}`);
  };
}
