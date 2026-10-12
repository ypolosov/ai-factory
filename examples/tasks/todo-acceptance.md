Опиши сценарии изменения OpenSpec `add-todo-list` на Gherkin: `features/todo-list.feature` (`# language: ru`) - по сценарию Gherkin на каждый сценарий спецификации, с меткой пункта `@task-X.Y` по `test-plan.md`.

- Шаги - на TypeScript в `features/steps/*.steps.ts`; общий мир и HTTP-шаги уже есть в `features/steps/http.steps.ts`, его можно расширять.
- Шаги поднимают сервер `createServer()` из `src/server.ts` на свободном порту и проверяют HTTP-ответы.
- Проверь: `npm ci --ignore-scripts`, затем `npx cucumber-js --dry-run` - без неопределённых шагов, и `npx tsc --noEmit` - без ошибок. Сценарии ещё не сделанных пунктов падают на проверке ответа - так и должно быть.
