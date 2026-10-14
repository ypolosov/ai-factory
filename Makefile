.PHONY: check test fmt contract contract-saas diagrams platforms-check up smoke gateway-check down

SCRIPTS := scripts/lib.sh scripts/stand-up.sh scripts/smoke.sh scripts/gateway-check.sh \
	scripts/setup-repo.sh scripts/new-task.sh images/agent/factory-agent \
	images/agent/factory-publish images/agent/factory-untrusted images/agent/factory-role images/agent/factory-feedback images/agent/factory-tasks images/agent/factory-acceptance images/agent/factory-mutation images/agent/factory-npm-ci images/agent/factory-pr-comment images/agent/factory-gate images/agent/factory-judge images/agent/factory-deps images/agent/factory-reconcile images/portal/portal.sh images/deployer/deployer \
	scripts/deploy.sh scripts/rollback.sh scripts/rework.sh scripts/task-report.sh scripts/kb-up.sh scripts/kb-setup.sh scripts/kb-model.sh scripts/kb-ask.sh scripts/factory-report.sh scripts/demo.sh scripts/port-contract.sh scripts/platforms-check.sh scripts/bb-api.sh scripts/bb-commit.sh scripts/bb-images.sh scripts/jira-api.sh scripts/port-contract-saas.sh

check:
	shellcheck -x -P . $(SCRIPTS)
	shfmt -d $(SCRIPTS)
	docker compose config -q

# Код фабрики на TypeScript в Node 24 стенда: типы (tsc), стиль и линтер (Biome),
# архитектура (dependency-cruiser), модульные тесты (Vitest).
test:
	docker run --rm -u "$$(id -u):$$(id -g)" -e HOME=/tmp -v "$$PWD":/w -w /w \
		docker.io/library/node:24.21.0-alpine3.24 sh -c 'npm ci --no-audit --no-fund --silent && npx tsc --noEmit && npx biome ci && npx depcruise --config .dependency-cruiser.cjs images && npm test'

# Форматирование и безопасные исправления линтера Biome.
fmt:
	docker run --rm -u "$$(id -u):$$(id -g)" -e HOME=/tmp -v "$$PWD":/w -w /w \
		docker.io/library/node:24.21.0-alpine3.24 sh -c 'npm ci --no-audit --no-fund --silent && npx biome check --write'

# Контракты портов на живом носителе (одноразовый Forgejo в Docker).
contract:
	./scripts/port-contract.sh

# Контракты портов на облачных носителях: песочницы Jira (FCT) и GitHub (factory-contract-tests).
contract-saas:
	./scripts/port-contract-saas.sh

# Диаграммы демо: PlantUML и C4-PlantUML -> PNG рядом с исходниками.
DIAGRAMS := $(notdir $(filter-out %/common.puml %/common-uml.puml,$(wildcard docs/demo/diagrams/*.puml)))
diagrams:
	docker run --rm -u "$$(id -u):$$(id -g)" -v "$$PWD/docs/demo/diagrams":/data -w /data \
		docker.io/plantuml/plantuml:1.2026.8 -tpng -charset UTF-8 $(DIAGRAMS)

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
