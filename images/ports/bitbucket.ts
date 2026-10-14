// Адаптер Bitbucket Pipelines для порта исполнителя заданий (REST API 2.0). Задание - custom
// pipeline из bitbucket-pipelines.yml репозитория фабрики; токен - токен доступа репозитория
// с областями pipeline и pipeline:variable.
import { type Job, type JobRunner, type JobState, PortError } from './ports.ts';

export interface BitbucketConfig {
  workspace: string;
  repo: string;
  token: string;
  ref?: string; // ветка с bitbucket-pipelines.yml, по умолчанию main
  api?: string; // по умолчанию https://api.bitbucket.org/2.0
}

type Json = Record<string, unknown>;

const jobState = (s: Json | undefined): JobState => {
  const name = s?.name;
  // PARSING - чтение bitbucket-pipelines.yml до постановки в очередь.
  if (name === 'PENDING' || name === 'PARSING') return 'pending';
  if (name !== 'COMPLETED') return 'running';
  const result = (s?.result as Json | undefined)?.name;
  return result === 'SUCCESSFUL' ? 'success' : result === 'STOPPED' ? 'stopped' : 'failed';
};

export function bitbucketJobs(cfg: BitbucketConfig): JobRunner {
  const base = `${(cfg.api ?? 'https://api.bitbucket.org/2.0').replace(/\/$/, '')}/repositories/${cfg.workspace}/${cfg.repo}`;
  async function call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PortError('unavailable', `Bitbucket недоступен: ${(e as Error).message}`);
    }
    if (r.ok) return (r.status === 204 ? undefined : await r.json()) as T;
    const text = (await r.text()).slice(0, 300);
    const code =
      r.status === 404
        ? 'not_found'
        : r.status === 401 || r.status === 403
          ? 'auth'
          : r.status === 409
            ? 'conflict'
            : r.status === 400
              ? 'invalid'
              : 'unavailable';
    throw new PortError(code, `${method} ${path}: ${r.status} ${text}`);
  }
  const toJob = (p: Json): Job => ({
    id: String(p.uuid),
    state: jobState(p.state as Json | undefined),
    url: `https://bitbucket.org/${cfg.workspace}/${cfg.repo}/pipelines/results/${p.build_number}`,
  });
  const vars = (v: Record<string, string>, secured: boolean) => Object.entries(v).map(([key, value]) => ({ key, value, secured }));
  return {
    async start({ job, variables = {}, secrets = {} }) {
      return toJob(
        await call('POST', '/pipelines/', {
          target: {
            type: 'pipeline_ref_target',
            ref_type: 'branch',
            ref_name: cfg.ref ?? 'main',
            selector: { type: 'custom', pattern: job },
          },
          variables: [...vars(variables, false), ...vars(secrets, true)],
        }),
      );
    },
    async get(id) {
      return toJob(await call('GET', `/pipelines/${encodeURIComponent(id)}`));
    },
    async stop(id) {
      await call('POST', `/pipelines/${encodeURIComponent(id)}/stopPipeline`);
    },
  };
}
