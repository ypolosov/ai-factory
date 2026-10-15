// Шаблоны вывода фабрики: одна форма в похожих случаях - текст сверяется целиком.
import { describe, expect, it } from 'vitest';
import { PortError } from '../../ports/ports.ts';
import { failure, gatewayLibrarian } from '../bot.ts';
import { librarianText, taskBody, taskLine } from '../templates.ts';

const passages = [
  { source: 'docs/adr/ADR-3.md', title: 'ADR-3', url: 'https://x/adr3', text: 'Зерно одно.' },
  { source: 'README.md', title: 'README', url: 'https://x/readme', text: 'R6: подтвердить за 3 дня.' },
];

describe('шаблоны вывода фабрики', () => {
  it('задача: все разделы всегда на месте, пустые - "нет"', () => {
    const t = {
      title: 'Экран',
      goal: 'Показать невостребованный приз',
      scenarios: [{ name: 'виден', given: 'приз не подтверждён', when: 'организатор открывает розыгрыш', result: 'видит приз' }],
      outOfScope: [],
      basis: [],
    };
    expect(taskBody(t, 'Из стори DRAW-4.')).toBe(
      'Цель\nПоказать невостребованный приз\n\nСценарии приёмки\nСценарий: виден\n  Дано приз не подтверждён\n  Когда организатор открывает розыгрыш\n  Тогда видит приз\n\nВне рамок\n- нет\n\nОснования\n- нет\n\nОткуда\nИз стори DRAW-4.',
    );
    expect(taskLine(t, 2)).toBe('2. Экран - Показать невостребованный приз (сценариев приёмки: 1)');
  });

  it('библиотекарь: коротко, подробнее, источники; нет ответа - так и сказано', async () => {
    expect(librarianText({ found: true, short: 'Повтор берёт следующего кандидата [1].', details: ['Срок - 3 дня [2].'] }, passages)).toBe(
      'Коротко: Повтор берёт следующего кандидата [1].\nПодробнее:\n- Срок - 3 дня [2].\nИсточники:\n[1] ADR-3 - <https://x/adr3>\n[2] README - <https://x/readme>',
    );
    expect(librarianText({ found: false, short: 'что-то', details: ['x'] }, passages.slice(0, 1))).toBe(
      'Коротко: в знаниях проекта ответа нет.\nИсточники:\n[1] ADR-3 - <https://x/adr3>',
    );
    const lib = (reply: string) => gatewayLibrarian(async () => reply).answer('Как повторить?', passages);
    expect(await lib('{"found": true, "short": "По ADR-3 [1].", "details": []}')).toBe(
      'Коротко: По ADR-3 [1].\nИсточники:\n[1] ADR-3 - <https://x/adr3>\n[2] README - <https://x/readme>',
    );
    // Не по схеме - текст модели идёт в "коротко", форма та же.
    expect((await lib('Повтор по ADR-3 [1].')).split('\n')[0]).toBe('Коротко: Повтор по ADR-3 [1].');
  });

  it('сбой команды в чате - для человека, без ответа API', () => {
    expect(failure(new PortError('not_found', 'GET /pulls/999: 404 {...}'))).toBe('Не нашлось: проверьте номер задачи или PR в команде.');
    expect(failure(new PortError('unavailable', 'fetch failed'))).toBe('Сервис сейчас недоступен - повторите команду через минуту.');
    expect(failure(new Error('нарезка не вышла'))).toBe('Не вышло: нарезка не вышла');
  });
});
