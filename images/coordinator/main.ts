// Служба координатора демо: задача трекера с меткой-триггером -> задание агента у исполнителя
// заданий -> страж -> PR в цели. Запуск: node main.ts (Node 24 стирает типы, сборки нет).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import {
  selectChat,
  selectForge,
  selectIncidents,
  selectJobs,
  selectKnowledge,
  selectMockups,
  selectNotifier,
  selectRegistry,
  selectTargetCi,
  selectTracker,
  selectWiki,
} from '../ports/select.ts';
import { compositeKnowledge, trackerKnowledge, wikiKnowledge } from '../ports/tracker-knowledge.ts';
import { account, accountText, gatewayUsage } from './accounting.ts';
import type { Deps } from './actions.ts';
import { chatBot, gatewayLibrarian } from './bot.ts';
import { broker } from './broker.ts';
import { checkLoop } from './checks.ts';
import { ciRerun } from './ci-rerun.ts';
import { loadConfig, stepEnvFor } from './config.ts';
import { coordinator } from './coordinator.ts';
import { designHandler, startDesign } from './design.ts';
import { git } from './git.ts';
import { DEFAULT_GUARD } from './guard.ts';
import { incidentLoop } from './incidents.ts';
import { gatewayJudge } from './judge.ts';
import { gatewayAsk } from './llm.ts';
import { mcpHttp } from './mcp.ts';
import { judgeHandler, prJudge } from './pr-judge.ts';
import { pullGuard } from './pull-guard.ts';
import { missingImages, notes, type ReleaseDeps } from './release.ts';
import { releaseLoop } from './release-loop.ts';
import { releaseWorkflow } from './release-workflow.ts';
import { parseRoles } from './roles.ts';
import { proposeRule } from './rule-candidates.ts';
import { runStore } from './runs.ts';
import { allowedLicenses, prScan, scanHandler } from './scan.ts';
import { slicer, sliceWorkflow } from './slice.ts';
import { e2eHandler, startStandE2e } from './stand-e2e.ts';
import type { StoryDeps } from './story.ts';
import { storyLoop } from './story-loop.ts';
import { storyCheckWorkflow } from './story-workflow.ts';
import { wikiStories } from './wiki-stories.ts';
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
    wikiKnowledge(selectWiki(cfg.wiki)),
  ]),
  refreshKnowledge: async () => {
    knowledgeSha = (await deps.git.sync(knowledgeDir, (await deps.forge.repo()).defaultBranch)).sha;
  },
  judge: gatewayJudge(gatewayAsk(cfg.judge)),
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
  workflows: {
    agentTask: agentTaskWorkflow(deps),
    storyCheck: storyCheckWorkflow(stories),
    release: releaseWorkflow(releases),
    slice: sliceWorkflow({
      tracker: deps.tracker,
      knowledge: stories.knowledge,
      refreshKnowledge: stories.refreshKnowledge,
      ask: gatewayAsk(cfg.judge),
      agentLabel: cfg.labels.trigger,
    }),
  },
  storage: new LibSQLStore({ id: 'coordinator', url: `file:${join(cfg.data, 'mastra.db')}` }),
  logger: false,
});
// Реестр ролей цели (.factory/roles.yml ветки по умолчанию): права в точках решения.
const roles = async () => {
  await stories.refreshKnowledge();
  const p = join(knowledgeDir, '.factory', 'roles.yml');
  return parseRoles(existsSync(p) ? readFileSync(p, 'utf8') : undefined);
};
const loop = coordinator({
  workflow: mastra.getWorkflow('agentTask'),
  tracker: deps.tracker,
  jobs: deps.jobs,
  runs,
  labels: cfg.labels,
  roles,
  trackerTool: cfg.tracker.kind,
  log,
});
const storyChecks = storyLoop({
  workflow: mastra.getWorkflow('storyCheck'),
  tracker: deps.tracker,
  labels: cfg.storyLabels,
  roles,
  trackerTool: cfg.tracker.kind,
  log,
});
const configPath = join(knowledgeDir, '.factory', 'config.yml');
const targetConfig = async () => {
  await stories.refreshKnowledge();
  return existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
};
const pulls = pullGuard({
  forge: deps.forge,
  guard: DEFAULT_GUARD,
  targetConfig,
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
  roles,
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
const incidents = cfg.incidents
  ? incidentLoop({
      incidents: selectIncidents(cfg.incidents),
      tracker: deps.tracker,
      forge: deps.forge,
      post: async (text) => {
        if (chat) await chat.post(cfg.opsChannel, text);
        else log(text);
      },
      stateFile: join(cfg.data, 'incidents.json'),
      log,
    })
  : undefined;
// Проверки на раннере: судья PR (Codex) и разбор итогов проверок.
const checkDeps = {
  runs,
  jobs: deps.jobs,
  brokerUrl: cfg.broker.url,
  pipeline: (kind: string) => (kind === 'e2e' ? 'e2e-stand' : cfg.job),
};
const targetCi = selectTargetCi(cfg.forge);
const ciReruns = targetCi
  ? ciRerun({
      ci: targetCi,
      forge: deps.forge,
      post: async (channel, text) => {
        if (chat) await chat.post(channel, text);
        else log(text);
      },
      stateFile: join(cfg.data, 'ci-reruns.json'),
      log,
    })
  : undefined;
const bot = chat
  ? chatBot({
      chat,
      tracker: deps.tracker,
      forge: deps.forge,
      knowledge: stories.knowledge,
      refreshKnowledge: stories.refreshKnowledge,
      librarian: gatewayLibrarian(gatewayAsk(cfg.judge)),
      agentLabel: cfg.labels.trigger,
      roles,
      chatTool: cfg.chat?.kind ?? 'discord',
      release: { draft: async () => (await notes(releases)).text, confirm: releaseChecks.confirm },
      account: async () => accountText(await account({ runs, forge: deps.forge, usage: gatewayUsage(cfg.gatewayLog) })),
      slice: slicer(mastra.getWorkflow('slice')),
      design: (issue, m) =>
        startDesign(
          {
            ...checkDeps,
            tracker: deps.tracker,
            knowledge: stories.knowledge,
            refreshKnowledge: stories.refreshKnowledge,
            ...(cfg.mockups ? { mockups: selectMockups(cfg.mockups) } : {}),
            ...(cfg.figmaLink ? { defaultLink: cfg.figmaLink } : {}),
          },
          issue,
          m,
        ),
      ...(ciReruns ? { ci: (channel: string, pr?: number) => ciReruns.request(channel, pr) } : {}),
      e2e: (channel) =>
        startStandE2e(
          {
            ...checkDeps,
            forge: deps.forge,
            git: deps.git,
            knowledgeDir,
            refreshKnowledge: stories.refreshKnowledge,
            post: (ch, text) => chat.post(ch, text),
          },
          channel,
        ),
      proposeRule: () =>
        proposeRule({
          forge: deps.forge,
          git: deps.git,
          workDir: () => mkdtempSync(join(cfg.data, 'rule-')),
          ask: (prompt) => gatewayAsk(cfg.judge)(prompt, 'rules-candidate'),
          post: (text) => chat.post(cfg.devChannel, text),
        }),
      log,
    })
  : undefined;
const judges = prJudge({ ...checkDeps, forge: deps.forge, tracker: deps.tracker, log });
// Сканеры изменения для всех PR цели: секреты, уязвимости и лицензии зависимостей.
const scans = prScan({
  ...checkDeps,
  forge: deps.forge,
  lockFiles: (p, paths) =>
    deps.git.changedFiles(join(cfg.data, 'scan-repo'), { base: p.targetBranch, head: p.sourceBranch, headSha: p.headSha, paths }),
  log,
});
const checks = checkLoop({
  runs,
  jobs: deps.jobs,
  handlers: {
    judge: judgeHandler(deps.forge),
    scan: scanHandler({ forge: deps.forge, runs, licenses: async () => allowedLicenses(await targetConfig()) }),
    e2e: e2eHandler(async (channel, text) => {
      if (chat) await chat.post(channel, text);
      else log(text);
    }),
    design: designHandler(deps.tracker, async (channel, text) => {
      if (chat) await chat.post(channel, text);
      else log(text);
    }),
  },
  saveCodexAuth: (auth) => {
    if (auth.trim()) writeFileSync(join(cfg.data, 'codex-auth.json'), auth, { mode: 0o600 });
  },
  log,
});
// Стори из Confluence (метка story) -> стори в Jira на сверку; итог - на страницу.
const wikiStoryLoop = wikiStories({
  wiki: releases.wiki,
  tracker: deps.tracker,
  labels: cfg.storyLabels,
  pageLabel: cfg.storyLabels.trigger,
  stateFile: join(cfg.data, 'wiki-stories.json'),
  roles,
  log,
});
const tick = async () => {
  await wikiStoryLoop.tick();
  await loop.tick();
  await storyChecks.tick();
  await pulls.tick();
  await releaseChecks.tick();
  await incidents?.tick();
  await judges.tick();
  await scans.tick();
  await checks.tick();
  await ciReruns?.tick();
};

const server = broker({
  runs,
  env: (m) => stepEnvFor(cfg, m),
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
