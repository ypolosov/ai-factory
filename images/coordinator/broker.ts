// Посредник шага задания: шаг на раннере получает у него задачу, рабочую копию и ключи
// и сдаёт итог. Исполнитель заданий (Bitbucket) знает только адрес посредника и разовый
// ключ запуска - ключи подписки и шлюза на платформу не уходят.
//
// Запросы - с заголовком "Authorization: Bearer <ключ запуска>":
//   GET  /v1/task              текст задачи
//   GET  /v1/repo              рабочая копия цели (git bundle)
//   GET  /v1/env               переменные шага с ключами (JSON); выдаются один раз
//   PUT  /v1/files/<имя>       agent.patch, run.json, agent.log
//   POST /v1/done              {"exit_code": N} - шаг закончил; после этого запуск только читается
//   GET  /healthz              без ключа
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { RunFile, RunMeta, RunStore } from './runs.ts';

export interface BrokerOptions {
  runs: RunStore;
  // Переменные шага: ключи читаются в момент выдачи и на диск не пишутся.
  env(meta: RunMeta): Record<string, string>;
  onDone?(meta: RunMeta): void;
  maxUpload?: number; // байт на файл, по умолчанию 10 МБ
}

const UPLOADS: RunFile[] = ['agent.patch', 'run.json', 'agent.log'];

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'слишком большой файл');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export function broker(o: BrokerOptions): Server {
  const limit = o.maxUpload ?? 10 * 1024 * 1024;
  return createServer(async (req, res) => {
    const send = (status: number, data: string | Buffer = '', type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(data);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://broker');
      if (req.method === 'GET' && url.pathname === '/healthz') return send(200, 'ok');
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
      const meta = token ? o.runs.byToken(token) : undefined;
      if (!meta) throw new HttpError(401, 'нет ключа запуска или он истёк');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /v1/task' || route === 'GET /v1/repo') {
        const file = o.runs.read(meta.runId, route === 'GET /v1/task' ? 'task.md' : 'repo.bundle');
        if (!file) throw new HttpError(404, 'нет данных запуска');
        return send(200, file, route === 'GET /v1/task' ? 'text/markdown; charset=utf-8' : 'application/octet-stream');
      }
      if (route === 'GET /v1/env') {
        if (meta.envServed) throw new HttpError(410, 'переменные шага уже выданы');
        o.runs.update(meta.runId, { envServed: true });
        return send(200, JSON.stringify(o.env(meta)), 'application/json');
      }
      if (meta.done) throw new HttpError(409, 'запуск уже закончен');
      const upload = /^PUT \/v1\/files\/([a-z.]+)$/.exec(route)?.[1] as RunFile | undefined;
      if (upload) {
        if (!UPLOADS.includes(upload)) throw new HttpError(400, `нельзя сдать файл ${upload}`);
        o.runs.write(meta.runId, upload, await body(req, limit));
        return send(204);
      }
      if (route === 'POST /v1/done') {
        const data = JSON.parse((await body(req, 4096)).toString('utf8') || '{}') as { exit_code?: unknown };
        const exitCode = Number.isInteger(data.exit_code) ? Number(data.exit_code) : -1;
        o.runs.write(meta.runId, 'done.json', JSON.stringify({ exit_code: exitCode, at: new Date().toISOString() }));
        const next = o.runs.update(meta.runId, { done: true });
        send(204);
        o.onDone?.(next);
        return;
      }
      throw new HttpError(404, 'нет такого адреса');
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof HttpError) return send(e.status, e.message);
      if (e instanceof SyntaxError) return send(400, 'плохой JSON');
      return send(500, 'ошибка посредника');
    }
  });
}
