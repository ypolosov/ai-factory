.PHONY: check test fmt contract contract-saas diagrams platforms-check up smoke gateway-check down

SCRIPTS := scripts/lib.sh scripts/stand-up.sh scripts/smoke.sh scripts/gateway-check.sh \
	scripts/setup-repo.sh scripts/new-task.sh images/agent/factory-agent \
	images/agent/factory-publish images/agent/factory-untrusted images/agent/factory-role images/agent/factory-feedback images/agent/factory-tasks images/agent/factory-acceptance images/agent/factory-mutation images/agent/factory-npm-ci images/agent/factory-pr-comment images/agent/factory-gate images/agent/factory-judge images/agent/factory-deps images/agent/factory-scan images/agent/factory-test-first images/agent/factory-utf8-head images/agent/factory-reconcile images/agent/factory-job images/agent/factory-design images/portal/portal.sh images/deployer/deployer \
	scripts/deploy.sh scripts/rollback.sh scripts/rework.sh scripts/task-report.sh scripts/kb-up.sh scripts/kb-setup.sh scripts/kb-model.sh scripts/kb-ask.sh scripts/factory-report.sh scripts/demo.sh scripts/port-contract.sh scripts/platforms-check.sh scripts/bb-api.sh scripts/bb-commit.sh scripts/bb-images.sh scripts/jira-api.sh scripts/port-contract-saas.sh scripts/demo-up.sh scripts/persona.sh scripts/persona-bot-add.sh scripts/persona-atlassian-add.sh scripts/persona-github-app-add.sh scripts/film-webhook-add.sh scripts/demo-reset.sh scripts/demo-cut.sh scripts/demo-film.sh images/cd/factory-cd

check:
	shellcheck -x -P . $(SCRIPTS)
	shfmt -d $(SCRIPTS)
	docker compose config -q

# Код фабрики на TypeScript в Node 24 стенда: типы (tsc), стиль и линтер (Biome),
# архитектура (dependency-cruiser), модульные тесты (Vitest). Образ с git: тесты координатора
# публикуют в настоящий репозиторий на диске. Зависимости координатора ставятся отдельно.
test:
	docker run --rm -u "$$(id -u):$$(id -g)" -e HOME=/tmp -v "$$PWD":/w -w /w \
		docker.io/library/node:24.21.0-bookworm sh -c 'npm ci --no-audit --no-fund --silent && npm ci --prefix images/coordinator --no-audit --no-fund --silent && npm ci --prefix images/camera --no-audit --no-fund --silent && npx tsc --noEmit && npx biome ci && npx depcruise --config .dependency-cruiser.cjs images && npm test'

# Форматирование и безопасные исправления линтера Biome.
fmt:
	docker run --rm -u "$$(id -u):$$(id -g)" -e HOME=/tmp -v "$$PWD":/w -w /w \
		docker.io/library/node:24.21.0-bookworm sh -c 'npm ci --no-audit --no-fund --silent && npx biome check --write'

# Контракты портов на живом носителе (одноразовый Forgejo в Docker).
contract:
	./scripts/port-contract.sh

# Контракты портов на облачных носителях: песочницы Jira (FCT) и GitHub (factory-contract-tests).
contract-saas:
	./scripts/port-contract-saas.sh

# Диаграммы: PlantUML и C4-PlantUML -> PNG рядом с исходниками (docs/*/diagrams). Монтируется
# весь docs/: диаграммы разделов подключают общий стиль из docs/demo/diagrams.
DIAGRAM_DIRS := $(patsubst docs/%,%,$(wildcard docs/*/diagrams))
diagrams:
	for d in $(DIAGRAM_DIRS); do \
		docker run --rm -u "$$(id -u):$$(id -g)" -v "$$PWD/docs":/data -w "/data/$$d" \
			docker.io/plantuml/plantuml:1.2026.8 -tpng -charset UTF-8 \
			$$(cd "docs/$$d" && ls *.puml | grep -v '^common') || exit 1; \
	done

# Учётки и токены платформ демо (docs/demo/platforms.md): наличие и чтение, без печати значений.
platforms-check:
	./scripts/platforms-check.sh

up:
	./scripts/stand-up.sh

smoke:
	./scripts/smoke.sh

gateway-check:
	./scripts/gateway-check.sh

down:
	docker compose down
