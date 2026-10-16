import { describe, expect, it } from 'vitest';
import { chapterHtml, fill, parseEnv, takeName } from '../script.ts';

describe('сценарий съёмки', () => {
  it('файл ключей: ИМЯ=значение, комментарии и кавычки', () => {
    expect(parseEnv('# ключи\nA=1\nB="два"\n\nC=x=y\n')).toEqual({ A: '1', B: 'два', C: 'x=y' });
  });

  it('подстановки из итогов прошлых шагов; неизвестная - ошибка', () => {
    const ctx = { story: { issue: { key: 'DRAW-14', url: 'https://x/DRAW-14' } } };
    expect(fill('!нарезка {story.issue.key}', ctx)).toBe('!нарезка DRAW-14');
    expect(() => fill('{story.page.url}', ctx)).toThrow('нет значения {story.page.url}');
  });

  it('имя дубля - по местному времени начала, годится в метку Jira и Confluence', () => {
    expect(takeName(new Date(2026, 9, 16, 9, 5))).toBe('take-1016-0905');
    expect(takeName(new Date(2026, 0, 2, 23, 59))).toMatch(/^take-[0-9]{4}-[0-9]{4}$/);
  });

  it('карточка главы экранирует текст', () => {
    const html = chapterHtml('Стори <b>', 'шаг "2"');
    expect(html).toContain('Стори &lt;b&gt;');
    expect(html).toContain('шаг &quot;2&quot;');
  });
});
