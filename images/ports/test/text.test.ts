import { describe, expect, it } from 'vitest';
import { stem } from '../text.ts';

describe('основа слова', () => {
  it('формы слова сходятся', () => {
    expect(stem('призы')).toBe(stem('приз'));
    expect(stem('невостребованные')).toBe(stem('востребован'));
    expect(stem('розыгрыша')).toBe(stem('розыгрыш'));
    expect(stem('заявки')).toBe(stem('заявка'));
  });
});
