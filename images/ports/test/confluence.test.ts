// Контракт вики на живом Confluence: пространство демо, страницы проверки удаляются после.
// Запуск - scripts/port-contract-saas.sh confluence; без CONFLUENCE_TEST_* - пропуск.
import { describe, expect, it, test } from 'vitest';
import { confluenceWiki, fromStorage, toStorage } from '../confluence.ts';
import { wikiContract } from './contract.ts';

const site = process.env.CONFLUENCE_TEST_SITE;
const email = process.env.CONFLUENCE_TEST_EMAIL;
const token = process.env.CONFLUENCE_TEST_TOKEN;
const space = process.env.CONFLUENCE_TEST_SPACE;

describe('формат страницы Confluence', () => {
  it('заголовки, списки, ссылки и обратно в текст', () => {
    const html = toStorage('## Выпуск\n- DRAW-1 <тег> https://x.y/1\nабзац');
    expect(html).toBe('<h2>Выпуск</h2><ul><li>DRAW-1 &lt;тег&gt; <a href="https://x.y/1">https://x.y/1</a></li></ul><p>абзац</p>');
    expect(fromStorage(html)).toBe('Выпуск\nDRAW-1 <тег> https://x.y/1\nабзац');
  });
});

if (!site || !email || !token || !space) {
  test.skip('контракт Confluence: нет CONFLUENCE_TEST_SITE, _EMAIL, _TOKEN, _SPACE', () => {});
} else {
  wikiContract('Confluence', async () => {
    const wiki = confluenceWiki({ site, email, token, space });
    const made = new Set<string>();
    const upsert = wiki.upsertPage.bind(wiki);
    wiki.upsertPage = async (title, body) => {
      const p = await upsert(title, body);
      made.add(p.id);
      return p;
    };
    return {
      wiki,
      cleanup: async () => {
        const cloud = ((await (await fetch(`${site}/_edge/tenant_info`)).json()) as { cloudId: string }).cloudId;
        const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
        for (const id of made) {
          await fetch(`https://api.atlassian.com/ex/confluence/${cloud}/wiki/rest/api/content/${id}`, {
            method: 'DELETE',
            headers: { authorization: auth },
          });
        }
      },
    };
  });
}

describe('формат хранения: руководство', () => {
  it('заголовки, нумерованный список, таблица, код и жирный', () => {
    const html = toStorage(
      '# Руководство\n### Роль\n**Как сделать**\n1. набрать `!дейли`\n2. ждать\n\n| Команда | Что |\n|---|---|\n| `!ci [N]` | перезапуск \\| CI |\n- пункт',
    );
    expect(html).toBe(
      '<h1>Руководство</h1><h3>Роль</h3><p><strong>Как сделать</strong></p><ol><li>набрать <code>!дейли</code></li><li>ждать</li></ol>' +
        '<table><tbody><tr><th>Команда</th><th>Что</th></tr><tr><td><code>!ci [N]</code></td><td>перезапуск | CI</td></tr></tbody></table>' +
        '<ul><li>пункт</li></ul>',
    );
  });
});

describe('формат хранения: ссылки', () => {
  it('точка в конце адреса - не часть ссылки; адрес в коде - не ссылка', () => {
    expect(toStorage('GlitchTip http://127.0.0.1:8200. и `http://127.0.0.1:4100/mcp`')).toBe(
      '<p>GlitchTip <a href="http://127.0.0.1:8200">http://127.0.0.1:8200</a>. и <code>http://127.0.0.1:4100/mcp</code></p>',
    );
  });
});
