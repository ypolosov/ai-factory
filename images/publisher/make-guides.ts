// Сборка руководств: факты из файлов фабрики и модели -> писатель (Claude) пишет инструкции по
// ролям данными по схеме -> судья (Codex, другое семейство) проверяет каждое предложение с
// цитатой -> код сверяет цитаты и собирает Markdown. Есть неподтверждённое - руководство не
// пишется, отчёт судьи - рядом. Запуск: make guides, или
// node images/publisher/make-guides.ts <likec4.json> <папка модели> <папка руководств> - собрать;
// с --confluence - опубликовать подтверждённое (ATLASSIAN_SITE, ATLASSIAN_EMAIL,
// CONFLUENCE_API_TOKEN, CONFLUENCE_PUBLICATIONS_SPACE).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectWiki } from '../ports/select.ts';
import {
  agentSkill,
  checkFaithfulness,
  type Draft,
  draftSchema,
  type Judge,
  judgeInput,
  judgePrompt,
  peopleGuide,
  peopleRoles,
  type Verdict,
  verdictSchema,
  type Writer,
  writerPrompt,
} from './guides.ts';
import { items, parseDecisions, parseHelp, parseScenario, parseTools, type SourceItem, type SourcePack } from './sources.ts';

const FILES = ['images/coordinator/bot.ts', 'images/coordinator/mcp.ts', 'images/coordinator/roles.ts', 'docs/demo/scenario.md'];

interface L4Element {
  title: string;
  kind: string;
  technology?: string | null;
  description?: { txt?: string; md?: string } | null;
}

// Источник руководства: модель (элементы) и файлы фабрики; версия - хэш всего этого.
export async function buildPack(likec4Json: string, modelDir: string, root = '.') {
  const h = createHash('sha256');
  for (const f of (await readdir(modelDir)).filter((f) => f.endsWith('.c4')).sort()) h.update(await readFile(join(modelDir, f)));
  const text = Object.fromEntries(await Promise.all(FILES.map(async (f) => [f, await readFile(join(root, f), 'utf8')] as const)));
  for (const f of FILES) h.update(text[f] ?? '');
  const help = parseHelp(text['images/coordinator/bot.ts'] ?? '');
  const scenario = parseScenario(text['docs/demo/scenario.md'] ?? '');
  const model = JSON.parse(await readFile(likec4Json, 'utf8')) as { elements: Record<string, L4Element> };
  const elements: SourceItem[] = Object.entries(model.elements)
    .filter(([id]) => id === 'factory' || id.startsWith('factory.') || id === 'exo')
    .map(([id, e]) => {
      const d = e.description?.txt ?? e.description?.md;
      return { id: `el:${id}`, text: `${e.title}${e.technology ? ` [${e.technology}]` : ''}${d ? `: ${d}` : ''}` };
    });
  const pack: SourcePack = {
    version: h.digest('hex').slice(0, 12),
    commands: help.commands,
    tools: parseTools(text['images/coordinator/mcp.ts'] ?? ''),
    decisions: parseDecisions(text['images/coordinator/roles.ts'] ?? ''),
    prep: scenario.prep,
    steps: scenario.steps,
    elements,
  };
  return { pack, about: help.about };
}

// Писатель и судья не получают учёток носителей: Codex исполняет команды и мог бы их прочитать.
const SECRET = /^(ATLASSIAN|CONFLUENCE|JIRA|MIRO|GITHUB|BITBUCKET|DISCORD|FIGMA)_/;
const run = (cmd: string, args: string[], input: string, cwd: string) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET.test(k)));
  const r = spawnSync(cmd, args, { input, cwd, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 900_000 });
  if (r.status !== 0) throw new Error(`${cmd}: код ${r.status ?? r.signal} ${(r.stderr || r.stdout).slice(-400)}`);
  return r.stdout;
};

// Писатель - Claude Code по подписке, без инструментов, ответ строго по схеме.
export function claudeWriter(effort = 'medium'): Writer {
  return {
    async write(facts, roles, fix) {
      const out = run(
        'claude',
        ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(draftSchema), '--effort', effort, '--tools', ''],
        writerPrompt(facts, roles, fix),
        mkdtempSync(join(tmpdir(), 'writer-')),
      );
      const parsed = JSON.parse(out) as unknown;
      const last = (Array.isArray(parsed) ? parsed.at(-1) : parsed) as { structured_output?: Draft; is_error?: boolean } | undefined;
      if (!last?.structured_output) throw new Error('писатель не вернул данные по схеме');
      return last.structured_output;
    },
  };
}

// Судья - Codex по подписке (другое семейство моделей), только чтение, ответ по схеме.
export function codexJudge(effort = 'high'): Judge {
  return {
    async judge(list) {
      const dir = mkdtempSync(join(tmpdir(), 'judge-'));
      writeFileSync(join(dir, 'schema.json'), JSON.stringify(verdictSchema));
      run(
        'codex',
        [
          'exec',
          '--skip-git-repo-check',
          '--ephemeral',
          '-s',
          'read-only',
          '-c',
          `model_reasoning_effort=${effort}`,
          '--output-schema',
          'schema.json',
          '-o',
          'out.json',
          '-',
        ],
        judgePrompt(list),
        dir,
      );
      return (JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as { verdicts: Verdict[] }).verdicts;
    },
  };
}

interface Report {
  version: string;
  draft: Draft;
  verdicts: Verdict[];
  failures: { id: string; text: string; reason: string }[];
}

// Писатель -> судья -> исправление отклонённого (не больше двух кругов). Отчёт судьи - рядом
// с руководством: по нему публикация проверяет, что текст подтверждён для этой версии источника.
async function build(json: string, modelDir: string, out: string): Promise<number> {
  const { pack, about } = await buildPack(json, modelDir);
  const facts = items(pack);
  const roles = peopleRoles(pack);
  console.log(`источник ${pack.version}: ${facts.length} фактов, роли: ${roles.join(', ')}`);
  const writer = claudeWriter();
  const judge = codexJudge();
  let draft = await writer.write(facts, roles);
  let verdicts = await judge.judge(judgeInput(draft, facts));
  let failures = checkFaithfulness(draft, facts, verdicts);
  for (let round = 1; failures.length && round <= 2; round++) {
    console.log(`круг исправления ${round}: судья отклонил ${failures.length}`);
    draft = await writer.write(facts, roles, { draft, failures });
    verdicts = await judge.judge(judgeInput(draft, facts));
    failures = checkFaithfulness(draft, facts, verdicts);
  }
  await mkdir(join(out, 'agents', 'ai-factory'), { recursive: true });
  const report: Report = { version: pack.version, draft, verdicts, failures };
  await writeFile(join(out, 'judge.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (failures.length) {
    console.error(`судья не подтвердил ${failures.length} предложений - руководство не собрано (${join(out, 'judge.json')}):`);
    for (const f of failures) console.error(`- ${f.id}: ${f.text}\n  ${f.reason}`);
    return 1;
  }
  await writeFile(
    join(out, 'people.md'),
    peopleGuide(
      pack,
      draft,
      pack.elements.find((e) => e.id === 'el:factory'),
      about,
    ),
  );
  await writeFile(join(out, 'agents', 'ai-factory', 'SKILL.md'), agentSkill(pack));
  console.log(`руководство людям и навык агентам - ${out} (все ${verdicts.length} предложений подтверждены)`);
  return 0;
}

// Публикация в Confluence без новых вызовов моделей: текст собирается из подтверждённого
// черновика, если он подтверждён для текущей версии источника.
async function confluence(json: string, modelDir: string, out: string): Promise<number> {
  const env = (k: string) => process.env[k] ?? '';
  const cfg = {
    site: env('ATLASSIAN_SITE'),
    email: env('ATLASSIAN_EMAIL'),
    token: env('CONFLUENCE_API_TOKEN'),
    space: env('CONFLUENCE_PUBLICATIONS_SPACE'),
  };
  if (Object.values(cfg).some((v) => !v))
    throw new Error('нужны ATLASSIAN_SITE, ATLASSIAN_EMAIL, CONFLUENCE_API_TOKEN, CONFLUENCE_PUBLICATIONS_SPACE');
  const { pack, about } = await buildPack(json, modelDir);
  const report = JSON.parse(await readFile(join(out, 'judge.json'), 'utf8')) as Report;
  if (report.version !== pack.version || report.failures.length) {
    console.error(
      `руководство не подтверждено для версии ${pack.version} (в отчёте ${report.version}, отклонено ${report.failures.length}): сначала make guides`,
    );
    return 1;
  }
  const people = peopleGuide(
    pack,
    report.draft,
    pack.elements.find((e) => e.id === 'el:factory'),
    about,
  );
  await writeFile(join(out, 'people.md'), people); // та же сборка, что и в Confluence
  await writeFile(join(out, 'agents', 'ai-factory', 'SKILL.md'), agentSkill(pack));
  const page = await selectWiki({ kind: 'confluence', ...cfg }).upsertPage(
    'Как пользоваться фабрикой ПО на ИИ',
    people.replace(/^# .*\n\n/, ''),
  );
  console.log(`Confluence: ${page.url}`);
  return 0;
}

async function main(): Promise<number> {
  const [json, modelDir, out, flag] = process.argv.slice(2);
  if (!json || !modelDir || !out) {
    console.error('использование: make-guides.ts <likec4.json> <папка модели> <папка руководств> [--confluence]');
    return 2;
  }
  return flag === '--confluence' ? confluence(json, modelDir, out) : build(json, modelDir, out);
}

if (process.argv[1]?.endsWith('make-guides.ts')) {
  try {
    process.exit(await main());
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
