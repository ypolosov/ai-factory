import assert from 'node:assert/strict';
import { test } from 'vitest';
import { agentMinutes, dora, executorOf, type LogRow, median, minutes, models, render, rowCost, type Task, taskRows } from '../report.ts';

const row = (o: Partial<LogRow>): LogRow => ({
  taskId: 't',
  model: 'm',
  startedAt: '2026-10-12T10:00:00.000000+00:00',
  completedAt: '2026-10-12T10:00:30.000000+00:00',
  input: 0,
  cacheRead: 0,
  output: 0,
  cost: null,
  ...o,
});

test('цена записи: из журнала, иначе теневая по прайсу с учётом кэша', () => {
  assert.equal(rowCost(row({ cost: 0.5 })), 0.5);
  // 1 млн свежих входных по 2, 1 млн из кэша по 0,1, 0,1 млн выхода по 10.
  assert.equal(rowCost(row({ model: 'gpt-6.1-sol', input: 2e6, cacheRead: 1e6, output: 1e5 })), 2 + 0.1 + 1);
  assert.equal(rowCost(row({ model: 'неизвестная', input: 1e6 })), 0);
});

test('медиана и минуты', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(minutes('2026-10-12T10:00:00Z', '2026-10-12T10:30:00Z'), 30);
  assert.equal(minutes(null, '2026-10-12T10:30:00Z'), null);
});

test('записи задачи: метки с репозиторием всегда, старые без репозитория - только в окне задачи', () => {
  const rows = [
    row({ taskId: 'todo-issue-9-run-1' }),
    row({ taskId: 'issue-9-run-2', startedAt: '2026-10-12T11:00:00' }),
    row({ taskId: 'issue-9-run-3', startedAt: '2026-10-11T11:00:00' }),
    row({ taskId: 'issue-90-run-1', startedAt: '2026-10-12T11:00:00' }),
    row({ taskId: 'todo-gate-pr-18-claude-opus' }),
    row({ taskId: 'pr-18-review', startedAt: '2026-10-12T11:00:00' }),
    row({ taskId: 'hello-issue-9-run-1' }),
  ];
  const { agent, gate } = taskRows(rows, 'factory-admin/todo', 9, 18, '2026-10-12T09:00:00', '2026-10-12T12:00:00Z');
  assert.deepEqual(
    agent.map((r) => r.taskId),
    ['todo-issue-9-run-1', 'issue-9-run-2'],
  );
  assert.deepEqual(
    gate.map((r) => r.taskId),
    ['todo-gate-pr-18-claude-opus', 'pr-18-review'],
  );
});

test('время модели - сумма прогонов, модели - по частоте, исполнитель - по семейству', () => {
  const rows = [
    row({ taskId: 'a', model: 'gpt-6.1-sol', startedAt: '2026-10-12T10:00:00Z', completedAt: '2026-10-12T10:01:00Z' }),
    row({ taskId: 'a', model: 'gpt-6.1-sol', startedAt: '2026-10-12T10:04:00Z', completedAt: '2026-10-12T10:05:00Z' }),
    row({ taskId: 'b', model: 'z-ai/glm-5.3-flash', startedAt: '2026-10-12T11:00:00Z', completedAt: '2026-10-12T11:02:00Z' }),
  ];
  assert.equal(agentMinutes(rows), 7);
  assert.deepEqual(models(rows), ['gpt-6.1-sol', 'z-ai/glm-5.3-flash']);
  assert.equal(executorOf('gpt-6.1-sol'), 'codex');
  assert.equal(executorOf('claude-sonnet-5-5'), 'claude');
  assert.equal(executorOf('z-ai/glm-5.3-flash'), 'opencode');
});

test('DORA: выкладки, неудачи, восстановление до следующей удачной', () => {
  const d = dora([
    { sha: '1', at: '2026-10-12T10:00:00Z', ok: true },
    { sha: '2', at: '2026-10-12T11:00:00Z', ok: false },
    { sha: '3', at: '2026-10-12T11:20:00Z', ok: true },
    { sha: '4', at: '2026-10-14T10:00:00Z', ok: true },
  ]);
  assert.deepEqual(d, { deploys: 3, failed: 1, days: 3, restoreMin: 20 });
  assert.deepEqual(dora([]), { deploys: 0, failed: 0, days: 1, restoreMin: null });
});

test('отчёт: четыре раздела и строка задачи', () => {
  const t: Task = {
    repo: 'factory-admin/todo',
    issue: 10,
    title: '#10 Пустой текст',
    pr: 20,
    executor: 'codex',
    model: 'gpt-6.1-sol',
    rounds: 1,
    decisions: ['90, 91 -> человеку'],
    merged: true,
    firstAttempt: true,
    agentUsd: 0.2,
    gateUsd: 0.06,
    agentMin: 2,
    labeledAt: '2026-10-12T10:00:00Z',
    prAt: '2026-10-12T10:03:00Z',
    mergedAt: '2026-10-12T10:07:00Z',
    standAt: '2026-10-12T10:08:00Z',
  };
  const md = render(
    ['factory-admin/todo'],
    [t],
    new Map([['factory-admin/todo', [{ sha: 'x', at: '2026-10-12T10:08:00Z', ok: true }]]]),
    'сегодня',
  );
  for (const h of ['## 1. Цена', '## 2. Время', '## 3. Слиты с первой попытки', '## 4. DORA']) assert.ok(md.includes(h), h);
  assert.match(md, /\| codex \| gpt-6\.1-sol \| 1 \| 100% \| 2\.0 \| 8\.0 \| 0\.26 \|/);
  assert.match(md, /\| #10 Пустой текст \| #20 \| codex, gpt-6\.1-sol \| 1 \| 90, 91 -> человеку \| да \| 8\.0 \| 0\.26 \|/);
});
