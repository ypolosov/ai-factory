Обнови изменение OpenSpec `add-todo-list` под решение владельца: код - на TypeScript, приёмочные сценарии - на Gherkin.

- В design.md, tasks.md и test-plan.md пути модулей и тестов - TypeScript: `src/todos.ts`, `src/page.ts`, `src/server.ts`, модульные тесты `test/*.test.ts`. Node 24 запускает `.ts` без сборки; синтаксис только стираемый (`erasableSyntaxOnly`), импорты - с расширением `.ts`.
- В test-plan.md приёмочные проверки - сценарии Gherkin в `features/<возможность>.feature` на русском с меткой пункта `@task-X.Y`, а не файлы `tests/acceptance/*.test.js`. В tasks.md признак готовности пункта - "проходят сценарии `@task-X.Y` и модульные тесты".
- Добавь в design.md решение (ADR) о TypeScript со стиранием типов и о сценариях Gherkin как исполняемой спецификации.
- Требования в specs по поведению не меняй.
