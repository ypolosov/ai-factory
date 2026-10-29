import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  type Config,
  chunks,
  completion,
  createServer,
  forceFirst,
  limiter,
  type Plan,
  parseClaude,
  planRequest,
  type Reply,
  replySchema,
  runClaude,
} from '../claude-cli.ts';

const tools = [
  {
    type: 'function',
    function: {
      name: 'internal_search',
      description: 'Поиск по базе',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
];

test('разговор с инструментами -> подсказка, текст, инструменты', () => {
  const plan = planRequest({
    messages: [
      { role: 'system', content: 'Ты - Onyx.' },
      { role: 'user', content: [{ type: 'text', text: 'почему Origin?' }] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'internal_search', arguments: '{"query":"Origin"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ADR-10: проверка Origin' },
    ],
    tools,
  });
  assert.equal(plan.system, 'Ты - Onyx.');
  assert.match(plan.prompt, /\[Пользователь\]\nпочему Origin\?/);
  assert.match(plan.prompt, /вызов инструмента internal_search \(id c1\) с аргументами \{"query":"Origin"\}/);
  assert.match(plan.prompt, /\[Результат инструмента, id c1\]\nADR-10/);
  assert.deepEqual(
    plan.tools.map((t) => t.name),
    ['internal_search'],
  );
  assert.equal(plan.toolChoice, 'auto');
});

test('выбор инструмента: none, required, по имени, без инструментов', () => {
  assert.equal(planRequest({ messages: [], tools, tool_choice: 'none' }).toolChoice, 'none');
  assert.equal(planRequest({ messages: [], tools, tool_choice: 'required' }).toolChoice, 'required');
  assert.equal(
    planRequest({ messages: [], tools, tool_choice: { type: 'function', function: { name: 'internal_search' } } }).toolChoice,
    'internal_search',
  );
  assert.equal(planRequest({ messages: [], tool_choice: 'required' }).toolChoice, 'none');
});

test('схема ответа ограничивает имена инструментов', () => {
  const plan = planRequest({ messages: [], tools });
  const schema = replySchema(plan) as { properties: { tool_calls: { items: { properties: { name: { enum: string[] } } } } } };
  assert.deepEqual(schema.properties.tool_calls.items.properties.name.enum, ['internal_search']);
});

const withTools: Plan = {
  system: '',
  prompt: 'q',
  tools: [{ name: 'internal_search', description: '', parameters: {} }],
  toolChoice: 'auto',
  hasToolResults: false,
};

test('первый шаг с поиском - обязательный вызов, после результатов - на выбор модели', () => {
  assert.equal(forceFirst(withTools, 'internal_search').toolChoice, 'internal_search');
  assert.equal(forceFirst({ ...withTools, hasToolResults: true }, 'internal_search').toolChoice, 'auto');
  assert.equal(forceFirst(withTools, '').toolChoice, 'auto');
  assert.equal(forceFirst(withTools, 'web_search').toolChoice, 'auto');
  assert.equal(forceFirst({ ...withTools, toolChoice: 'none' }, 'internal_search').toolChoice, 'none');
  assert.equal(planRequest({ messages: [{ role: 'tool', content: 'x' }], tools }).hasToolResults, true);
});

test('ответ Claude Code: вызов инструмента', () => {
  const reply = parseClaude(
    JSON.stringify({
      result: '',
      structured_output: {
        content: 'игнор',
        tool_calls: [
          { name: 'internal_search', arguments_json: '{ "query": "Origin" }' },
          { name: 'чужой', arguments_json: '{}' },
        ],
      },
      usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 },
    }),
    withTools,
  );
  assert.deepEqual(reply.toolCalls, [{ name: 'internal_search', arguments: '{"query":"Origin"}' }]);
  assert.equal(reply.content, '');
  assert.deepEqual(reply.usage, { prompt_tokens: 15, completion_tokens: 7 });
});

test('ответ Claude Code: текст, плохие аргументы, ошибка', () => {
  const none: Plan = { ...withTools, toolChoice: 'none' };
  assert.equal(parseClaude(JSON.stringify({ result: 'Ответ [1]' }), none).content, 'Ответ [1]');
  const bad = parseClaude(
    JSON.stringify({ structured_output: { content: '', tool_calls: [{ name: 'internal_search', arguments_json: 'не json' }] } }),
    withTools,
  );
  assert.equal(bad.toolCalls[0]!.arguments, '{}');
  const textOnly = parseClaude(JSON.stringify({ result: 'просто текст' }), withTools);
  assert.equal(textOnly.content, 'просто текст');
  assert.throws(() => parseClaude(JSON.stringify({ is_error: true, result: 'лимит' }), none), /лимит/);
});

const twoTools: Plan = { ...withTools, tools: [...withTools.tools, { name: 'web_search', description: '', parameters: {} }] };

test('обязательный вызов: схема требует вызов, а по имени - только этот инструмент', () => {
  type Schema = { properties: { tool_calls: { minItems?: number; items: { properties: { name: { enum: string[] } } } } } };
  const calls = (toolChoice: string) => {
    const schema = replySchema({ ...twoTools, toolChoice }) as Schema; // replySchema отдаёт Json, форма схемы - наша
    return schema.properties.tool_calls;
  };
  assert.equal(calls('auto').minItems, undefined);
  assert.equal(calls('required').minItems, 1);
  assert.deepEqual(calls('required').items.properties.name.enum, ['internal_search', 'web_search']);
  assert.equal(calls('web_search').minItems, 1);
  assert.deepEqual(calls('web_search').items.properties.name.enum, ['web_search']);
});

test('обязательный вызов: ответ без него или с другим инструментом - ошибка, а не текст', () => {
  // Так ответил Haiku на первом шаге reflect Hindsight (проба РП 64, Q1): текст вместо вызова.
  const text = JSON.stringify({ result: 'данных нет', structured_output: { content: 'данных нет', tool_calls: [] } });
  const call = (name: string) => JSON.stringify({ structured_output: { content: '', tool_calls: [{ name, arguments_json: '{}' }] } });
  const named: Plan = { ...twoTools, toolChoice: 'internal_search' };
  assert.throws(() => parseClaude(text, named), /internal_search/);
  assert.throws(() => parseClaude(JSON.stringify({ result: 'просто текст' }), named), /internal_search/);
  assert.throws(() => parseClaude(call('web_search'), named), /internal_search/);
  assert.throws(() => parseClaude(text, { ...twoTools, toolChoice: 'required' }), /ни одного инструмента/);
  assert.equal(parseClaude(call('internal_search'), named).toolCalls.length, 1);
  assert.equal(parseClaude(call('web_search'), { ...twoTools, toolChoice: 'required' }).toolCalls.length, 1);
  assert.equal(parseClaude(text, twoTools).content, 'данных нет'); // auto: текст - законный ответ
});

const textReply: Reply = { content: 'Потому что ADR-10.', toolCalls: [], usage: { prompt_tokens: 3, completion_tokens: 4 } };
const callReply: Reply = {
  content: '',
  toolCalls: [{ name: 'internal_search', arguments: '{"query":"x"}' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

test('ответ в формате Chat Completions', () => {
  const t = completion(textReply, 'kb-claude-cli') as {
    choices: { message: { content: string }; finish_reason: string }[];
    usage: { total_tokens: number };
  };
  assert.equal(t.choices[0]!.message.content, 'Потому что ADR-10.');
  assert.equal(t.choices[0]!.finish_reason, 'stop');
  assert.equal(t.usage.total_tokens, 7);
  const c = completion(callReply, 'kb-claude-cli') as {
    choices: { message: { content: null; tool_calls: { function: { name: string } }[] }; finish_reason: string }[];
  };
  assert.equal(c.choices[0]!.message.content, null);
  assert.equal(c.choices[0]!.message.tool_calls[0]!.function.name, 'internal_search');
  assert.equal(c.choices[0]!.finish_reason, 'tool_calls');
});

test('поток SSE: роль, содержимое, конец, расход, DONE', () => {
  const parts = chunks(textReply, 'm', true);
  assert.equal(parts.at(-1), 'data: [DONE]\n\n');
  const data = parts.slice(0, -1).map(
    (p) =>
      JSON.parse(p.slice(6)) as {
        choices: { delta: { content?: string; tool_calls?: unknown[] }; finish_reason: string | null }[];
        usage?: unknown;
      },
  );
  assert.equal(data[1]!.choices[0]!.delta.content, 'Потому что ADR-10.');
  assert.equal(data[2]!.choices[0]!.finish_reason, 'stop');
  assert.ok(data[3]!.usage);
  const calls = chunks(callReply, 'm', false)
    .slice(0, -1)
    .map((p) => JSON.parse(p.slice(6)) as { choices: { delta: { tool_calls?: { index: number }[] }; finish_reason: string | null }[] });
  assert.equal(calls[1]!.choices[0]!.delta.tool_calls![0]!.index, 0);
  assert.equal(calls.at(-1)!.choices[0]!.finish_reason, 'tool_calls');
});

test('очередь держит не больше заданного числа запусков', async () => {
  const queue = limiter(2);
  let active = 0;
  let peak = 0;
  const job = () =>
    queue(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    });
  await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(peak, 2);
});

const cfg: Config = {
  claudeBin: 'claude',
  model: 'sonnet',
  gatewayUrl: 'http://gateway:4000',
  token: 'secret-token',
  oauthToken: 'oauth',
  gatewayKey: 'gw-key',
  maxParallel: 2,
  timeoutMs: 5000,
  forceFirstTool: '',
};

test('запуск claude -p: флаги, подсказка из stdin, вход и шлюз - в окружении', async () => {
  // Подставной claude: печатает свои аргументы, окружение и stdin как ответ Claude Code.
  const dir = mkdtempSync(join(tmpdir(), 'claude-cli-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const seen = { args: process.argv.slice(2), oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, base: process.env.ANTHROPIC_BASE_URL, headers: process.env.ANTHROPIC_CUSTOM_HEADERS, input };
  process.stdout.write(JSON.stringify({ result: JSON.stringify(seen), usage: { input_tokens: 1, output_tokens: 1 } }));
});
`,
  );
  chmodSync(bin, 0o755);
  const plan: Plan = { system: 'Система.', prompt: '[Пользователь]\nвопрос', tools: [], toolChoice: 'none', hasToolResults: false };
  const reply = await runClaude({ ...cfg, claudeBin: bin }, plan, 'kb-task-1');
  const seen = JSON.parse(reply.content) as { args: string[]; oauth: string; base: string; headers: string; input: string };
  assert.deepEqual(seen.args.slice(0, 6), ['-p', '--model', 'sonnet', '--no-session-persistence', '--output-format', 'json']);
  assert.equal(seen.args[seen.args.indexOf('--system-prompt') + 1], 'Система.');
  assert.deepEqual(seen.args.slice(-2), ['--tools', '']);
  assert.ok(!seen.args.includes('--json-schema'));
  assert.equal(seen.oauth, 'oauth');
  assert.equal(seen.base, 'http://gateway:4000');
  assert.equal(seen.headers, 'x-gateway-key: gw-key\nx-task-id: kb-task-1');
  assert.equal(seen.input, '[Пользователь]\nвопрос');
});

async function serve(run: (plan: Plan, taskId: string) => Promise<Reply>): Promise<{ base: string; close: () => void }> {
  const server = createServer(cfg, run, () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test('служба: без ключа - 401, с ключом - ответ и поток', async () => {
  let seenTask = '';
  const { base, close } = await serve(async (_plan, taskId) => {
    seenTask = taskId;
    return textReply;
  });
  try {
    const body = JSON.stringify({ model: 'kb-claude-cli', messages: [{ role: 'user', content: 'q' }] });
    assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', body })).status, 401);
    const headers = { authorization: 'Bearer secret-token', 'x-task-id': 'onyx-1' };
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body, headers });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content, 'Потому что ADR-10.');
    assert.equal(seenTask, 'onyx-1');
    const stream = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'kb-claude-cli', stream: true, messages: [{ role: 'user', content: 'q' }] }),
    });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    assert.match(await stream.text(), /ADR-10[\s\S]*data: \[DONE\]/);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    close();
  }
});

test('служба: сбой Claude Code - 502, плохое тело - 400', async () => {
  const { base, close } = await serve(async () => {
    throw new Error('лимит подписки');
  });
  try {
    const headers = { authorization: 'Bearer secret-token' };
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ messages: [] }) });
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /лимит подписки/);
    assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: '{' })).status, 400);
  } finally {
    close();
  }
});
