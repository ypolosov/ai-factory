.PHONY: check up smoke gateway-check down

SCRIPTS := scripts/lib.sh scripts/stand-up.sh scripts/smoke.sh scripts/gateway-check.sh

check:
	shellcheck -x -P . $(SCRIPTS)
	shfmt -d scripts/
	docker compose config -q

up:
	./scripts/stand-up.sh

smoke:
	./scripts/smoke.sh

gateway-check:
	./scripts/gateway-check.sh

down:
	docker compose down
