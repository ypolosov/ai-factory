# Платформы демо: учётки и токены

Стадия 2 из [architecture.md](architecture.md). Токены живут только в `.state/` (каталог не попадает в git), права на файлы - 600. В чат и в аргументы команд токены не попадают. Сроки жизни токенов - не больше года; напоминание о продлении - в календаре.

Создать пустой файл с правильными правами и открыть его в редакторе:

```sh
install -m 600 /dev/null .state/atlassian.env
```

## Jira и Confluence

1. Создать проект Jira "Розыгрыш призов" с ключом `DRAW` (шаблон Scrum) и пространство Confluence с ключом `DRAW`.
2. На https://id.atlassian.com/manage-profile/security/api-tokens выбрать "Create API token with scopes" - два токена, по одному на продукт (у токена с областями один продукт):
   - `factory-jira`: продукт Jira; области `read:jira-work`, `write:jira-work`, `read:jira-user`;
   - `factory-confluence`: продукт Confluence; области `read:confluence-content.all`, `read:confluence-space.summary`, `write:confluence-content`, `search:confluence`.
   Токен с областями ходит через `api.atlassian.com` по идентификатору сайта (cloudId); фабрика узнаёт его сама.
3. `.state/atlassian.env`:

```sh
ATLASSIAN_SITE=https://<сайт>.atlassian.net
ATLASSIAN_EMAIL=<почта учётки>
JIRA_API_TOKEN=<factory-jira>
CONFLUENCE_API_TOKEN=<factory-confluence>
JIRA_PROJECT=DRAW
CONFLUENCE_SPACE=DRAW
```

## Bitbucket (платформа фабрики)

1. В рабочем пространстве создать репозиторий `factory` (можно закрытый) и включить Pipelines: Repository settings -> Pipelines -> Settings -> Enable Pipelines.
2. Токен репозитория: Repository settings -> Security -> Access tokens -> Create. Имя `factory-coordinator`, права: Repositories - Read, Write; Pull requests - Read; Pipelines - Read, Write, Edit variables; Runners - Read. Если пункта Access tokens нет, взять API-токен с областями для Bitbucket на id.atlassian.com (`read:repository:bitbucket`, `write:repository:bitbucket`, `read:pipeline:bitbucket`, `write:pipeline:bitbucket`, `read:runner:bitbucket`). Пароли приложений Bitbucket выведены из работы.
3. Свой раннер: Repository settings -> Pipelines -> Runners -> Add runner -> Linux Docker (x86_64), имя `laptop`, метка `factory`. Показанную команду **не запускать**: она даёт раннеру Docker хоста. Из неё переписать значения в `.state/bitbucket-runner.env`; фабрика запустит раннер в отдельном Docker заданий.
4. Файлы:

```sh
# .state/bitbucket.env
BITBUCKET_WORKSPACE=<рабочее пространство>
BITBUCKET_REPO=factory
BITBUCKET_TOKEN=<factory-coordinator>

# .state/bitbucket-runner.env - значения из команды добавления раннера
ACCOUNT_UUID={...}
REPOSITORY_UUID={...}
RUNNER_UUID={...}
OAUTH_CLIENT_ID=...
OAUTH_CLIENT_SECRET=...
```

Запуск раннера на стенде и проверка (сделано 14.10.2026, пустой шаг `hello` прошёл за 7 с):

```sh
docker compose --profile bitbucket up -d          # bb-dind, bb-registry, bb-runner
scripts/bb-images.sh docker.io/library/alpine:3.24  # образы шагов - в свой реестр
scripts/bb-commit.sh "сообщение" ФАЙЛ bitbucket-pipelines.yml
scripts/bb-api.sh POST /pipelines/ ТЕЛО.json        # запуск задания
```

Устройство: шаги идут в отдельном Docker (`bb-dind`) во внутренней сети `bb-jobs`, наружу - только через прокси egress по адресу 172.31.250.10 (в allowlist - домены Bitbucket и Atlassian и реестр служебных образов раннера). Раннер всегда скачивает образ шага, поэтому образы шагов лежат в своём реестре `172.31.250.20:5000`. Рабочий каталог раннера - `/bb-work`, не под `/tmp`: скрипт dind монтирует на `/tmp` свой tmpfs. Сам раннер ещё и в сети фабрики: его клиент входа ходит на auth.atlassian.com мимо прокси.

## GitHub (платформа цели)

Репозиторий цели: https://github.com/ypolosov/prize-draw, открытый - Actions без лимита минут, образы GHCR открытые, выкладке не нужен токен реестра.

Два токена (fine-grained) на https://github.com/settings/personal-access-tokens/new, владелец `ypolosov`, срок 90 дней, Repository access - Only select repositories - `prize-draw`:

- `factory-read` - для шагов агента: Contents, Pull requests, Commit statuses, Actions - Read-only;
- `factory-publish` - для шага публикации: Contents, Pull requests, Commit statuses - Read and write; Actions - Read-only. Workflows - **No access**: фабрика не может менять CI цели, это делают только люди.

```sh
# .state/github-target.env
GITHUB_TARGET_REPO=ypolosov/prize-draw
GITHUB_READ_TOKEN=<factory-read>
GITHUB_PUBLISH_TOKEN=<factory-publish>
```

## Discord

1. Сервер команды с каналами `#продукт`, `#разработка`, `#эксплуатация`, `#релизы`, `#розыгрыши`.
2. User Settings -> Advanced -> Developer Mode; правый клик по серверу -> Copy Server ID.
3. https://discord.com/developers/applications -> New Application `Factory`:
   - General Information -> Application ID;
   - Bot -> Reset Token -> скопировать токен; Public Bot - выключить; Privileged Gateway Intents - включить Message Content Intent (библиотекарь читает каналы для базы знаний).
4. OAuth2 -> URL Generator: scopes `bot` и `applications.commands`; права бота - View Channels, Send Messages, Send Messages in Threads, Read Message History, Embed Links, Attach Files. Открыть ссылку, выбрать сервер, Authorize.
5. Вебхук приложения (объявление победителей): канал `#розыгрыши` -> Edit Channel -> Integrations -> Webhooks -> New Webhook -> Copy Webhook URL.

```sh
# .state/discord.env
DISCORD_APPLICATION_ID=...
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=...
DISCORD_DRAW_WEBHOOK_URL=...
```

## Figma (шаг дизайнера)

Бесплатного плана хватит, если не гонять API: чтение файла бесплатной команды через REST - до 6-20 запросов в месяц на основные методы, MCP Figma - 20 вызовов в месяц. Поэтому макет выгружается картинкой один раз на версию, и сверка идёт с картинкой. Лимиты считаются по команде, которой принадлежит файл.

Токен: Figma -> Settings -> Security -> Personal access tokens -> Generate new token, срок 90 дней, область File content - Read-only.

```sh
# .state/figma.env
FIGMA_TOKEN=...
FIGMA_FILE_KEY=<из адреса figma.com/design/<KEY>/...>
```

## Координатор: задача Jira -> PR

Сквозной путь демо (стадия 3): задача DRAW с меткой `agent` -> координатор на Mastra core -> задание `agent-task` на своём раннере Bitbucket -> агент по подписке -> PR в `prize-draw` со статусом стража `factory/verdict`.

```sh
scripts/demo-up.sh             # учётки, образ агента в реестр шагов, шлюз, координатор и выкладка цели
docker compose --profile bitbucket logs -f coordinator
```

- Метки задачи: `agent` - отдать агенту; `agent-running` - агент работает; `agent-review` - PR открыт, решает человек; `agent-failed` - агент или страж не дали результата (причина - в комментарии).
- Bitbucket получает только адрес посредника координатора (172.31.250.40:8080, сеть шагов) и разовый ключ запуска - скрытую переменную `RUN_TOKEN`. Задачу, рабочую копию цели (git bundle) и ключи подписки и шлюза шаг `factory-job` берёт у посредника, итог сдаёт туда же. Токены GitHub и вход подписки на Atlassian не уходят.
- Публикует координатор: ветка `agent/<запуск>`, PR, статус `factory/verdict`, комментарий с вердиктом. Шаг агента писать в цель не может: токенов записи у него нет, а GitHub не в allowlist прокси шагов.
- Страж до публикации: пустой патч, изменение `.github/`, `.factory/`, файлов CI и символические ссылки не публикуются; большой патч или сбой агента - PR с красным вердиктом.
- Страж требует от цели объявленных команд линтера и форматирования (`checks.lint`, `checks.format` в `.factory/config.yml`); файлы блокировки зависимостей в размер патча не входят.
- Выкладка цели (служба `cd`): CI цели после зелёных проверок публикует образы коммита main в GHCR, служба забирает их и `compose.yaml` этого коммита и поднимает систему в Docker выкладки стенда - http://127.0.0.1:8082; итог - статус `factory/deploy` на коммите.
- Сверка требований (UC1): задача DRAW с меткой `story` -> поиск по знанию цели (README, AGENTS.md, `docs/**/*.md` ветки по умолчанию; ссылки - на коммит) -> судья через шлюз (`kb-claude-cli`, подписка) -> противоречие: комментарий с цитатами и ссылками, задача на решение с меткой `decision` (стори зависит от неё), сообщение в Discord, метка `needs-decision`; закрытие задачи запускает повторную сверку с обновлённым знанием -> `story-ok` или "противоречие осталось". Без противоречий - сразу `story-ok`.
- Страж всех PR цели: PR из любого экзокортекса без вердикта фабрики на голове получает тот же `factory/verdict` и комментарий.
- MCP фабрики для экзокортексов (Claude Code, Codex): `http://127.0.0.1:4100/mcp`, инструменты `kb_search`, `check_requirement`, `factory_rules`, `submit_task`. Подключение Claude Code: `claude mcp add --transport http ai-factory http://127.0.0.1:4100/mcp --header "Authorization: Bearer $(cat .state/coordinator/mcp.token)"`.
- Источник `bitbucket-pipelines.yml` - `config/bitbucket/`; в Bitbucket его кладёт `scripts/bb-commit.sh`.

## Проверка

После "положил" фабрика проверяет только наличие файлов и делает пробные запросы на чтение (кто я, доступ к проекту, к репозиторию, к серверу), значения не печатаются.
