// Вход приложением GitHub (GitHub App): фабрика и персонажи действуют в репозитории цели под
// своим именем ("<имя>[bot]"), а не учёткой человека. Ключ приложения подписывает JWT, JWT
// меняется на токен установки (живёт час); токен берётся заново за 5 минут до конца срока.
import { createSign } from 'node:crypto';

export interface GithubAppConfig {
  appId: string;
  installation: string;
  pem: string; // закрытый ключ приложения
  api?: string; // по умолчанию https://api.github.com
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

// JWT приложения: издатель - номер приложения, выдан минутой раньше (часы GitHub), живёт 9 минут.
export function appJwt(appId: string, pem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const body = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }))}`;
  return `${body}.${b64url(createSign('RSA-SHA256').update(body).sign(pem))}`;
}

export function appToken(cfg: GithubAppConfig, io: { fetch?: typeof fetch; now?: () => number } = {}): () => Promise<string> {
  const get = io.fetch ?? fetch;
  const now = io.now ?? Date.now;
  let cached: { value: string; until: number } | undefined;
  return async () => {
    if (cached && cached.until - now() > 300_000) return cached.value;
    const url = `${(cfg.api ?? 'https://api.github.com').replace(/\/$/, '')}/app/installations/${cfg.installation}/access_tokens`;
    const r = await get(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${appJwt(cfg.appId, cfg.pem, Math.floor(now() / 1000))}`, accept: 'application/vnd.github+json' },
    });
    if (!r.ok) throw new Error(`GitHub: токен приложения ${cfg.appId}: ${r.status}`);
    const t = (await r.json()) as { token: string; expires_at: string };
    cached = { value: t.token, until: Date.parse(t.expires_at) };
    return cached.value;
  };
}
