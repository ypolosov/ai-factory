// Место сборки портов: по настройке выбирает адаптер носителя. Остальной код знает только
// контракты из ports.ts (правило ports-only-through-composition-root в .dependency-cruiser.cjs).
import { type BitbucketConfig, bitbucketJobs } from './bitbucket.ts';
import { type ForgejoConfig, forgejoForge, forgejoTracker } from './forgejo.ts';
import { type GithubConfig, githubForge } from './github.ts';
import { type JiraConfig, jiraTracker } from './jira.ts';
import type { Forge, JobRunner, Tracker } from './ports.ts';

export type TrackerConfig = ({ kind: 'jira' } & JiraConfig) | ({ kind: 'forgejo' } & ForgejoConfig);
export type ForgeConfig = ({ kind: 'github' } & GithubConfig) | ({ kind: 'forgejo' } & ForgejoConfig);
export type JobsConfig = { kind: 'bitbucket' } & BitbucketConfig;

export function selectTracker(c: TrackerConfig): Tracker {
  return c.kind === 'jira' ? jiraTracker(c) : forgejoTracker(c);
}

export function selectForge(c: ForgeConfig): Forge {
  return c.kind === 'github' ? githubForge(c) : forgejoForge(c);
}

export function selectJobs(c: JobsConfig): JobRunner {
  return bitbucketJobs(c);
}
