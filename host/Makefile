.PHONY: build typecheck lint test format clean fuzz

PNPM ?= pnpm
NODE ?= node
RUN_PARALLEL ?= ../scripts/run-parallel
PRETTIER ?= ../node_modules/.bin/prettier

# Host fuzzer target name (see host/fuzz/targets)
TARGET ?= virtio

build:
	@$(PNPM) run build

typecheck:
	@$(PNPM) exec tsc -p tsconfig.json --noEmit

lint: typecheck

format:
	@$(PRETTIER) --write --ignore-unknown --no-error-on-unmatched-pattern \
		"src/**/*.ts" \
		"bin/**/*.ts" \
		"test/**/*.ts" \
		"fuzz/**/*.ts" \
		"examples/**/*.ts" \
		"package.json" \
		"tsconfig.json" \
		"README.md"

test:
	@$(RUN_PARALLEL) -j 1 \
		"host:test" "$(NODE) --test test/*.test.ts"

fuzz:
	@$(PNPM) run fuzz -- $(TARGET)

clean:
	@rm -rf dist
