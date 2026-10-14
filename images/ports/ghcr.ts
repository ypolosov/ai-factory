// Адаптер реестра образов GitHub Container Registry: открытые образы читаются без ключа -
// анонимный токен на чтение и запрос манифеста.
import { PortError, type Registry } from './ports.ts';

export interface GhcrConfig {
  owner: string;
  host?: string; // по умолчанию ghcr.io
}

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export function ghcrRegistry(cfg: GhcrConfig): Registry {
  const host = cfg.host ?? 'ghcr.io';
  return {
    async exists(image, tag) {
      const repo = `${cfg.owner}/${image}`;
      try {
        const t = await fetch(`https://${host}/token?scope=repository:${repo}:pull`);
        if (!t.ok) return false;
        const { token } = (await t.json()) as { token: string };
        const r = await fetch(`https://${host}/v2/${repo}/manifests/${encodeURIComponent(tag)}`, {
          method: 'HEAD',
          headers: { authorization: `Bearer ${token}`, accept: ACCEPT },
        });
        return r.ok;
      } catch (e) {
        throw new PortError('unavailable', `${host} недоступен: ${(e as Error).message}`);
      }
    },
  };
}
