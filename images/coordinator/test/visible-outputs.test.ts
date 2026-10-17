// Видимые выходы фабрики (docs/demo/visible-outputs.md): на них опираются другие системы, прежде
// всего съёмка видео-демо (ai-factory-film, src/contract.ts). Тест падает раньше, чем дубль: поменял
// выход - поправь перечень, этот тест и потребителей в том же выпуске.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PortError } from '../../ports/ports.ts';
import { KNOWLEDGE_DOCS } from '../../ports/test/contract.ts';
import { memoryChat, memoryForge, memoryKnowledge, memoryTracker } from '../../ports/test/memory.ts';
import { VERDICT_KEY } from '../actions.ts';
import { type BotDeps, chatBot, failure } from '../bot.ts';
import { JUDGE_KEY } from '../pr-judge.ts';
import { refusal } from '../roles.ts';
import { SCAN_KEY } from '../scan.ts';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('видимые выходы фабрики', () => {
  it('ответ на команду - ответом на её сообщение', async () => {
    const c = memoryChat();
    const d: BotDeps = {
      chat: c.chat,
      tracker: memoryTracker(),
      forge: memoryForge().forge,
      knowledge: memoryKnowledge(KNOWLEDGE_DOCS),
      refreshKnowledge: async () => {},
      librarian: { answer: async () => 'ответ' },
      agentLabel: 'agent',
      log: () => {},
    };
    chatBot(d);
    await c.say('продукт', '!дейли');
    expect(c.sent[0]?.replyTo).toBe('m-1');
    expect(c.sent[0]?.text).toMatch(/^Дейли фабрики:/);
  });

  it('сбой команды, просьба повторить и отказ в праве - своими началами ответа', () => {
    expect(failure(new PortError('not_found', 'x'))).toMatch(/^Не нашлось:/);
    expect(failure(new PortError('auth', 'x'))).toMatch(/^Фабрике не хватает доступа/);
    expect(failure(new PortError('unavailable', 'x'))).toMatch(/повторите команду/);
    expect(failure(new Error('таймаут'))).toBe('Не вышло: таймаут');
    expect(refusal('deploy', { ok: false, roles: [], need: ['devops'] }, true)).toMatch(/^Нельзя подтвердить выкладку: /);
  });

  it('ключи статусов коммитов', () => {
    expect([VERDICT_KEY, JUDGE_KEY, SCAN_KEY]).toEqual(['factory/verdict', 'factory/judge', 'factory/scan']);
    expect(source('delivery.ts')).toContain("'factory/deploy'");
  });

  it('метки задач по умолчанию', () => {
    const config = source('config.ts');
    for (const l of [
      'agent',
      'agent-running',
      'agent-review',
      'agent-failed',
      'agent:frontend',
      'agent:backend',
      'story',
      'story-ok',
      'needs-decision',
      'decision',
    ])
      expect(config, l).toContain(`'${l}'`);
    expect(source('design.ts')).toMatch(/design-ok/);
    expect(source('design.ts')).toMatch(/design-changes/);
    expect(source('incidents.ts')).toMatch(/'incident'/);
    expect(source('release.ts')).toMatch(/release-\$\{/);
  });

  it('начала успешных ответов на команды и объявления с идентификатором объекта', () => {
    const outputs: [string, RegExp][] = [
      ['templates.ts', /'Источники:'/],
      ['slice.ts', /`Сверщик предлагает нарезку \$\{story\}/],
      ['slice.ts', /`Задачи заведены: /],
      ['rule-candidates.ts', /`Правило-кандидат предложено: /],
      ['release.ts', /`## \$\{name\}: изменения с /],
      ['release.ts', /'следующий выпуск'/],
      ['release-loop.ts', /`Выкладка \$\{tag\} подтверждена /],
      ['accounting.ts', /`Учёт фабрики: /],
      ['ci-rerun.ts', /`Перезапустил CI \$\{what\} /],
      ['ci-rerun.ts', /`CI \$\{p\.what\}: /],
      ['ci-rerun.ts', /what = `PR \$\{pr\}`/],
      ['stand-e2e.ts', /`Запустил e2e на стенде /],
      ['stand-e2e.ts', /`e2e на стенде \(\$\{sha\.slice\(0, 7\)\}\)/],
      ['release.ts', /`Собран тег \$\{tag\}/],
      ['release.ts', /`Выпуск \$\{n\.tag\} на стенде/],
    ];
    for (const [file, pattern] of outputs) expect(source(file), `${file}: ${pattern}`).toMatch(pattern);
  });
});
