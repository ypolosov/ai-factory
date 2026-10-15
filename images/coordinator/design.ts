// Сверка макета (UC3): дизайнер просит сверить макет экрана с задачей - картинкой в сообщении
// или ссылкой на рамку Figma. Судья макета - Codex по подписке (видит картинки) на своём
// раннере; итог - комментарий в задаче и в канале, метка design-ok или design-changes.
import type { ChatMessage, Knowledge, Mockups, Tracker } from '../ports/ports.ts';
import { type CheckDeps, type CheckHandler, startCheck } from './checks.ts';

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

export function designHandler(tracker: Tracker, post: (channel: string, text: string) => Promise<void>): CheckHandler {
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
    await tracker.addLabel(issue, r.matches ? 'design-ok' : 'design-changes');
    await post(channel, `${text}\n${job.url}`);
  };
}
