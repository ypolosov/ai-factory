import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appJwt, appToken } from '../github-app.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('вход приложением GitHub', () => {
  it('JWT приложения подписан его ключом: издатель - номер приложения, срок - меньше 10 минут', () => {
    const jwt = appJwt('42', pem, 1_000_000);
    const [head = '', body = '', sig = ''] = jwt.split('.');
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: '42' });
    expect(createVerify('RSA-SHA256').update(`${head}.${body}`).verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
  });

  it('токен установки берётся раз и обновляется за 5 минут до конца срока', async () => {
    let now = Date.parse('2026-10-16T10:00:00Z');
    const calls: string[] = [];
    const token = appToken(
      { appId: '42', installation: '7', pem },
      {
        now: () => now,
        fetch: async (url, init) => {
          calls.push(`${init?.method} ${url} ${String((init?.headers as Record<string, string>).authorization).split('.')[0]}`);
          return new Response(JSON.stringify({ token: `t${calls.length}`, expires_at: new Date(now + 3_600_000).toISOString() }), {
            status: 201,
          });
        },
      },
    );
    expect(await token()).toBe('t1');
    now += 50 * 60_000;
    expect(await token()).toBe('t1');
    now += 6 * 60_000;
    expect(await token()).toBe('t2');
    expect(calls).toEqual([
      'POST https://api.github.com/app/installations/7/access_tokens Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9',
      'POST https://api.github.com/app/installations/7/access_tokens Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9',
    ]);
  });

  it('отказ GitHub - ошибка с кодом, без ключа в тексте', async () => {
    const token = appToken({ appId: '42', installation: '7', pem }, { fetch: async () => new Response('{}', { status: 401 }) });
    await expect(token()).rejects.toThrow('GitHub: токен приложения 42: 401');
  });
});
