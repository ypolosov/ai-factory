// Кого слушает чат фабрики в Discord: себя - нет, людей и вебхуки - да,
// чужих ботов - только разрешённых (ИИ-персонажи с учёткой бота в реестре ролей).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discordChat, heard } from '../discord.ts';

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
});
