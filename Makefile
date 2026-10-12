.PHONY: check up smoke gateway-check down

SCRIPTS := scripts/lib.sh scripts/stand-up.sh scripts/smoke.sh scripts/gateway-check.sh \
	scripts/setup-repo.sh scripts/new-task.sh images/agent/factory-agent \
	images/agent/factory-publish images/agent/factory-untrusted images/agent/factory-role images/agent/factory-feedback images/agent/factory-tasks images/agent/factory-acceptance images/agent/factory-mutation images/reviewer/factory-gate images/deployer/deployer \
	scripts/deploy.sh scripts/rollback.sh scripts/rework.sh

check:
	shellcheck -x -P . $(SCRIPTS)
	shfmt -d $(SCRIPTS)
	docker compose config -q

up:
	./scripts/stand-up.sh

smoke:
	./scripts/smoke.sh

gateway-check:
	./scripts/gateway-check.sh

down:
	docker compose down
