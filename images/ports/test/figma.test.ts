import { describe, expect, it } from 'vitest';
import { figmaMockups, parseFigmaLink } from '../figma.ts';

describe('макеты Figma', () => {
  it('ссылка -> ключ файла и рамка', () => {
    expect(parseFigmaLink('https://www.figma.com/design/AbC123/Розыгрыш?node-id=12-34&t=x')).toEqual({
      kind: 'design',
      key: 'AbC123',
      node: '12:34',
    });
    expect(parseFigmaLink('https://www.figma.com/make/Key9/x')).toEqual({ kind: 'make', key: 'Key9' });
    expect(parseFigmaLink('https://example.com/design/x')).toBeUndefined();
  });

  it('файл Figma Make - понятный отказ без запросов к API', async () => {
    await expect(figmaMockups({ token: 't', api: 'http://127.0.0.1:9' }).render('https://www.figma.com/make/Key9/x')).rejects.toThrow(
      /Figma Make/,
    );
  });
});
