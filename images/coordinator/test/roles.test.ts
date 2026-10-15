import { describe, expect, it } from 'vitest';
import { parseRoles, refusal } from '../roles.ts';

const YAML = `
holders:
  anna: { kind: human-ai, name: Аня, accounts: { discord: "111", jira: acc-anna } }
  gleb: { kind: human, name: Глеб, accounts: { discord: ["222", "223"], jira: acc-gleb } }
  qa-bot: { kind: ai, name: ИИ-QA, accounts: { discord: "999" } }
roles:
  product-owner: [anna]
  devops: [gleb]
  qa: [qa-bot]
decisions:
  deploy: [devops]
  submit-task: [product-owner, devops]
  rerun-checks: [qa, devops]
`;

describe('реестр ролей', () => {
  it('учётка -> держатель -> роли -> право на решение', () => {
    const r = parseRoles(YAML);
    expect(r.check('deploy', 'discord', '223')).toEqual(expect.objectContaining({ ok: true, roles: ['devops'], need: ['devops'] }));
    const anna = r.check('deploy', 'discord', '111');
    expect(anna.ok).toBe(false);
    expect(refusal('deploy', anna)).toBe(
      'Нельзя подтвердить выкладку: это решение ролей devops, а здесь Аня (роли: product-owner). Реестр ролей - .factory/roles.yml цели.',
    );
    expect(r.check('submit-task', 'jira', 'acc-anna').ok).toBe(true);
    expect(r.check('rerun-checks', 'discord', '999').ok).toBe(true);
    expect(r.holder('discord', '999')?.kind).toBe('ai');
  });

  it('чужая учётка, вебхук и решение без ролей - отказ', () => {
    const r = parseRoles(YAML);
    expect(r.check('deploy', 'discord', 'x').ok).toBe(false);
    expect(refusal('deploy', r.check('deploy', 'discord', 'w'), true)).toContain('сообщение вебхука без учётки');
    expect(r.check('propose-rule', 'discord', '111')).toEqual(expect.objectContaining({ ok: false, need: [] }));
    expect(r.check('deploy', 'discord', undefined).ok).toBe(false);
  });

  it('нет реестра - открытый режим, как до реестра', () => {
    const r = parseRoles(undefined);
    expect(r.open).toBe(true);
    expect(r.check('deploy', 'discord', 'кто угодно').ok).toBe(true);
  });
});
