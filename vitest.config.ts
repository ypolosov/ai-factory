// Тесты кода фабрики (системы создания): модульные и контрактные. Целевые системы
// выбирают свой стек тестов сами.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['images/*/test/*.test.ts'],
    environment: 'node',
    // Контракты на живых носителях ходят в сеть: отдельный запрос - до нескольких секунд.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Координатор на Mastra core: телеметрия выключена и в тестах.
    env: { MASTRA_TELEMETRY_DISABLED: '1' },
  },
});
