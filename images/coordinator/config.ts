// Настройка координатора: обычные значения - из окружения (compose.yaml), учётки - из файлов
// каталога секретов (.state/coordinator, монтируется только для чтения). Ключи шага читаются
// в момент выдачи посредником и в окружение процесса не попадают.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appToken } from '../ports/github-app.ts';
import type {
  ChatConfig,
  ForgeConfig,
  IncidentsConfig,
  JobsConfig,
  MockupsConfig,
  NotifierConfig,
  TrackerConfig,
  WikiConfig,
} from '../ports/select.ts';
import type { Labels } from './actions.ts';
import type { GitConfig } from './git.ts';
import type { GatewayModelConfig } from './llm.ts';
import type { RunMeta } from './runs.ts';
import type { StoryLabels } from './story.ts';

export interface Config {
  data: string;
  pollMs: number;
  broker: { host: string; port: number; url: string };
  tracker: TrackerConfig;
  forge: ForgeConfig;
  jobs: JobsConfig;
  git: GitConfig;
  job: string;
  labels: Labels;
  // Сверка требований: знание - документы цели в git, судья - модель через шлюз.
  knowledgeWeb: string;
  judge: GatewayModelConfig;
  notifier: NotifierConfig;
  // Бот фабрики в чате команды; уведомления сверщика - в канал productChannel.
  chat?: ChatConfig;
  productChannel: string;
  storyLabels: StoryLabels & { failed: string };
  // Выпуск: вики заметок, образы цели в GHCR, канал выпусков, управление выкладкой.
  wiki: WikiConfig;
  targetOwner: string;
  releaseImages: string[];
  releaseChannel: string;
  cdControl: string;
  // Сбор ошибок стенда (нет токена - сбои не опрашиваются) и канал эксплуатации.
  incidents?: IncidentsConfig;
  opsChannel: string;
  devChannel: string;
  gatewayLog: string; // журнал запросов шлюза (SQLite) - для учёта
  mcpPort: number;
  mcpToken(): string;
  // Переменные шага без ключей и с ключами.
  stepEnv: Record<string, string>;
  stepSecrets(): Record<string, string>;
  // Проверки на раннере: судья и сверка макета - Codex по подписке (другое семейство, чем
  // агент); e2e - по адресу стенда в сети шагов.
  judgeModel: string;
  codexAuth(): string;
  e2eBaseUrl: string;
  proxy: string;
  // Макеты Figma (нет figma.env - только картинки из чата) и макет по умолчанию.
  mockups?: MockupsConfig;
  figmaLink?: string;
}

// Переменные шага по виду задания: каждому - только свои ключи.
export function stepEnvFor(cfg: Config, m: RunMeta): Record<string, string> {
  const id = { TASK_ID: m.runId };
  if (m.kind === 'e2e') {
    const host = new URL(cfg.e2eBaseUrl).hostname;
    return {
      ...id,
      FACTORY_JOB: 'e2e',
      E2E_BASE_URL: cfg.e2eBaseUrl,
      HTTP_PROXY: cfg.proxy,
      HTTPS_PROXY: cfg.proxy,
      NO_PROXY: `${cfg.stepEnv.NO_PROXY},${host}`,
    };
  }
  if (m.kind === 'scan') {
    return { ...id, FACTORY_JOB: 'scan', HTTP_PROXY: cfg.proxy, HTTPS_PROXY: cfg.proxy, NO_PROXY: cfg.stepEnv.NO_PROXY ?? '' };
  }
  if (m.kind === 'judge' || m.kind === 'design') {
    return {
      ...cfg.stepEnv,
      ...id,
      FACTORY_JOB: m.kind,
      FACTORY_EXECUTOR: 'codex',
      FACTORY_MODEL: cfg.judgeModel,
      GATEWAY_KEY_SUB: cfg.stepSecrets().GATEWAY_KEY_SUB ?? '',
      CODEX_AUTH_JSON: cfg.codexAuth(),
    };
  }
  // Доработка: тест до кода сравнивает изменение всей ветки с общим предком (REWORK_BASE), а не с
  // прошлой попыткой - иначе тесты прошлой попытки "проходят на коде базы".
  // FACTORY_MOCKUP - в запуске есть принятый макет экрана: шаг берёт его у посредника.
  return {
    ...cfg.stepEnv,
    ...id,
    FACTORY_ROLE: m.role ?? 'dev',
    ...(m.rework?.base ? { REWORK_BASE: m.rework.base } : {}),
    ...(m.mockup ? { FACTORY_MOCKUP: '1' } : {}),
    ...cfg.stepSecrets(),
  };
}

// Файл вида ИМЯ=значение (как читает sh): комментарии и пустые строки пропускаются.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m?.[1]) continue;
    const v = m[2] ?? '';
    out[m[1]] = /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secrets = env.COORDINATOR_SECRETS ?? '/run/coordinator';
  const file = (name: string) => {
    const p = join(secrets, name);
    if (!existsSync(p)) throw new Error(`нет файла секретов ${name} в ${secrets}`);
    return readFileSync(p, 'utf8');
  };
  const envFile = (name: string) => parseEnvFile(file(name));
  const need = (vars: Record<string, string>, name: string, from: string) => {
    const v = vars[name];
    if (!v) throw new Error(`нет ${name} в ${from}`);
    return v;
  };
  const discord = existsSync(join(secrets, 'discord.env')) ? envFile('discord.env') : {};
  const figma = existsSync(join(secrets, 'figma.env')) ? envFile('figma.env') : {};
  // Учётка фабрики в Atlassian - своя (atlassian-factory.env, мастер scripts/persona-atlassian-add.sh
  // factory): комментарии сверщика, задачи нарезки и страницы выпуска идут от неё. Нет - учётка
  // из atlassian.env.
  const atl = envFile(existsSync(join(secrets, 'atlassian-factory.env')) ? 'atlassian-factory.env' : 'atlassian.env');
  const bb = envFile('bitbucket.env');
  const gh = envFile('github-target.env');
  const target = need(gh, 'GITHUB_TARGET_REPO', 'github-target.env');
  // Учётка фабрики в GitHub - её приложение (github-app-factory.env и .pem, мастер
  // scripts/persona-github-app-add.sh factory): PR, статусы, комментарии и ветки агента идут от
  // "<имя>[bot]". Приложения нет - токен человека GITHUB_PUBLISH_TOKEN, как раньше.
  const app = existsSync(join(secrets, 'github-app-factory.env')) ? envFile('github-app-factory.env') : undefined;
  const publish: string | (() => Promise<string>) = app
    ? appToken({
        appId: need(app, 'GITHUB_APP_ID', 'github-app-factory.env'),
        installation: need(app, 'GITHUB_APP_INSTALLATION', 'github-app-factory.env'),
        pem: file('github-app-factory.pem'),
      })
    : need(gh, 'GITHUB_PUBLISH_TOKEN', 'github-target.env');
  const [host = '0.0.0.0', port = '8080'] = (env.BROKER_LISTEN ?? '0.0.0.0:8080').split(':');
  const gateway = env.JOB_GATEWAY_URL ?? 'http://172.31.250.30:4000';
  const proxy = env.JOB_PROXY ?? 'http://172.31.250.10:3128';
  const brokerUrl = env.BROKER_URL ?? `http://${host}:${port}`;
  return {
    data: env.COORDINATOR_DATA ?? '/data',
    pollMs: Number(env.POLL_SECONDS ?? 20) * 1000,
    broker: { host, port: Number(port), url: brokerUrl },
    tracker: {
      kind: 'jira',
      site: need(atl, 'ATLASSIAN_SITE', 'atlassian.env'),
      email: need(atl, 'ATLASSIAN_EMAIL', 'atlassian.env'),
      token: need(atl, 'JIRA_API_TOKEN', 'atlassian.env'),
      project: need(atl, 'JIRA_PROJECT', 'atlassian.env'),
    },
    forge: { kind: 'github', repo: target, token: publish },
    jobs: {
      kind: 'bitbucket',
      workspace: need(bb, 'BITBUCKET_WORKSPACE', 'bitbucket.env'),
      repo: need(bb, 'BITBUCKET_REPO', 'bitbucket.env'),
      token: need(bb, 'BITBUCKET_TOKEN', 'bitbucket.env'),
    },
    git: {
      url: `https://github.com/${target}.git`,
      ...(gh.GITHUB_READ_TOKEN ? { read: { user: 'x-access-token', token: gh.GITHUB_READ_TOKEN } } : {}),
      write: { user: 'x-access-token', token: publish },
      author: { name: env.FACTORY_GIT_NAME ?? 'factory-agent', email: env.FACTORY_GIT_EMAIL ?? 'factory-agent@users.noreply.github.com' },
    },
    job: env.AGENT_JOB ?? 'agent-task',
    labels: {
      trigger: env.LABEL_TRIGGER ?? 'agent',
      running: env.LABEL_RUNNING ?? 'agent-running',
      review: env.LABEL_REVIEW ?? 'agent-review',
      failed: env.LABEL_FAILED ?? 'agent-failed',
      roles: { 'agent:frontend': 'frontend', 'agent:backend': 'backend' },
    },
    knowledgeWeb: `https://github.com/${target}`,
    judge: {
      url: env.JUDGE_GATEWAY_URL ?? 'http://gateway:4000',
      model: env.JUDGE_MODEL ?? 'kb-openrouter',
      key: () => file('gw-kb.key').trim(),
    },
    notifier: discord.DISCORD_DRAW_WEBHOOK_URL ? { kind: 'discord', webhook: discord.DISCORD_DRAW_WEBHOOK_URL } : { kind: 'none' },
    ...(discord.DISCORD_BOT_TOKEN && discord.DISCORD_GUILD_ID
      ? { chat: { kind: 'discord' as const, token: discord.DISCORD_BOT_TOKEN, guild: discord.DISCORD_GUILD_ID } }
      : {}),
    productChannel: env.PRODUCT_CHANNEL ?? 'продукт',
    storyLabels: {
      trigger: env.LABEL_STORY ?? 'story',
      checking: 'story-checking',
      ok: 'story-ok',
      conflict: 'needs-decision',
      decision: 'decision',
      failed: 'story-failed',
    },
    wiki: {
      kind: 'confluence',
      site: need(atl, 'ATLASSIAN_SITE', 'atlassian.env'),
      email: need(atl, 'ATLASSIAN_EMAIL', 'atlassian.env'),
      token: need(atl, 'CONFLUENCE_API_TOKEN', 'atlassian.env'),
      space: need(atl, 'CONFLUENCE_SPACE', 'atlassian.env'),
    },
    targetOwner: target.split('/')[0] ?? '',
    releaseImages: (env.RELEASE_IMAGES ?? 'prize-draw-api prize-draw-web').split(/\s+/).filter(Boolean),
    releaseChannel: env.RELEASE_CHANNEL ?? 'релизы',
    cdControl: env.CD_CONTROL ?? '/cd-control',
    ...(existsSync(join(secrets, 'glitchtip.token'))
      ? {
          incidents: {
            kind: 'glitchtip' as const,
            url: env.GLITCHTIP_URL ?? 'http://glitchtip:8000',
            publicUrl: env.GLITCHTIP_PUBLIC_URL ?? 'http://127.0.0.1:8200',
            org: env.GLITCHTIP_ORG ?? 'factory',
            project: env.GLITCHTIP_PROJECT ?? 'prize-draw',
            token: () => file('glitchtip.token').trim(),
          },
        }
      : {}),
    opsChannel: env.OPS_CHANNEL ?? 'эксплуатация',
    devChannel: env.DEV_CHANNEL ?? 'разработка',
    gatewayLog: env.GATEWAY_LOG ?? '/gateway-db/gateway.sqlite',
    mcpPort: Number(env.MCP_PORT ?? 8091),
    mcpToken: () => file('mcp.token').trim(),
    stepEnv: {
      FACTORY_ROLE: 'dev',
      FACTORY_EXECUTOR: env.AGENT_EXECUTOR ?? 'claude',
      FACTORY_MODEL: env.AGENT_MODEL ?? 'sonnet',
      GATEWAY_URL: gateway,
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      NO_PROXY: [new URL(gateway).hostname, new URL(brokerUrl).hostname].join(','),
    },
    ...(figma.FIGMA_TOKEN ? { mockups: { kind: 'figma' as const, token: figma.FIGMA_TOKEN } } : {}),
    ...(figma.FIGMA_FILE_KEY ? { figmaLink: figma.FIGMA_FILE_KEY.replace(/^"|"$/g, '') } : {}),
    judgeModel: env.JUDGE_CODEX_MODEL ?? 'default',
    // Вход Codex: обновлённый шагами (в данных координатора) или исходный из секретов.
    codexAuth: () => {
      const fresh = join(env.COORDINATOR_DATA ?? '/data', 'codex-auth.json');
      return (existsSync(fresh) ? readFileSync(fresh, 'utf8') : file('codex-auth.json')).trim();
    },
    e2eBaseUrl: env.E2E_BASE_URL ?? 'http://172.31.250.50:8082',
    proxy,
    stepSecrets: () => ({
      GATEWAY_KEY_SUB: file('gw-agent-sub.key').trim(),
      CLAUDE_CODE_OAUTH_TOKEN: file('claude-oauth.token').trim(),
    }),
  };
}
