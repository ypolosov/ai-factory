// Адаптеры Discord: канал команды на вебхуке и чат на боте (Gateway API v10 по WebSocket -
// соединение исходящее, входящих к стенду нет; ответы - REST). Боту нужен Message Content Intent.
import { type Chat, type ChatMessage, type Notifier, PortError } from './ports.ts';

export interface DiscordConfig {
  webhook: string;
}

export function discordNotifier(cfg: DiscordConfig): Notifier {
  return {
    async post(text) {
      let r: Response;
      try {
        r = await fetch(cfg.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: [] } }),
        });
      } catch (e) {
        throw new PortError('unavailable', `Discord недоступен: ${(e as Error).message}`);
      }
      if (!r.ok) throw new PortError(r.status === 401 || r.status === 403 ? 'auth' : 'unavailable', `Discord: ${r.status}`);
    },
  };
}

export interface DiscordBotConfig {
  token: string;
  guild: string;
  log?(message: string): void;
}

type Json = Record<string, unknown>;

const API = 'https://discord.com/api/v10';
// GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

// Discord режет сообщение на 2000 символов: длинный ответ уходит частями по строкам.
export function chunks(text: string, size = 1900): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > size) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line.slice(0, size);
  }
  if (cur) out.push(cur);
  return out;
}

export function discordChat(cfg: DiscordBotConfig): Chat {
  const headers = { authorization: `Bot ${cfg.token}`, 'content-type': 'application/json' };
  let names = new Map<string, string>(); // id -> имя канала
  async function call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new PortError('unavailable', `Discord недоступен: ${(e as Error).message}`);
    }
    if (!r.ok)
      throw new PortError(
        r.status === 404 ? 'not_found' : r.status === 401 || r.status === 403 ? 'auth' : 'unavailable',
        `Discord ${method} ${path}: ${r.status}`,
      );
    return (await r.json()) as T;
  }
  async function channels(refresh = false) {
    if (refresh || !names.size) {
      const list = await call<Json[]>('GET', `/guilds/${cfg.guild}/channels`);
      names = new Map(list.map((c) => [String(c.id), String(c.name)]));
    }
    return names;
  }
  async function channelId(name: string) {
    const find = (m: Map<string, string>) => [...m].find(([, n]) => n === name)?.[0];
    const id = find(await channels()) ?? find(await channels(true));
    if (!id) throw new PortError('not_found', `нет канала ${name}`);
    return id;
  }
  async function send(channel: string, text: string, replyTo?: string) {
    for (const [i, part] of chunks(text).entries()) {
      await call('POST', `/channels/${channel}/messages`, {
        content: part,
        allowed_mentions: { parse: [] },
        ...(replyTo && i === 0 ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
      });
    }
  }
  const ids = new Map<string, string>(); // id сообщения -> id канала, для ответов
  return {
    listen(onMessage) {
      let closed = false;
      let ws: WebSocket | undefined;
      let beat: ReturnType<typeof setInterval> | undefined;
      let me = '';
      const connect = async () => {
        const { url } = await call<{ url: string }>('GET', '/gateway/bot');
        let seq: number | null = null;
        ws = new WebSocket(`${url}/?v=10&encoding=json`);
        const sock = ws;
        sock.onmessage = (ev) => {
          const p = JSON.parse(String(ev.data)) as { op: number; s?: number | null; t?: string; d?: Json };
          if (p.s != null) seq = p.s;
          if (p.op === 10) {
            const every = Number(p.d?.heartbeat_interval ?? 41250);
            beat = setInterval(() => sock.send(JSON.stringify({ op: 1, d: seq })), every);
            sock.send(
              JSON.stringify({
                op: 2,
                d: { token: cfg.token, intents: INTENTS, properties: { os: 'linux', browser: 'ai-factory', device: 'ai-factory' } },
              }),
            );
          } else if (p.op === 1) sock.send(JSON.stringify({ op: 1, d: seq }));
          else if (p.op === 7 || p.op === 9) sock.close();
          else if (p.op === 0 && p.t === 'READY') {
            me = String((p.d?.user as Json | undefined)?.id ?? '');
            cfg.log?.('бот Discord на связи');
          } else if (p.op === 0 && p.t === 'MESSAGE_CREATE' && p.d) {
            const d = p.d;
            const author = (d.author as Json | undefined) ?? {};
            // Свои сообщения и чужие боты - мимо; вебхуки (объявления, проверки) - читаются.
            if (String(author.id) === me || (author.bot && !d.webhook_id)) return;
            const mentions = ((d.mentions as Json[] | undefined) ?? []).map((u) => String(u.id));
            void (async () => {
              const ch =
                (await channels()).get(String(d.channel_id)) ?? (await channels(true)).get(String(d.channel_id)) ?? String(d.channel_id);
              ids.set(String(d.id), String(d.channel_id));
              const attachments = ((d.attachments as Json[] | undefined) ?? []).map((a) => ({
                url: String(a.url),
                name: String(a.filename ?? ''),
                ...(a.content_type ? { contentType: String(a.content_type) } : {}),
              }));
              await onMessage({
                id: String(d.id),
                channel: ch,
                text: String(d.content ?? ''),
                author: String(author.username ?? ''),
                mentionsMe: mentions.includes(me),
                ...(attachments.length ? { attachments } : {}),
              });
            })().catch((e) => cfg.log?.(`сообщение Discord: ${(e as Error).message}`));
          }
        };
        sock.onclose = () => {
          if (beat) clearInterval(beat);
          if (!closed) setTimeout(() => void connect().catch((e) => cfg.log?.(`Discord: ${(e as Error).message}`)), 5000);
        };
      };
      void connect().catch((e) => cfg.log?.(`Discord: ${(e as Error).message}`));
      return {
        close() {
          closed = true;
          if (beat) clearInterval(beat);
          ws?.close();
        },
      };
    },
    async reply(to, text) {
      const channel = ids.get(to.id) ?? (await channelId(to.channel));
      await send(channel, text, to.id);
    },
    async post(channel, text) {
      await send(await channelId(channel), text);
    },
  };
}
