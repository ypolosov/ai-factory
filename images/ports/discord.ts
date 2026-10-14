// Адаптер канала команды на вебхуке Discord: сообщение в канал вебхука без упоминаний.
import { type Notifier, PortError } from './ports.ts';

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
