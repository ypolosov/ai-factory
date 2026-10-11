.PHONY: check up smoke down

SCRIPTS := scripts/lib.sh scripts/stand-up.sh scripts/smoke.sh

check:
	shellcheck -x -P . $(SCRIPTS)
	shfmt -d scripts/
	docker compose config -q

up:
	./scripts/stand-up.sh

smoke:
	./scripts/smoke.sh

down:
	docker compose down
