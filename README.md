# ai-factory

Шаблон открытой self-hosted фабрики ПО на ИИ: задача -> агент в песочнице -> PR -> проверки -> слияние человеком -> выкладка -> эксплуатация -> новые задачи. Фабрика как код: compose, настройки, скрипты. Только компоненты под лицензиями OSI.

**Статус:** стенд, сборка С1, этап 1 из 10. Работает ядро: git-хостинг Forgejo и три runner (агент, проверки, выкладка), у каждого свой Docker-in-Docker.

## Быстрый старт

Нужны Docker с Compose, `curl`, `jq`, `git`.

```sh
./scripts/stand-up.sh   # Forgejo, администратор, бот, три runner; повторный запуск безопасен
./scripts/smoke.sh      # пустышка с заданием на каждом runner должна пройти
```

Forgejo: http://127.0.0.1:3000, вход `factory-admin`, пароль - в `.state/admin.password`.

Проверки репозитория: `make check` (shellcheck, shfmt, `docker compose config`).

## Устройство ядра

| Компонент | Образ | Роль |
|---|---|---|
| `forgejo` | `codeberg.org/forgejo/forgejo:15.0.9` | git, задачи, PR, реестр, Actions |
| `runner-agent` + `agent-dind` | `code.forgejo.org/forgejo/runner:13.2.0`, `docker:29.9.0-dind` | задания агентов |
| `runner-ci` + `ci-dind` | те же | проверки |
| `runner-deploy` + `deploy-dind` | те же | выкладка на стенд |

Решения безопасности:
- порт Forgejo публикуется только на `127.0.0.1`;
- Docker API каждого dind - только unix-сокет в общем томе с его runner; контейнеры заданий его не видят (`docker_host: "-"`), по сети dockerd не слушает;
- общий кэш Actions выключен;
- задания запускаются без privileged;
- секреты и токены - в `.state/` (в git не попадает), в командную строку не передаются.

## Лицензия

Apache-2.0.
