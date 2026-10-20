// Страж архитектуры кода фабрики (fitness functions): правила зависимостей между модулями.
// Запуск - в make test: npx depcruise --config .dependency-cruiser.cjs images
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Циклы между модулями запрещены.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'ports-only-through-composition-root',
      severity: 'error',
      comment:
        'Адаптеры носителей (Forgejo, Jira, GitHub, Bitbucket, документы в git, Discord, Confluence, GHCR, GlitchTip, Figma) подключают только тесты портов и место сборки ' +
        'images/ports/select.ts; остальной код знает только контракты из ports.ts.',
      from: { pathNot: ['^images/ports/test/', '^images/ports/select[.]ts$'] },
      to: { path: '^images/ports/(forgejo|jira|github|bitbucket|gitdocs|discord|confluence|ghcr|glitchtip|figma|plantuml|miro)[.]ts$' },
    },
    {
      name: 'images-are-independent',
      severity: 'error',
      comment:
        'Образ собирается из своего каталога: код одного образа не импортирует код другого; ' + 'общий код - только контракты портов.',
      from: { path: '^images/([^/]+)/' },
      to: { path: '^images/', pathNot: ['^images/$1/', '^images/ports/'] },
    },
    {
      name: 'no-test-code-in-production',
      severity: 'error',
      comment: 'Рабочий код не импортирует тестовый.',
      from: { pathNot: '/test/' },
      to: { path: '/test/' },
    },
    {
      name: 'no-runtime-dependencies',
      severity: 'error',
      comment:
        'Код фабрики работает без зависимостей (AGENTS.md): в рабочем коде - только модули Node. ' +
        'Исключения - служба координатора на Mastra core и камера видео-демо на Playwright.',
      from: { path: '^images/', pathNot: ['/test/', '^images/coordinator/'] },
      to: { dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Импорт должен разрешаться в существующий модуль.',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^images/[^/]+/node_modules/' },
    // TypeScript 7 ещё не даёт API для разбора, поэтому TS читает swc.
    parser: 'swc',
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    // Подпути пакетов (@mastra/core/workflows) - через поле exports.
    enhancedResolveOptions: { extensions: ['.ts', '.js'], exportsFields: ['exports'], conditionNames: ['import', 'node', 'default'] },
  },
};
