// Выпуск цели (UC5): тег vX.Y.Z -> заметки о выпуске из коммитов с прошлого тега (PR и задачи)
// -> подтверждение выкладки человеком -> образы тега в реестре -> выкладка на стенд ->
// задачи помечены выпуском, страница заметок в вики, сообщение в канал выпусков.
import type { Forge, Registry, Tracker, Wiki } from '../ports/ports.ts';

export interface ReleaseDeps {
  forge: Forge;
  tracker: Tracker;
  wiki: Wiki;
  registry: Registry;
  images: string[];
  post(text: string): Promise<void>; // канал выпусков
  pin(tag: string | undefined): Promise<void>; // что выкладывать на стенд: тег или ветка по умолчанию
}

export interface Notes {
  tag: string;
  sha: string;
  prev?: string;
  keys: string[];
  text: string;
}

const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;

export const isRelease = (tag: string) => SEMVER.test(tag);

const version = (tag: string) => (SEMVER.exec(tag) ?? []).slice(1).map(Number);

export function newer(a: string, b: string): number {
  const [x, y] = [version(a), version(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

// Заметки о выпуске tag (или о том, что войдёт в следующий, если tag не задан).
export async function notes(d: ReleaseDeps, tag?: string): Promise<Notes> {
  const tags = (await d.forge.tags()).filter((t) => isRelease(t.name)).sort((a, b) => newer(b.name, a.name));
  const repo = await d.forge.repo();
  const sha = tag ? tags.find((t) => t.name === tag)?.sha : await d.forge.branchHead(repo.defaultBranch);
  if (!sha) throw new Error(`нет тега ${tag}`);
  const prev = tags.find((t) => !tag || newer(t.name, tag) < 0);
  const commits = (await d.forge.commits(prev?.sha, sha)).filter((c) => c.sha !== prev?.sha);
  const keys = new Set<string>();
  const lines: string[] = [];
  for (const c of commits.reverse()) {
    const title = c.message.split('\n')[0] ?? '';
    for (const k of c.message.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []) keys.add(k);
    const pr = /\(#(\d+)\)\s*$/.exec(title)?.[1];
    lines.push(`- ${title}${pr ? ` ${repo.webUrl}/pull/${pr}` : ''}`);
  }
  const issues: string[] = [];
  for (const k of keys) {
    try {
      const i = await d.tracker.getIssue(k);
      issues.push(`- ${k} ${i.title} ${i.url}`);
    } catch {
      keys.delete(k);
    }
  }
  const name = tag ?? 'следующий выпуск';
  const text = [
    `## ${name}: изменения с ${prev?.name ?? 'начала'}`,
    ...(lines.length ? lines : ['- изменений нет']),
    '## Задачи',
    ...(issues.length ? issues : ['- без задач']),
  ].join('\n');
  return { tag: tag ?? '', sha, ...(prev ? { prev: prev.name } : {}), keys: [...keys], text };
}

export async function draft(d: ReleaseDeps, tag: string): Promise<Notes> {
  const n = await notes(d, tag);
  await d.post(`Собран тег ${tag}. Черновик заметок о выпуске:\n${n.text}\n\nВыкладка на стенд - после подтверждения: !выкладка ${tag}`);
  return n;
}

// Образы выпуска, которых ещё нет в реестре.
export async function missingImages(d: Pick<ReleaseDeps, 'registry' | 'images'>, tag: string): Promise<string[]> {
  const out: string[] = [];
  for (const image of d.images) if (!(await d.registry.exists(image, tag))) out.push(`${image}:${tag}`);
  return out;
}

export async function deploy(d: ReleaseDeps, tag: string): Promise<void> {
  const missing = await missingImages(d, tag);
  if (missing.length) throw new Error(`нет образов ${missing.join(', ')} в реестре - CI цели ещё не собрал выпуск`);
  await d.pin(tag);
}

export async function publish(d: ReleaseDeps, n: Notes, by: string): Promise<string> {
  const page = await d.wiki.upsertPage(
    `Выпуск ${n.tag}`,
    `${n.text}\n## Выкладка\nПодтвердил: ${by}. Стенд работает на ${n.tag} (${n.sha.slice(0, 7)}).`,
  );
  for (const k of n.keys) {
    await d.tracker.addLabel(k, `release-${n.tag}`);
    await d.tracker.addComment(k, `Вошло в выпуск ${n.tag}: ${page.url}`);
  }
  await d.post(`Выпуск ${n.tag} на стенде. Заметки: ${page.url}`);
  return page.url;
}
