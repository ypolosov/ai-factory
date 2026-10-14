// Служба координатора демо: задача трекера с меткой-триггером -> задание агента у исполнителя
// заданий -> страж -> PR в цели. Запуск: node main.ts (Node 24 стирает типы, сборки нет).
import { join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { selectForge, selectJobs, selectTracker } from '../ports/select.ts';
import type { Deps } from './actions.ts';
import { broker } from './broker.ts';
import { loadConfig } from './config.ts';
import { coordinator } from './coordinator.ts';
import { git } from './git.ts';
import { DEFAULT_GUARD } from './guard.ts';
import { runStore } from './runs.ts';
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
const mastra = new Mastra({
  workflows: { agentTask: agentTaskWorkflow(deps) },
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

const server = broker({
  runs,
  env: (m) => ({ ...cfg.stepEnv, TASK_ID: m.runId, ...cfg.stepSecrets() }),
  onDone: (m) => {
    log(`${m.runId}: шаг сдал итог`);
    setTimeout(() => void loop.tick(), 5000);
  },
});
server.listen(cfg.broker.port, cfg.broker.host, () => log(`посредник шагов: ${cfg.broker.host}:${cfg.broker.port}`));
const timer = setInterval(() => void loop.tick(), cfg.pollMs);
void loop.tick();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  });
}
