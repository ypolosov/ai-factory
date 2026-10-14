// Место сборки портов: по настройке выбирает адаптер носителя. Остальной код знает только
// контракты из ports.ts (правило ports-only-through-composition-root в .dependency-cruiser.cjs).
import { type BitbucketConfig, bitbucketJobs } from './bitbucket.ts';
import { type ConfluenceConfig, confluenceWiki } from './confluence.ts';
import { type DiscordBotConfig, type DiscordConfig, discordChat, discordNotifier } from './discord.ts';
import { type ForgejoConfig, forgejoForge, forgejoTracker } from './forgejo.ts';
import { type GhcrConfig, ghcrRegistry } from './ghcr.ts';
import { type GitDocsConfig, gitDocsKnowledge } from './gitdocs.ts';
import { type GithubConfig, githubForge } from './github.ts';
import { type JiraConfig, jiraTracker } from './jira.ts';
import type { Chat, Forge, JobRunner, Knowledge, Notifier, Registry, Tracker, Wiki } from './ports.ts';

export type TrackerConfig = ({ kind: 'jira' } & JiraConfig) | ({ kind: 'forgejo' } & ForgejoConfig);
export type ForgeConfig = ({ kind: 'github' } & GithubConfig) | ({ kind: 'forgejo' } & ForgejoConfig);
export type JobsConfig = { kind: 'bitbucket' } & BitbucketConfig;
export type KnowledgeConfig = { kind: 'gitdocs' } & GitDocsConfig;
export type NotifierConfig = ({ kind: 'discord' } & DiscordConfig) | { kind: 'none' };
export type ChatConfig = { kind: 'discord' } & DiscordBotConfig;
export type WikiConfig = { kind: 'confluence' } & ConfluenceConfig;
export type RegistryConfig = { kind: 'ghcr' } & GhcrConfig;

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
