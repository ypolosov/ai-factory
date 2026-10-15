import { describe, expect, it } from 'vitest';
import { chapterHtml, fill, parseEnv } from '../script.ts';

describe('сценарий съёмки', () => {
  it('файл ключей: ИМЯ=значение, комментарии и кавычки', () => {
    expect(parseEnv('# ключи\nA=1\nB="два"\n\nC=x=y\n')).toEqual({ A: '1', B: 'два', C: 'x=y' });
  });

  it('подстановки из итогов прошлых шагов; неизвестная - ошибка', () => {
    const ctx = { story: { issue: { key: 'DRAW-14', url: 'https://x/DRAW-14' } } };
    expect(fill('!нарезка {story.issue.key}', ctx)).toBe('!нарезка DRAW-14');
    expect(() => fill('{story.page.url}', ctx)).toThrow('нет значения {story.page.url}');
  });

  it('карточка главы экранирует текст', () => {
    const html = chapterHtml('Стори <b>', 'шаг "2"');
    expect(html).toContain('Стори &lt;b&gt;');
    expect(html).toContain('шаг &quot;2&quot;');
  });
});
