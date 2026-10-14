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

## Проверка

После "положил" фабрика проверяет только наличие файлов и делает пробные запросы на чтение (кто я, доступ к проекту, к репозиторию, к серверу), значения не печатаются.
