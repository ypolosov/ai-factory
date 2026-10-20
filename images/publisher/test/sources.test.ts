import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseDecisions, parseHelp, parseScenario, parseTools } from '../sources.ts';

// Источник руководств - настоящие файлы фабрики: сменился их вид - тест падает раньше руководства.
const repo = (p: string) => readFile(new URL(`../../../${p}`, import.meta.url), 'utf8');

describe('факты о фабрике из её файлов', () => {
  it('справка бота: команды с тем, как набрать и что делают', async () => {
    const { about, commands } = parseHelp(await repo('images/coordinator/bot.ts'));
    expect(about.text).toMatch(/бот фабрики/i);
    const ids = commands.map((c) => c.id);
    for (const id of ['cmd:дейли', 'cmd:задача', 'cmd:ci', 'cmd:судья', 'cmd:выкладка', 'cmd:нарезка']) expect(ids).toContain(id);
    expect(commands.find((c) => c.id === 'cmd:ci')?.usage).toBe('!ci [номер PR]');
  });

  it('инструменты MCP с заголовком и описанием', async () => {
    const tools = parseTools(await repo('images/coordinator/mcp.ts'));
    expect(tools.map((t) => t.name)).toEqual(['kb_search', 'check_requirement', 'factory_rules', 'submit_task']);
    expect(tools[0]?.description).toMatch(/ссылками/);
  });

  it('точки решения ролей', async () => {
    const d = parseDecisions(await repo('images/coordinator/roles.ts'));
    expect(d.map((x) => x.id)).toEqual(
      ['deploy', 'approve-slice', 'slice', 'submit-task', 'story', 'propose-rule', 'rerun-checks', 'design-check', 'factory-config'].map(
        (k) => `decision:${k}`,
      ),
    );
  });

  it('сценарий: подготовка и шаги по ролям', async () => {
    const { prep, steps } = parseScenario(await repo('docs/demo/scenario.md'));
    expect(prep.length).toBeGreaterThan(2);
    expect(steps.find((s) => s.n === '4')).toMatchObject({ role: 'Project Manager', where: 'Discord' });
    expect(steps.find((s) => s.n === '4a')?.role).toBe('Разработчик BE');
  });

  it('файл без нужного - понятная ошибка, а не пустой источник', () => {
    expect(() => parseHelp('const x = 1;')).toThrow(/HELP/);
    expect(() => parseTools('')).toThrow(/инструментов/);
    expect(() => parseScenario('# пусто')).toThrow(/таблицы/);
  });
});
