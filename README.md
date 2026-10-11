# ai-factory

Шаблон открытой self-hosted фабрики ПО на ИИ: задача -> агент в песочнице -> PR -> проверки -> слияние человеком -> выкладка -> эксплуатация -> новые задачи. Фабрика как код: compose, настройки, скрипты. Только компоненты под лицензиями OSI.

**Статус:** стенд, этап 3 из 10. Работают git-хостинг Forgejo, три runner (агент, проверки, выкладка), шлюз моделей и путь "задача с меткой agent -> агент -> PR от бота -> проверки".

## Быстрый старт

Нужны Docker с Compose, `curl`, `jq`, `git`.

```sh
./scripts/stand-up.sh       # Forgejo, учётки, три runner, шлюз; повторный запуск безопасен
./scripts/smoke.sh          # пустышка с заданием на каждом runner должна пройти
./scripts/gateway-check.sh  # ключи шлюза, ограничения по моделям, открытая модель, учёт по задаче
./scripts/setup-repo.sh hello   # репозиторий из examples/hello: бот, защита main, метка agent, секреты
./scripts/new-task.sh hello "Приветствие hello world" examples/tasks/hello-world.md  # задача -> PR -> проверки
```

Forgejo: http://127.0.0.1:3000, вход `factory-admin`, пароль - в `.state/admin.password`.

Проверки репозитория: `make check` (shellcheck, shfmt, `docker compose config`).

## Устройство

| Компонент | Образ | Роль |
|---|---|---|
| `forgejo` | `codeberg.org/forgejo/forgejo:15.0.9` | git, задачи, PR, реестр, Actions |
| `runner-agent` + `agent-dind` | `code.forgejo.org/forgejo/runner:13.2.0`, `docker:29.9.0-dind` | задания агентов |
| `runner-ci` + `ci-dind` | те же | проверки |
| `runner-deploy` + `deploy-dind` | те же | выкладка на стенд |
| `gateway` | `cr.agentgateway.dev/agentgateway:v1.6.0` | шлюз моделей: ключи, бюджеты, журнал запросов |
| `*-loopback` | `alpine/socat:1.8.1.1` | в сети каждого dind пробрасывает `127.0.0.1:3000` к Forgejo: по этому адресу (ROOT_URL) Forgejo строит ссылки на артефакты и клоны |
| образ исполнителя `factory/agent:stand` | из `images/agent`, собирается в dind runner агента и проверок | Node 24, OpenCode, Codex CLI, Claude Code и скрипты контракта |

## Шлюз моделей

Адрес: http://127.0.0.1:4000 (OpenAI Chat и Responses, Anthropic Messages). Клиент предъявляет ключ шлюза в заголовке `x-gateway-key` и помечает задачу заголовком `x-task-id`: по нему в журнале шлюза (`.state/gateway-db/`, SQLite) копятся токены и цена.

Три ключа в `.state/`:

| Ключ | Модели | Бюджет |
|---|---|---|
| `gw-agent-api.key` | открытые: `default` (GLM-5.3-Flash), `hard` (GLM-5.3), `alt` (DeepSeek-V4.1-Flash) через OpenRouter | `GATEWAY_AGENT_DAILY_USD` в сутки, по умолчанию 2 доллара |
| `gw-agent-sub.key` | `claude-*` и `gpt-*` по подпискам владельца | без денежного бюджета: подписка с фиксированной ценой, шлюз пишет теневую цену |
| `gw-owner.key` | все | без бюджета |

Ключ провайдера открытых моделей кладётся так, чтобы не попасть в историю терминала, после чего шлюз перезапускается:

```sh
read -rs KEY && printf %s "$KEY" > .state/gateway/openrouter.key && unset KEY
docker compose restart gateway
```

Подписки (проверка вручную, нужны входы владельца на этой машине):

```sh
# Claude Code: вход по подписке остаётся, запросы идут через шлюз
ANTHROPIC_BASE_URL=http://127.0.0.1:4000 \
ANTHROPIC_CUSTOM_HEADERS="$(printf 'x-gateway-key: %s\nx-task-id: manual-1' "$(cat .state/gw-agent-sub.key)")" \
claude -p "Ответь одним словом: ok" --model claude-haiku-4-5

# Codex: свой провайдер со входом ChatGPT (встроенный openai переопределить нельзя)
codex exec --skip-git-repo-check -s read-only -c model_provider=gw \
  -c "model_providers.gw={name=\"gateway\",base_url=\"http://127.0.0.1:4000/v1\",wire_api=\"responses\",requires_openai_auth=true,http_headers={\"x-gateway-key\"=\"$(cat .state/gw-agent-sub.key)\",\"x-task-id\"=\"manual-2\"}}" \
  "Ответь одним словом: ok"
```

## Задача -> PR

Метка `agent` на задаче запускает `.forgejo/workflows/agent.yml` целевого репозитория (шаблон - `examples/hello`):

1. `implement` (runner агента): рабочая копия, текст задачи как недоверенный ввод (через переменные окружения и файл, не подстановкой в команду), `factory-agent` запускает выбранную обвязку. У агента есть ключ шлюза своей роли и нет права записи в git. Патч, `run.json` и журнал уходят артефактом.
2. `publish` (runner проверок): ключа модели нет, токен бота есть. `factory-publish` отклоняет пустой патч, правки `.forgejo/` и `.github/` (и переименования туда), патч больше 3000 строк или 1 МБ; иначе - ветка `agent/issue-N` и PR "Closes #N".
3. PR запускает `ci.yml`: тесты проекта. Ветку `main` пишет и сливает только человек и только при зелёной проверке `ci / test`.

Контракт исполнителя (`images/agent/factory-agent`): вход - рабочая копия, текст задачи, `FACTORY_EXECUTOR` (`opencode`, `claude`, `codex`), `FACTORY_MODEL`, адрес и ключ шлюза, номер задачи для учёта; выход - `agent.patch`, `run.json`, `agent.log` и код возврата. Исполнитель и модель - переменные репозитория: `setup-repo.sh ИМЯ [исполнитель] [модель]`. Повторный запуск `setup-repo.sh` приводит `.forgejo/` репозитория к шаблону, код проекта не трогает.

Недоверенный код - обвязка агента и тесты из PR - работает через `factory-untrusted`: от пользователя `node` и только с переменными окружения из списка. По документации Forgejo каждый шаг задания получает автоматический токен задания (`FORGEJO_TOKEN`, `GITHUB_TOKEN`); недоверенному коду он не достаётся, фоновые процессы недоверенного кода завершаются вместе с ним.

## Решения безопасности

- порты Forgejo и шлюза публикуются только на `127.0.0.1`;
- Docker API каждого dind - только unix-сокет в общем томе с его runner; контейнеры заданий его не видят (`docker_host: "-"`), по сети dockerd не слушает;
- общий кэш Actions выключен; задания запускаются без privileged;
- ключ провайдера знает только шлюз; в настройках шлюза лежат хэши ключей, а не ключи;
- секреты - в `.state/` (в git не попадает), в командную строку не передаются;
- в контейнеры монтируются каталоги, а не одиночные файлы: Docker Desktop теряет смонтированный файл, если его заменить;
- агент и тесты из PR работают от непривилегированного пользователя без токена задания; токен записи есть только у задания публикации, а у него нет ключа модели;
- `main` защищена: бот не пишет в неё и не сливает PR.

## Что ещё не закрыто

- исходящая сеть заданий не ограничена: агент может унести ключ шлюза своей роли (его ограничивает бюджет);
- агент может ослабить проверки в коде проекта (например, сценарий `test` в `package.json`); сейчас это ловит только человек на ревью;
- исполнители Claude Code и Codex в заданиях не проверены: нужны токены подписок владельца.

## Лицензия

Apache-2.0.
