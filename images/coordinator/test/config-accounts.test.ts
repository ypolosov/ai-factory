import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, stepEnvFor } from '../config.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function secrets(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'coord-'));
  dirs.push(d);
  const base: Record<string, string> = {
    'atlassian.env':
      'ATLASSIAN_SITE=https://x.atlassian.net\nATLASSIAN_EMAIL=f@x\nJIRA_API_TOKEN=j\nJIRA_PROJECT=DRAW\nCONFLUENCE_API_TOKEN=c\nCONFLUENCE_SPACE=DRAW\n',
    'bitbucket.env': 'BITBUCKET_WORKSPACE=w\nBITBUCKET_REPO=r\nBITBUCKET_TOKEN=b\n',
  };
  for (const [name, text] of Object.entries({ ...base, ...files })) writeFileSync(join(d, name), text);
  return d;
}

describe('учётка фабрики в Atlassian', () => {
  it('есть atlassian-factory.env - фабрика ходит в Jira и Confluence своей учёткой, а не учёткой человека', () => {
    const own =
      'ATLASSIAN_SITE=https://x.atlassian.net\nATLASSIAN_EMAIL=factory@x\nJIRA_API_TOKEN=fj\nJIRA_PROJECT=DRAW\nCONFLUENCE_API_TOKEN=fc\nCONFLUENCE_SPACE=DRAW\n';
    const cfg = loadConfig({
      COORDINATOR_SECRETS: secrets({
        'github-target.env': 'GITHUB_TARGET_REPO=o/p\nGITHUB_PUBLISH_TOKEN=h\n',
        'atlassian-factory.env': own,
      }),
    });
    expect(cfg.tracker).toMatchObject({ email: 'factory@x', token: 'fj' });
  });
});

describe('учётка фабрики в GitHub', () => {
  it('есть приложение фабрики - PR, статусы и git идут его токеном, а не токеном человека', () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const cfg = loadConfig({
      COORDINATOR_SECRETS: secrets({
        'github-target.env': 'GITHUB_TARGET_REPO=o/prize-draw\nGITHUB_READ_TOKEN=r\nGITHUB_PUBLISH_TOKEN=human\n',
        'github-app-factory.env': 'GITHUB_APP_ID=5\nGITHUB_APP_SLUG=ai-factory-bot\nGITHUB_APP_INSTALLATION=9\n',
        'github-app-factory.pem': pem,
      }),
    });
    expect(cfg.forge.kind).toBe('github');
    expect(typeof cfg.forge.token).toBe('function');
    expect(typeof cfg.git.write?.token).toBe('function');
  });

  it('приложения нет - токен публикации из github-target.env, как раньше', () => {
    const cfg = loadConfig({
      COORDINATOR_SECRETS: secrets({ 'github-target.env': 'GITHUB_TARGET_REPO=o/prize-draw\nGITHUB_PUBLISH_TOKEN=human\n' }),
    });
    expect(cfg.forge.token).toBe('human');
    expect(cfg.git.write?.token).toBe('human');
  });
});

describe('переменные шага агента', () => {
  it('в запуске есть принятый макет экрана - шаг берёт его у посредника (FACTORY_MOCKUP), нет - переменной нет', () => {
    const cfg = loadConfig({
      COORDINATOR_SECRETS: secrets({
        'github-target.env': 'GITHUB_TARGET_REPO=o/prize-draw\nGITHUB_PUBLISH_TOKEN=human\n',
        'gw-agent-sub.key': 'k\n',
        'claude-oauth.token': 't\n',
      }),
    });
    const m = { runId: 'DRAW-1-x', issue: 'DRAW-1', tokenHash: '', createdAt: '', envServed: false, done: false, role: 'frontend' };
    expect(stepEnvFor(cfg, { ...m, mockup: true })).toMatchObject({ FACTORY_ROLE: 'frontend', FACTORY_MOCKUP: '1' });
    expect(stepEnvFor(cfg, m)).not.toHaveProperty('FACTORY_MOCKUP');
  });
});
