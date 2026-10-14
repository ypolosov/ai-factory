// Сбор ошибок приложения на стенде. Служба выкладки подключает этот файл к каждому
// приложению (node --import) - коду приложения SDK не нужен. Необработанное исключение
// уходит в GlitchTip по протоколу Sentry (store API), затем процесс завершается с кодом 1,
// как и без перехватчика.
// Окружение: SENTRY_DSN (нет - сбор выключен), SENTRY_RELEASE (коммит), SENTRY_ENVIRONMENT.
import { randomUUID } from 'node:crypto';

export interface Dsn {
  storeUrl: string;
  publicKey: string;
}

export interface Frame {
  filename: string;
  function: string;
  lineno: number;
  colno: number;
  in_app: boolean;
}

export interface EventOptions {
  release?: string | undefined;
  environment?: string | undefined;
  now?: Date;
  eventId?: string;
}

// DSN вида http://КЛЮЧ@ХОСТ[/ПРЕФИКС]/ПРОЕКТ -> адрес store API и открытый ключ.
export function parseDsn(dsn: string): Dsn | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const project = parts.pop();
  if (!url.username || !project || !/^\d+$/.test(project)) return null;
  const prefix = parts.length > 0 ? `/${parts.join('/')}` : '';
  return { storeUrl: `${url.protocol}//${url.host}${prefix}/api/${project}/store/`, publicKey: url.username };
}

// Стек V8 -> кадры Sentry: самый внешний вызов первым, место ошибки последним.
export function parseStack(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of stack.split('\n')) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    const filename = m[2]!;
    frames.push({
      filename,
      function: m[1] ?? '?',
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !filename.startsWith('node:') && !filename.includes('/node_modules/'),
    });
  }
  return frames.reverse();
}

export function buildEvent(error: unknown, options: EventOptions = {}): Record<string, unknown> {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    event_id: options.eventId ?? randomUUID().replaceAll('-', ''),
    timestamp: (options.now ?? new Date()).toISOString(),
    platform: 'node',
    level: 'fatal',
    logger: 'factory-errors',
    release: options.release || undefined,
    environment: options.environment || 'stand',
    exception: {
      values: [
        {
          type: err.name,
          value: err.message,
          stacktrace: { frames: parseStack(err.stack ?? '') },
          mechanism: { type: 'onuncaughtexception', handled: false },
        },
      ],
    },
  };
}

export async function send(dsn: Dsn, event: Record<string, unknown>, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(dsn.storeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_client=factory-errors/1.0, sentry_key=${dsn.publicKey}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Перехватчик необработанных исключений; без SENTRY_DSN ничего не меняет.
export function install(env: NodeJS.ProcessEnv = process.env): boolean {
  const dsn = env.SENTRY_DSN ? parseDsn(env.SENTRY_DSN) : null;
  if (!dsn) return false;
  let crashing = false;
  process.on('uncaughtException', (error) => {
    console.error(error);
    if (crashing) return;
    crashing = true;
    const event = buildEvent(error, { release: env.SENTRY_RELEASE, environment: env.SENTRY_ENVIRONMENT });
    void send(dsn, event).finally(() => process.exit(1));
  });
  return true;
}

install();
