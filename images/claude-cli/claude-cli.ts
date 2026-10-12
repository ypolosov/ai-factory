// Обёртка над официальным `claude -p`: отдаёт подписку Claude приложениям, которые умеют
// только API в формате OpenAI Chat Completions (база знаний Onyx). Каждый запрос - отдельный
// запуск Claude Code без инструментов; вызовы инструментов клиента (tools) модель
// возвращает JSON по схеме, обёртка переводит его в tool_calls. Поток (stream) - SSE
// с готовым ответом: Claude Code отвечает целиком.
//
//   POST /v1/chat/completions   GET /v1/models   GET /health
//
// Окружение: CLAUDE_BIN (по умолчанию claude), CLAUDE_MODEL (sonnet), GATEWAY_URL (запросы
// Claude Code идут через шлюз - учёт по x-task-id), MAX_PARALLEL (2), TIMEOUT_MS (180000),
// PORT (8000). Секреты - файлы в SECRETS_DIR (/secrets): token (ключ, который предъявляет
// шлюз), claude-oauth.token (вход подписки), gateway.key (ключ шлюза для подписок).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';

type Json = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

export interface Plan {
  system: string;
  prompt: string;
  tools: ToolDef[];
  // none - отвечать текстом; auto - текст или вызовы; required - только вызовы; иначе - имя инструмента.
  toolChoice: string;
}

export interface Reply {
  content: string;
  toolCalls: { name: string; arguments: string }[];
  usage: { prompt_tokens: number; completion_tokens: number };
}

export interface Config {
  claudeBin: string;
  model: string;
  gatewayUrl: string;
  token: string;
  oauthToken: string;
  gatewayKey: string;
  maxParallel: number;
  timeoutMs: number;
}

const BODY_LIMIT = 4 * 1024 * 1024;

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof (p as Json)['text'] === 'string' ? (p as Json)['text'] : ''))
      .join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

// Запрос Chat Completions -> системная подсказка, текст разговора, инструменты.
export function planRequest(body: Json): Plan {
  const messages = Array.isArray(body['messages']) ? (body['messages'] as Json[]) : [];
  const system: string[] = [];
  const turns: string[] = [];
  for (const m of messages) {
    const role = String(m['role'] ?? '');
    const content = text(m['content']);
    if (role === 'system' || role === 'developer') {
      system.push(content);
    } else if (role === 'user') {
      turns.push(`[Пользователь]\n${content}`);
    } else if (role === 'assistant') {
      const calls = Array.isArray(m['tool_calls']) ? (m['tool_calls'] as Json[]) : [];
      const callText = calls
        .map((c) => {
          const f = (c['function'] ?? {}) as Json;
          return `вызов инструмента ${String(f['name'])} (id ${String(c['id'])}) с аргументами ${String(f['arguments'])}`;
        })
        .join('\n');
      turns.push(`[Ассистент]\n${[content, callText].filter(Boolean).join('\n')}`);
    } else if (role === 'tool') {
      turns.push(`[Результат инструмента, id ${String(m['tool_call_id'])}]\n${content}`);
    }
  }
  const tools: ToolDef[] = (Array.isArray(body['tools']) ? (body['tools'] as Json[]) : [])
    .map((t) => (t['function'] ?? {}) as Json)
    .filter((f) => typeof f['name'] === 'string')
    .map((f) => ({ name: String(f['name']), description: String(f['description'] ?? ''), parameters: f['parameters'] ?? {} }));
  let toolChoice = 'auto';
  const tc = body['tool_choice'];
  if (tools.length === 0 || tc === 'none') toolChoice = 'none';
  else if (tc === 'required') toolChoice = 'required';
  else if (tc && typeof tc === 'object') toolChoice = String(((tc as Json)['function'] as Json | undefined)?.['name'] ?? 'auto');
  return { system: system.join('\n\n'), prompt: turns.join('\n\n'), tools, toolChoice };
}

// Схема ответа, когда клиент дал инструменты.
export function replySchema(plan: Plan): Json {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['content', 'tool_calls'],
    properties: {
      content: { type: 'string' },
      tool_calls: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'arguments_json'],
          properties: {
            name: { type: 'string', enum: plan.tools.map((t) => t.name) },
            arguments_json: { type: 'string' },
          },
        },
      },
    },
  };
}

export function toolInstructions(plan: Plan): string {
  if (plan.toolChoice === 'none') return '';
  const list = plan.tools
    .map((t) => `- ${t.name}: ${t.description}\n  параметры (JSON Schema): ${JSON.stringify(t.parameters)}`)
    .join('\n');
  const must =
    plan.toolChoice === 'auto'
      ? 'Если для ответа нужен инструмент - верни вызовы в tool_calls и оставь content пустым; иначе ответь в content и оставь tool_calls пустым.'
      : plan.toolChoice === 'required'
        ? 'Обязательно вызови хотя бы один инструмент: tool_calls не пуст, content пуст.'
        : `Обязательно вызови инструмент ${plan.toolChoice}: tool_calls не пуст, content пуст.`;
  return `\n\nДоступные инструменты (их выполняет приложение, не ты):\n${list}\n${must} Аргументы - JSON-объект строкой в arguments_json.`;
}

// Ответ claude -p --output-format json -> ответ обёртки.
export function parseClaude(stdout: string, plan: Plan): Reply {
  const out = JSON.parse(stdout) as Json;
  if (out['is_error'] === true) throw new Error(`Claude Code: ${String(out['result'] ?? 'ошибка')}`);
  const u = (out['usage'] ?? {}) as Json;
  const usage = {
    prompt_tokens:
      Number(u['input_tokens'] ?? 0) + Number(u['cache_read_input_tokens'] ?? 0) + Number(u['cache_creation_input_tokens'] ?? 0),
    completion_tokens: Number(u['output_tokens'] ?? 0),
  };
  if (plan.toolChoice === 'none') return { content: String(out['result'] ?? ''), toolCalls: [], usage };
  let structured = out['structured_output'] as Json | undefined;
  if (!structured && typeof out['result'] === 'string') {
    try {
      structured = JSON.parse(out['result']) as Json;
    } catch {
      return { content: out['result'], toolCalls: [], usage };
    }
  }
  const calls = Array.isArray(structured?.['tool_calls']) ? (structured['tool_calls'] as Json[]) : [];
  const toolCalls = calls
    .filter((c) => plan.tools.some((t) => t.name === c['name']))
    .map((c) => {
      let args = String(c['arguments_json'] ?? '{}');
      try {
        args = JSON.stringify(JSON.parse(args));
      } catch {
        args = '{}';
      }
      return { name: String(c['name']), arguments: args };
    });
  return { content: toolCalls.length > 0 ? '' : String(structured?.['content'] ?? ''), toolCalls, usage };
}

export function completion(reply: Reply, model: string, id = `chatcmpl-${randomUUID()}`): Json {
  const message: Json = { role: 'assistant', content: reply.toolCalls.length > 0 ? null : reply.content };
  if (reply.toolCalls.length > 0) {
    message['tool_calls'] = reply.toolCalls.map((c, i) => ({
      id: `call_${i}_${id.slice(-8)}`,
      type: 'function',
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: reply.toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
    usage: { ...reply.usage, total_tokens: reply.usage.prompt_tokens + reply.usage.completion_tokens },
  };
}

// Готовый ответ -> куски SSE в формате chat.completion.chunk.
export function chunks(reply: Reply, model: string, includeUsage: boolean): string[] {
  const full = completion(reply, model);
  const base = { id: full['id'], object: 'chat.completion.chunk', created: full['created'], model };
  const choice = (full['choices'] as Json[])[0]!;
  const message = choice['message'] as Json;
  const out: Json[] = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }];
  if (Array.isArray(message['tool_calls'])) {
    out.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: (message['tool_calls'] as Json[]).map((c, i) => ({ index: i, ...c })) },
          finish_reason: null,
        },
      ],
    });
  } else if (reply.content) {
    out.push({ ...base, choices: [{ index: 0, delta: { content: reply.content }, finish_reason: null }] });
  }
  out.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice['finish_reason'] }] });
  if (includeUsage) out.push({ ...base, choices: [], usage: full['usage'] });
  return [...out.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'];
}

// Запуск claude -p: без инструментов, без сохранения сессии, запросы - через шлюз.
export function runClaude(cfg: Config, plan: Plan, taskId: string): Promise<Reply> {
  const args = ['-p', '--model', cfg.model, '--no-session-persistence', '--output-format', 'json'];
  const system = (plan.system || 'Ты - ассистент.') + toolInstructions(plan);
  args.push('--system-prompt', system);
  if (plan.toolChoice !== 'none') args.push('--json-schema', JSON.stringify(replySchema(plan)));
  // --tools - последним: он принимает несколько значений.
  args.push('--tools', '');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    LANG: 'C.UTF-8',
    CLAUDE_CODE_OAUTH_TOKEN: cfg.oauthToken,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  if (cfg.gatewayUrl) {
    env['ANTHROPIC_BASE_URL'] = cfg.gatewayUrl;
    env['ANTHROPIC_CUSTOM_HEADERS'] = `x-gateway-key: ${cfg.gatewayKey}\nx-task-id: ${taskId}`;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.claudeBin, args, { env, cwd: '/tmp', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), cfg.timeoutMs);
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude: код ${code}: ${stderr.slice(-300)}`));
        return;
      }
      try {
        resolve(parseClaude(stdout, plan));
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.end(plan.prompt || '(пусто)');
  });
}

// Очередь: не больше maxParallel запусков Claude Code одновременно.
export function limiter(max: number): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await job();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createServer(
  cfg: Config,
  run: (plan: Plan, taskId: string) => Promise<Reply> = (plan, taskId) => runClaude(cfg, plan, taskId),
  log: (m: string) => void = console.log,
): http.Server {
  const queue = limiter(cfg.maxParallel);
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://claude-cli');
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { status: 'ok' });
    const auth = String(req.headers['authorization'] ?? '').replace(/^Bearer /, '');
    if (!sameToken(auth, cfg.token)) return sendJson(res, 401, { error: { message: 'unauthorized' } });
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(res, 200, { object: 'list', data: [{ id: cfg.model, object: 'model', owned_by: 'claude-code' }] });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return sendJson(res, 404, { error: { message: 'not found' } });
    }
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        sendJson(res, 413, { error: { message: 'too large' } });
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => {
      let body: Json;
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf-8')) as Json;
      } catch {
        return sendJson(res, 400, { error: { message: 'bad json' } });
      }
      const plan = planRequest(body);
      const model = String(body['model'] ?? cfg.model);
      const taskId = String(req.headers['x-task-id'] ?? 'kb-claude-cli');
      const started = Date.now();
      queue(() => run(plan, taskId)).then(
        (reply) => {
          log(
            `ответ за ${Date.now() - started} мс: инструментов предложено ${plan.tools.length} (${plan.toolChoice}), ` +
              `вызвано ${reply.toolCalls.length}, токены ${reply.usage.completion_tokens}`,
          );
          if (body['stream'] === true) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            const includeUsage = ((body['stream_options'] ?? {}) as Json)['include_usage'] === true;
            for (const c of chunks(reply, model, includeUsage)) res.write(c);
            res.end();
          } else {
            sendJson(res, 200, completion(reply, model));
          }
        },
        (err: unknown) => {
          log(`сбой: ${String(err)}`);
          sendJson(res, 502, { error: { message: String(err).slice(0, 500), type: 'claude_cli_error' } });
        },
      );
    });
  });
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const dir = env['SECRETS_DIR'] ?? '/secrets';
  const secret = (name: string): string => readFileSync(`${dir}/${name}`, 'utf-8').trim();
  return {
    claudeBin: env['CLAUDE_BIN'] ?? 'claude',
    model: env['CLAUDE_MODEL'] ?? 'sonnet',
    gatewayUrl: env['GATEWAY_URL'] ?? '',
    token: secret('token'),
    oauthToken: secret('claude-oauth.token'),
    gatewayKey: env['GATEWAY_URL'] ? secret('gateway.key') : '',
    maxParallel: Number(env['MAX_PARALLEL'] ?? 2),
    timeoutMs: Number(env['TIMEOUT_MS'] ?? 180000),
  };
}

if (import.meta.main) {
  const cfg = configFromEnv();
  const port = Number(process.env['PORT'] ?? 8000);
  createServer(cfg).listen(port, () => console.log(`claude-cli: :${port}, модель ${cfg.model}`));
}
