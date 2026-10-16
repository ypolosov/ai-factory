// Адаптер сбора ошибок GlitchTip (API, совместимый с Sentry): открытые ошибки проекта и их
// закрытие. Токен - с областями project:read, event:read, event:write.
import { type Incident, type Incidents, PortError } from './ports.ts';

export interface GlitchtipConfig {
  url: string; // внутренний адрес API
  publicUrl: string; // адрес для людей - в ссылках
  org: string;
  project: string;
  token(): string;
}

type Json = Record<string, unknown>;

export function glitchtipIncidents(cfg: GlitchtipConfig): Incidents {
  const base = cfg.url.replace(/\/$/, '');
  async function call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${cfg.token()}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PortError('unavailable', `GlitchTip недоступен: ${(e as Error).message}`);
    }
    if (!r.ok)
      throw new PortError(
        r.status === 404 ? 'not_found' : r.status === 401 || r.status === 403 ? 'auth' : 'unavailable',
        `GlitchTip ${method} ${path}: ${r.status}`,
      );
    return (r.status === 204 ? undefined : await r.json()) as T;
  }
  const project = `/api/0/projects/${cfg.org}/${cfg.project}/issues/`;
  return {
    async open() {
      const list = await call<Json[]>('GET', `${project}?query=${encodeURIComponent('is:unresolved')}`);
      return list.map(
        (i): Incident => ({
          id: String(i.id),
          title: String(i.title ?? ''),
          culprit: String(i.culprit ?? ''),
          count: Number(i.count ?? 0),
          lastSeen: String(i.lastSeen ?? ''),
          url: `${cfg.publicUrl.replace(/\/$/, '')}/${cfg.org}/issues/${i.id}`,
        }),
      );
    },
    // Закрытие - через список задач организации: PUT на список проекта GlitchTip отвечает 405.
    async resolve(id) {
      await call('PUT', `/api/0/organizations/${cfg.org}/issues/?id=${encodeURIComponent(id)}`, { status: 'resolved' });
    },
  };
}
