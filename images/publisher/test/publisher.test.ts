import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiagramView } from '../../ports/ports.ts';
import { type L4Model, viewsFromLikeC4 } from '../likec4.ts';
import { modelVersion, publishViews } from '../publish.ts';

const fixture = async () => JSON.parse(await readFile(new URL('likec4-context.json', import.meta.url), 'utf8')) as L4Model;

describe('виды LikeC4 -> нейтральные виды', () => {
  it('узлы, группа, описания, связи и расклад переходят без потерь', async () => {
    const [v] = viewsFromLikeC4(await fixture(), 'abc');
    expect(v?.id).toBe('context');
    expect(v?.version).toBe('abc');
    const factory = v?.nodes.find((n) => n.id === 'factory');
    expect(factory).toMatchObject({ kind: 'system', title: 'Фабрика ПО на ИИ', parent: '@gr1' });
    expect(factory?.description).toMatch(/стражами/);
    expect(factory?.box?.width).toBeGreaterThan(0);
    expect(v?.nodes.find((n) => n.id === '@gr1')).toMatchObject({ kind: '@group', title: 'Предмет демо' });
    expect(v?.edges).toContainEqual({ source: 'exo', target: 'factory', label: 'MCP фабрики; правила из git' });
  });

  it('свой обзорный вид LikeC4 без файла в модели не публикуется', async () => {
    expect(viewsFromLikeC4(await fixture(), 'abc').map((v) => v.id)).toEqual(['context']);
  });

  it('JSON без расклада - отказ', () => {
    expect(() => viewsFromLikeC4({ _stage: 'computed', views: {} }, 'x')).toThrow(/расклад/);
  });
});

describe('версия источника', () => {
  it('меняется с любым файлом модели и не зависит от других файлов', async () => {
    const d = await mkdtemp(join(tmpdir(), 'model-'));
    try {
      await writeFile(join(d, 'a.c4'), 'model { x = system "X" }');
      const v1 = await modelVersion(d);
      await writeFile(join(d, 'notes.md'), 'не модель');
      expect(await modelVersion(d)).toBe(v1);
      await writeFile(join(d, 'a.c4'), 'model { x = system "Y" }');
      expect(await modelVersion(d)).not.toBe(v1);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe('публикация видов', () => {
  const shown: DiagramView[] = [];
  const diagrams = {
    publish: async (v: DiagramView) => {
      shown.push(v);
      return { url: `x/${v.id}` };
    },
    read: async () => undefined,
  };

  it('каждый вид модели уходит носителю с версией источника', async () => {
    const out = await publishViews(await fixture(), 'v7', diagrams);
    expect(out.map((o) => o.url)).toEqual(['x/context']);
    expect(shown.map((v) => v.version)).toEqual(['v7']);
  });

  it('модель без своих видов - ошибка, а не пустой успех', async () => {
    await expect(publishViews({ _stage: 'layouted', views: {} }, 'v1', diagrams)).rejects.toThrow(/нет видов/);
  });
});

describe('сценарий LikeC4 -> последовательность', () => {
  it('шаги по порядку, заметки, ветки alt с заголовками и par', async () => {
    const json = JSON.parse(await readFile(new URL('likec4-sequence.json', import.meta.url), 'utf8')) as L4Model;
    const [v] = viewsFromLikeC4(json, 'v1');
    expect(v?.nodes.map((n) => n.id)).toEqual([
      'eng.dev',
      'exo',
      'factory.mcp',
      'factory.cd',
      'jira',
      'eng.rev',
      'github',
      'factory.coord',
      'bitbucket',
      'discord',
    ]);
    expect(v?.edges[2]).toEqual({ source: 'factory.mcp', target: 'exo', label: 'требования, ссылки' });
    expect(v?.edges[4]?.note).toBe('HITL: замысел');
    expect(v?.flow).toEqual([
      0,
      1,
      2,
      3,
      4,
      {
        kind: 'alt',
        branches: [
          { title: 'доработать', flow: [5, 6] },
          { title: 'принять', flow: [7] },
        ],
      },
      { kind: 'par', flow: [8, 9] },
    ]);
  });

  it('блок, которого носители не знают, - ошибка с именем сценария', () => {
    const json: L4Model = {
      _stage: 'layouted',
      views: { s: { id: 's', sourcePath: 'x.c4', _type: 'dynamic', nodes: [], edges: [], flow: [{ _type: 'try', id: 't', flow: [] }] } },
    };
    expect(() => viewsFromLikeC4(json, 'v')).toThrow(/сценарий s: блок try/);
  });
});
