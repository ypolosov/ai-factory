.PHONY: check test up smoke gateway-check down

SCRIPTS := scripts/lib.sh scripts/stand-up.sh scripts/smoke.sh scripts/gateway-check.sh \
	scripts/setup-repo.sh scripts/new-task.sh images/agent/factory-agent \
	images/agent/factory-publish images/agent/factory-untrusted images/agent/factory-role images/agent/factory-feedback images/agent/factory-tasks images/agent/factory-acceptance images/agent/factory-mutation images/agent/factory-npm-ci images/agent/factory-pr-comment images/agent/factory-gate images/agent/factory-judge images/agent/factory-deps images/deployer/deployer \
	scripts/deploy.sh scripts/rollback.sh scripts/rework.sh scripts/task-report.sh

check:
	shellcheck -x -P . $(SCRIPTS)
	shfmt -d $(SCRIPTS)
	docker compose config -q

# Код фабрики на TypeScript: проверка типов и модульные тесты в Node 24 стенда.
test:
	docker run --rm -u "$$(id -u):$$(id -g)" -e HOME=/tmp -v "$$PWD":/w -w /w \
		docker.io/library/node:24.21.0-alpine3.24 sh -c 'npm ci --no-audit --no-fund --silent && npx tsc --noEmit && npm test'

up:
	./scripts/stand-up.sh

smoke:
	./scripts/smoke.sh

gateway-check:
	./scripts/gateway-check.sh

down:
	docker compose down
