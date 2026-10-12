# Правила для агентов

Todo list на TypeScript и Node 24: сервер на `node:http`, страница рисуется на сервере, данные в памяти процесса. Node запускает `.ts` сам, без сборки.

## Работа по фазам

Роли, их исполнители и разрешённые пути - в `.factory/config.yml`; чужие пути отклоняют ворота публикации.

- **spec** - изменение OpenSpec в `openspec/changes/<имя>/` по схеме `factory`: замысел, требования со сценариями, архитектурные решения, задачи, план проверки. Утверждает человек слиянием PR.
- **tests** - приёмочные сценарии на Gherkin до разработки: `features/<возможность>.feature` (`# language: ru`), у каждого сценария метка пункта `@task-X.Y`; шаги - `features/steps/*.steps.ts`.
- **dev** - один пункт `tasks.md` - один PR. Сценарии пункта (`@task-X.Y`) должны пройти; `features/` не менять.
- Ревью и слияние - проверки PR и человек.

Живые спецификации - `openspec/specs/`, изменения - `openspec/changes/`. CLI: `openspec list`, `openspec show <имя>`, `openspec validate <имя> --strict`.

## Код

- TypeScript только со стираемым синтаксисом (`erasableSyntaxOnly`): без `enum`, `namespace` и свойств в параметрах конструктора. Импорты - с расширением `.ts`.
- Код - в `src/`, модульные тесты - `test/<модуль>.test.ts` на `node:test`.
- Проверки: `npm ci --ignore-scripts`, затем `node --test "test/**/*.test.ts"`, `npx tsc --noEmit`, `npx cucumber-js --tags "@always or @task-X.Y"`.
- Сервер - `src/server.ts`: экспорт `createServer()`, порт из `PORT` (по умолчанию 8080), `GET /health` - 200 и `ok`. Так приложение собирает и выкладывает фабрика.
- Зависимостей для работы приложения нет; для разработки - только из `devDependencies`. Сеть наружу - только npm, через прокси фабрики.
