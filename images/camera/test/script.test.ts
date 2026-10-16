import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyEdit, asksRetry, chapterHtml, checkFilm, type Film, fill, nextVersion, parseEnv, snowflake, takeName } from '../script.ts';

describe('сценарий съёмки', () => {
  it('файл ключей: ИМЯ=значение, комментарии и кавычки', () => {
    expect(parseEnv('# ключи\nA=1\nB="два"\n\nC=x=y\n')).toEqual({ A: '1', B: 'два', C: 'x=y' });
  });

  it('подстановки из итогов прошлых шагов; неизвестная - ошибка', () => {
    const ctx = { story: { issue: { key: 'DRAW-14', url: 'https://x/DRAW-14' } } };
    expect(fill('!нарезка {story.issue.key}', ctx)).toBe('!нарезка DRAW-14');
    expect(fill('openspec/changes/{story.issue.key|lower}-x/', ctx)).toBe('openspec/changes/draw-14-x/');
    expect(fill('{ "json": 1 }', ctx)).toBe('{ "json": 1 }');
    expect(() => fill('{story.page.url}', ctx)).toThrow('нет значения {story.page.url}');
  });

  it('имя дубля - по местному времени начала, годится в метку Jira и Confluence', () => {
    expect(takeName(new Date(2026, 9, 16, 9, 5))).toBe('take-1016-0905');
    expect(takeName(new Date(2026, 0, 2, 23, 59))).toMatch(/^take-[0-9]{4}-[0-9]{4}$/);
  });

  it('правка файла: заготовка, замены ровно одного вхождения, дописка в конец', () => {
    const asset = (n: string) => `заготовка ${n}`;
    expect(applyEdit('старое', { path: 'a.md', from: 'x.md' }, asset)).toBe('заготовка x.md');
    expect(applyEdit('a: 1\nb: 2\n', { path: 'c.yml', replace: [{ find: 'b: 2', with: 'b: 3' }] }, asset)).toBe('a: 1\nb: 3\n');
    expect(applyEdit('текст', { path: 'a.md', append: 'хвост' }, asset)).toBe('текст\nхвост\n');
    expect(applyEdit(undefined, { path: 'new.md', append: 'новый' }, asset)).toBe('новый\n');
    expect(() => applyEdit('x x', { path: 'a.md', replace: [{ find: 'x', with: 'y' }] }, asset)).toThrow('a.md: "x" встречается 2 раз');
    expect(() => applyEdit('x', { path: 'a.md', replace: [{ find: 'z', with: 'y' }] }, asset)).toThrow('a.md: "z" встречается 0 раз');
    expect(() => applyEdit(undefined, { path: 'a.md', replace: [{ find: 'z', with: 'y' }] }, asset)).toThrow('a.md: нет файла');
  });

  it('сценарий съёмки цел: участники, их учётки, подстановки из прошлых шагов, заготовки', () => {
    const film: Film = {
      title: 'т',
      personas: { a: { name: 'A', kind: 'ai', discord: 'a' }, b: { name: 'B', kind: 'ai' } },
      steps: [
        { id: 's1', who: 'a', do: { discord: { channel: 'к', text: '{s2.x}' } }, wait: { jira: { label: 'w-{s1.page.id}' } } },
        {
          id: 's2',
          who: 'b',
          do: { github: { merge: { pr: '{s1.pr.number}', title: '{take}' } } },
          show: [{ who: 'c', url: 'u', caption: 'к' }],
        },
        { id: 's3', who: 'b', do: { github: { pr: { branch: 'x', title: 't', body: 'b', files: [{ path: 'p', from: 'нет.md' }] } } } },
      ],
    };
    expect(checkFilm(film, () => false)).toEqual([
      's1: {s2...} - не прошлый шаг',
      's2: у участника b нет приложения GitHub',
      's2: в кадре нет участника c',
      's3: у участника b нет приложения GitHub',
      's3: нет заготовки нет.md',
    ]);
    const real = parse(readFileSync(new URL('../../../docs/demo/film.yml', import.meta.url), 'utf8')) as Film;
    const assets = (n: string) => existsSync(new URL(`../../../docs/demo/film-assets/${n}`, import.meta.url));
    expect(checkFilm(real, assets)).toEqual([]);
  });

  it('следующий выпуск - по последнему тегу vX.Y.Z; тегов нет - v1.0.0', () => {
    expect(nextVersion(['v1.0.0', 'demo-baseline', 'v1.2.3', 'v1.10.0'], 'minor')).toBe('v1.11.0');
    expect(nextVersion(['v1.0.0'], 'patch')).toBe('v1.0.1');
    expect(nextVersion(['demo-baseline'], 'minor')).toBe('v1.0.0');
  });

  it('метка времени Discord для "сообщения после": миллисекунды от эпохи Discord, сдвиг на 22 бита', () => {
    expect(snowflake(Date.UTC(2015, 0, 1))).toBe('0');
    expect(snowflake(1_420_070_400_000 + 1)).toBe('4194304');
  });

  it('просьба фабрики повторить команду (площадка временно недоступна) отличается от ответа', () => {
    expect(asksRetry('Сервис сейчас недоступен - повторите команду через минуту.')).toBe(true);
    expect(asksRetry('Сверка макета DRAW-43: замечаний нет')).toBe(false);
  });

  it('карточка главы экранирует текст', () => {
    const html = chapterHtml('Стори <b>', 'шаг "2"');
    expect(html).toContain('Стори &lt;b&gt;');
    expect(html).toContain('шаг &quot;2&quot;');
  });
});
