// Служба координатора демо: задача трекера с меткой-триггером -> задание агента у исполнителя
// заданий -> страж -> PR в цели. Запуск: node main.ts (Node 24 стирает типы, сборки нет).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import {
  selectChat,
  selectForge,
  selectJobs,
  selectKnowledge,
  selectNotifier,
  selectRegistry,
  selectTracker,
  selectWiki,
} from '../ports/select.ts';
import { compositeKnowledge, trackerKnowledge } from '../ports/tracker-knowledge.ts';
import type { Deps } from './actions.ts';
import { chatBot, gatewayLibrarian } from './bot.ts';
import { broker } from './broker.ts';
import { loadConfig } from './config.ts';
import { coordinator } from './coordinator.ts';
import { git } from './git.ts';
import { DEFAULT_GUARD } from './guard.ts';
import { gatewayJudge } from './judge.ts';
import { mcpHttp } from './mcp.ts';
import { pullGuard } from './pull-guard.ts';
import { missingImages, notes, type ReleaseDeps } from './release.ts';
import { releaseLoop } from './release-loop.ts';
import { releaseWorkflow } from './release-workflow.ts';
import { runStore } from './runs.ts';
import type { StoryDeps } from './story.ts';
import { storyLoop } from './story-loop.ts';
import { storyCheckWorkflow } from './story-workflow.ts';
import { agentTaskWorkflow } from './workflow.ts';

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const cfg = loadConfig();
const runs = runStore(join(cfg.data, 'runs'));
const deps: Deps = {
  tracker: selectTracker(cfg.tracker),
  forge: selectForge(cfg.forge),
  jobs: selectJobs(cfg.jobs),
  runs,
  git: git(cfg.git),
  job: cfg.job,
  brokerUrl: cfg.broker.url,
  labels: cfg.labels,
  guard: DEFAULT_GUARD,
};
// Знание для сверки - рабочая копия ветки по умолчанию цели; ссылки - на её коммит.
const knowledgeDir = join(cfg.data, 'knowledge');
// Чат команды: бот фабрики и уведомления; без бота - вебхук или ничего.
const chat = cfg.chat ? selectChat({ ...cfg.chat, log }) : undefined;
let knowledgeSha = 'HEAD';
const stories: StoryDeps = {
  tracker: deps.tracker,
  // Знание: правила и решения в git цели и задачи трекера.
  knowledge: compositeKnowledge([
    selectKnowledge({ kind: 'gitdocs', dir: knowledgeDir, web: cfg.knowledgeWeb, ref: () => knowledgeSha }),
    // Задачи на решение противоречий пересказывают противоречие - знанием они не считаются.
    trackerKnowledge(deps.tracker, (i) => i.labels.includes(cfg.storyLabels.decision)),
  ]),
  refreshKnowledge: async () => {
    knowledgeSha = (await deps.git.sync(knowledgeDir, (await deps.forge.repo()).defaultBranch)).sha;
  },
  judge: gatewayJudge(cfg.judge),
  notifier: chat ? { post: (text) => chat.post(cfg.productChannel, text) } : selectNotifier(cfg.notifier),
  labels: cfg.storyLabels,
};
// Выпуск: что выкладывать на стенд, служба выкладки читает из общего тома (pin - тег выпуска).
const releases: ReleaseDeps = {
  forge: deps.forge,
  tracker: deps.tracker,
  wiki: selectWiki(cfg.wiki),
  registry: selectRegistry({ kind: 'ghcr', owner: cfg.targetOwner }),
  images: cfg.releaseImages,
  post: async (text) => {
    if (chat) await chat.post(cfg.releaseChannel, text);
    else log(text);
  },
  pin: async (tag) => {
    const pin = join(cfg.cdControl, 'pin');
    if (tag) writeFileSync(pin, `${tag}\n`);
    else rmSync(pin, { force: true });
  },
};
const mastra = new Mastra({
  workflows: { agentTask: agentTaskWorkflow(deps), storyCheck: storyCheckWorkflow(stories), release: releaseWorkflow(releases) },
  storage: new LibSQLStore({ id: 'coordinator', url: `file:${join(cfg.data, 'mastra.db')}` }),
  logger: false,
});
const loop = coordinator({
  workflow: mastra.getWorkflow('agentTask'),
  tracker: deps.tracker,
  jobs: deps.jobs,
  runs,
  labels: cfg.labels,
  log,
});
const storyChecks = storyLoop({ workflow: mastra.getWorkflow('storyCheck'), tracker: deps.tracker, labels: cfg.storyLabels, log });
const configPath = join(knowledgeDir, '.factory', 'config.yml');
const pulls = pullGuard({
  forge: deps.forge,
  guard: DEFAULT_GUARD,
  targetConfig: async () => {
    await stories.refreshKnowledge();
    return existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  },
  log,
});
// MCP фабрики для экзокортексов; на хосте - только 127.0.0.1 (compose.yaml).
const mcp = mcpHttp({
  knowledge: stories.knowledge,
  refreshKnowledge: stories.refreshKnowledge,
  judge: stories.judge,
  tracker: deps.tracker,
  targetFile: async (path) => {
    await stories.refreshKnowledge();
    const p = join(knowledgeDir, path);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  },
  guard: DEFAULT_GUARD,
  agentLabel: cfg.labels.trigger,
  token: cfg.mcpToken,
});
mcp.listen(cfg.mcpPort, '0.0.0.0', () => log(`MCP фабрики: :${cfg.mcpPort}/mcp`));
const releaseChecks = releaseLoop({
  workflow: mastra.getWorkflow('release'),
  forge: deps.forge,
  seenFile: join(cfg.data, 'release-tags.json'),
  missing: (tag) => missingImages(releases, tag),
  post: releases.post,
  log,
});
const bot = chat
  ? chatBot({
      chat,
      tracker: deps.tracker,
      forge: deps.forge,
      knowledge: stories.knowledge,
      refreshKnowledge: stories.refreshKnowledge,
      librarian: gatewayLibrarian(cfg.judge),
      agentLabel: cfg.labels.trigger,
      release: { draft: async () => (await notes(releases)).text, confirm: releaseChecks.confirm },
      log,
    })
  : undefined;
const tick = async () => {
  await loop.tick();
  await storyChecks.tick();
  await pulls.tick();
  await releaseChecks.tick();
};

const server = broker({
  runs,
  env: (m) => ({ ...cfg.stepEnv, TASK_ID: m.runId, ...cfg.stepSecrets() }),
  onDone: (m) => {
    log(`${m.runId}: шаг сдал итог`);
    setTimeout(() => void loop.tick(), 5000);
  },
});
server.listen(cfg.broker.port, cfg.broker.host, () => log(`посредник шагов: ${cfg.broker.host}:${cfg.broker.port}`));
const timer = setInterval(() => void tick(), cfg.pollMs);
void tick();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    clearInterval(timer);
    mcp.close();
    bot?.close();
    server.close(() => process.exit(0));
  });
}
