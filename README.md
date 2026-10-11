# ai-factory

Шаблон открытой self-hosted фабрики ПО на ИИ: задача -> агент в песочнице -> PR -> проверки -> слияние человеком -> выкладка -> эксплуатация -> новые задачи. Фабрика как код: compose, настройки, скрипты. Только компоненты под лицензиями OSI.

**Статус:** стенд, этап 2 из 10. Работают git-хостинг Forgejo, три runner (агент, проверки, выкладка) и шлюз моделей.

## Быстрый старт

Нужны Docker с Compose, `curl`, `jq`, `git`.

```sh
./scripts/stand-up.sh       # Forgejo, учётки, три runner, шлюз; повторный запуск безопасен
./scripts/smoke.sh          # пустышка с заданием на каждом runner должна пройти
./scripts/gateway-check.sh  # ключи шлюза, ограничения по моделям, открытая модель, учёт по задаче
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

## Решения безопасности

- порты Forgejo и шлюза публикуются только на `127.0.0.1`;
- Docker API каждого dind - только unix-сокет в общем томе с его runner; контейнеры заданий его не видят (`docker_host: "-"`), по сети dockerd не слушает;
- общий кэш Actions выключен; задания запускаются без privileged;
- ключ провайдера знает только шлюз; в настройках шлюза лежат хэши ключей, а не ключи;
- секреты - в `.state/` (в git не попадает), в командную строку не передаются;
- в контейнеры монтируются каталоги, а не одиночные файлы: Docker Desktop теряет смонтированный файл, если его заменить.

## Лицензия

Apache-2.0.
