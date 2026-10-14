// Реестр GHCR вживую: открытый образ цели демо. Без GHCR_TEST_IMAGE (владелец/образ:тег) - пропуск.
import { expect, test } from 'vitest';
import { ghcrRegistry } from '../ghcr.ts';

const ref = process.env.GHCR_TEST_IMAGE;

if (!ref) {
  test.skip('реестр GHCR: нет GHCR_TEST_IMAGE', () => {});
} else {
  test('образ с тегом есть, с выдуманным тегом - нет', async () => {
    const [repo = '', tag = ''] = ref.split(':');
    const [owner = '', image = ''] = repo.split('/');
    const r = ghcrRegistry({ owner });
    expect(await r.exists(image, tag)).toBe(true);
    expect(await r.exists(image, 'no-such-tag-0')).toBe(false);
  });
}
