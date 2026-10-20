// Место сборки портов: по настройке выбирает адаптер носителя. Остальной код знает только
// контракты из ports.ts (правило ports-only-through-composition-root в .dependency-cruiser.cjs).
import { type BitbucketConfig, bitbucketJobs } from './bitbucket.ts';
import { type ConfluenceConfig, confluenceWiki } from './confluence.ts';
import { type DiscordBotConfig, type DiscordConfig, discordChat, discordNotifier } from './discord.ts';
import { type FigmaConfig, figmaMockups } from './figma.ts';
import { type ForgejoConfig, forgejoForge, forgejoTracker } from './forgejo.ts';
import { type GhcrConfig, ghcrRegistry } from './ghcr.ts';
import { type GitDocsConfig, gitDocsKnowledge } from './gitdocs.ts';
import { type GithubConfig, githubCi, githubForge } from './github.ts';
import { type GlitchtipConfig, glitchtipIncidents } from './glitchtip.ts';
import { type JiraConfig, jiraTracker } from './jira.ts';
import { type MiroConfig, miroDiagrams } from './miro.ts';
import { type PlantUmlConfig, plantumlDiagrams } from './plantuml.ts';
import type {
  Chat,
  Diagrams,
  Forge,
  Incidents,
  JobRunner,
  Knowledge,
  Mockups,
  Notifier,
  Registry,
  TargetCi,
  Tracker,
  Wiki,
} from './ports.ts';

export type TrackerConfig = ({ kind: 'jira' } & JiraConfig) | ({ kind: 'forgejo' } & ForgejoConfig);
export type ForgeConfig = ({ kind: 'github' } & GithubConfig) | ({ kind: 'forgejo' } & ForgejoConfig);
export type JobsConfig = { kind: 'bitbucket' } & BitbucketConfig;
export type KnowledgeConfig = { kind: 'gitdocs' } & GitDocsConfig;
export type NotifierConfig = ({ kind: 'discord' } & DiscordConfig) | { kind: 'none' };
export type ChatConfig = { kind: 'discord' } & DiscordBotConfig;
export type WikiConfig = { kind: 'confluence' } & ConfluenceConfig;
export type RegistryConfig = { kind: 'ghcr' } & GhcrConfig;
export type IncidentsConfig = { kind: 'glitchtip' } & GlitchtipConfig;
export type MockupsConfig = { kind: 'figma' } & FigmaConfig;
export type DiagramsConfig = ({ kind: 'plantuml' } & PlantUmlConfig) | ({ kind: 'miro' } & MiroConfig);

export function selectTracker(c: TrackerConfig): Tracker {
  return c.kind === 'jira' ? jiraTracker(c) : forgejoTracker(c);
}

export function selectForge(c: ForgeConfig): Forge {
  return c.kind === 'github' ? githubForge(c) : forgejoForge(c);
}

export function selectJobs(c: JobsConfig): JobRunner {
  return bitbucketJobs(c);
}

export function selectKnowledge(c: KnowledgeConfig): Knowledge {
  return gitDocsKnowledge(c);
}

export function selectNotifier(c: NotifierConfig): Notifier {
  return c.kind === 'discord' ? discordNotifier(c) : { post: async () => {} };
}

export function selectChat(c: ChatConfig): Chat {
  return discordChat(c);
}

export function selectWiki(c: WikiConfig): Wiki {
  return confluenceWiki(c);
}

export function selectRegistry(c: RegistryConfig): Registry {
  return ghcrRegistry(c);
}

export function selectIncidents(c: IncidentsConfig): Incidents {
  return glitchtipIncidents(c);
}

export function selectMockups(c: MockupsConfig): Mockups {
  return figmaMockups(c);
}

export function selectTargetCi(c: ForgeConfig): TargetCi | undefined {
  return c.kind === 'github' ? githubCi(c) : undefined;
}

export function selectDiagrams(c: DiagramsConfig): Diagrams {
  return c.kind === 'miro' ? miroDiagrams(c) : plantumlDiagrams(c);
}
