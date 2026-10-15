// Кого слушает чат фабрики в Discord: себя - нет, людей и вебхуки - да,
// чужих ботов - только разрешённых (ИИ-персонажи с учёткой бота в реестре ролей).
import { describe, expect, it } from 'vitest';
import { heard } from '../discord.ts';

const ME = 'factory';

describe('кого слышит бот фабрики', () => {
  it('свои сообщения - мимо', async () => {
    expect(await heard({ id: ME, bot: true }, false, ME)).toBe(false);
  });

  it('человек и вебхук слышны: права проверит реестр ролей', async () => {
    expect(await heard({ id: 'u-anna' }, false, ME)).toBe(true);
    expect(await heard({ id: 'w-1', bot: true }, true, ME)).toBe(true);
  });

  it('чужой бот без разрешения - мимо', async () => {
    expect(await heard({ id: 'b-other', bot: true }, false, ME)).toBe(false);
    expect(await heard({ id: 'b-other', bot: true }, false, ME, async () => false)).toBe(false);
  });

  it('разрешённый бот слышен, решает список разрешённых', async () => {
    const allowed = new Set(['b-pm']);
    const allow = async (id: string) => allowed.has(id);
    expect(await heard({ id: 'b-pm', bot: true }, false, ME, allow)).toBe(true);
    expect(await heard({ id: 'b-other', bot: true }, false, ME, allow)).toBe(false);
  });

  it('сбой проверки разрешения - бот не слышен', async () => {
    const broken = async () => {
      throw new Error('реестр недоступен');
    };
    expect(await heard({ id: 'b-pm', bot: true }, false, ME, broken)).toBe(false);
  });
});
