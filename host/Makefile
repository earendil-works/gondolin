.PHONY: build typecheck lint test format clean

PNPM ?= pnpm
RUN_PARALLEL ?= ../scripts/run-parallel

build:
	@$(PNPM) run build

typecheck:
	@$(PNPM) exec tsc -p tsconfig.json --noEmit

lint: typecheck

format:
	@echo "No formatter configured for host"

test:
	@$(RUN_PARALLEL) -j 1 \
		"host:test" "$(PNPM) run test"

clean:
	@rm -rf dist
