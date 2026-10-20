// Кого слушает чат фабрики в Discord: себя - нет, людей и вебхуки - да,
// чужих ботов - только разрешённых (ИИ-персонажи с учёткой бота в реестре ролей).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { botRole, discordChat, heard, mentionsBot } from '../discord.ts';
import type { ChatMessage } from '../ports.ts';

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

describe('обращение к боту фабрики', () => {
  it('упоминание учётки бота - обращение, как раньше', () => {
    expect(mentionsBot([ME], [], ME)).toBe(true);
    expect(mentionsBot(['u-anna'], [], ME)).toBe(false);
    expect(mentionsBot([], [], ME, 'r-factory')).toBe(false);
  });

  it('упоминание служебной роли бота - обращение', () => {
    expect(mentionsBot([], ['r-factory'], ME, 'r-factory')).toBe(true);
  });

  it('чужая роль или роль бота неизвестна - не обращение', () => {
    expect(mentionsBot([], ['r-designers'], ME, 'r-factory')).toBe(false);
    expect(mentionsBot([], ['r-factory'], ME)).toBe(false);
  });

  it('служебная роль бота - та, у которой tags.bot_id равен id бота', () => {
    const roles = [{ id: 'r-everyone' }, { id: 'r-pm', tags: { bot_id: 'b-pm' } }, { id: 'r-factory', tags: { bot_id: ME } }];
    expect(botRole(roles, ME)).toBe('r-factory');
    expect(botRole(roles, 'b-other')).toBeUndefined();
    expect(botRole(roles, '')).toBeUndefined();
  });
});

// Поддельный сокет шлюза: сколько подключений сделано и закрыто ли старое.
class FakeWs {
  static made: FakeWs[] = [];
  onmessage?: (ev: { data: string }) => void;
  onclose?: () => void;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.made.push(this);
  }
  send(_: string) {}
  close() {
    this.closed = true;
  }
  hello(ms: number) {
    this.onmessage?.({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: ms } }) });
  }
  event(t: string, d: unknown) {
    this.onmessage?.({ data: JSON.stringify({ op: 0, s: 1, t, d }) });
  }
}

describe('связь бота фабрики со шлюзом Discord', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWs.made = [];
  });

  it('сбой подключения - повтор; нет ответа на пульс - новое подключение', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls === 1) throw new Error('fetch failed');
      return new Response(JSON.stringify({ url: 'wss://gw' }), { status: 200 });
    });
    vi.stubGlobal('WebSocket', FakeWs);
    const logs: string[] = [];
    const h = discordChat({ token: 't', guild: 'g', log: (m) => logs.push(m) }).listen(async () => {});
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeWs.made).toHaveLength(0); // сеть упала - подключения нет
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWs.made).toHaveLength(1); // повтор удался
    FakeWs.made[0]?.hello(100);
    await vi.advanceTimersByTimeAsync(200); // пульс ушёл, ответа нет
    expect(FakeWs.made[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWs.made).toHaveLength(2); // новое подключение
    expect(logs.some((l) => l.includes('нет ответа на пульс'))).toBe(true);
    h.close();
  });

  it('упоминание служебной роли бота - обращение; роли сервера запрашиваются один раз', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url).pathname.replace('/api/v10', '');
      asked.push(path);
      const body =
        path === '/gateway/bot'
          ? { url: 'wss://gw' }
          : path === '/guilds/g/roles'
            ? [{ id: 'r-everyone' }, { id: 'r-designers' }, { id: 'r-factory', tags: { bot_id: ME } }]
            : [{ id: 'c-1', name: 'продукт' }];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('WebSocket', FakeWs);
    const got = new Map<string, ChatMessage>();
    const h = discordChat({ token: 't', guild: 'g' }).listen(async (m) => {
      got.set(m.id, m);
    });
    await vi.waitFor(() => expect(FakeWs.made).toHaveLength(1));
    const ws = FakeWs.made[0] as FakeWs;
    ws.event('READY', { user: { id: ME } });
    const say = (id: string, mentions: string[], roles: string[]) =>
      ws.event('MESSAGE_CREATE', {
        id,
        guild_id: 'g',
        channel_id: 'c-1',
        content: 'что ты знаешь?',
        author: { id: 'u-anna', username: 'anna' },
        mentions: mentions.map((u) => ({ id: u })),
        mention_roles: roles,
      });
    say('m-role', [], ['r-factory']);
    await vi.waitFor(() => expect(got.get('m-role')?.mentionsMe).toBe(true));
    say('m-other-role', [], ['r-designers']);
    say('m-user', [ME], []);
    say('m-none', [], []);
    await vi.waitFor(() => expect(got.size).toBe(4));
    expect(got.get('m-other-role')?.mentionsMe).toBe(false);
    expect(got.get('m-user')?.mentionsMe).toBe(true);
    expect(got.get('m-none')?.mentionsMe).toBe(false);
    expect(asked.filter((p) => p === '/guilds/g/roles')).toHaveLength(1);
    h.close();
  });
});
