.PHONY: help lint typecheck build test check format fix clean hooks docs serve-docs

RUN_PARALLEL ?= ./scripts/run-parallel

help:
	@echo "Available commands:"
	@echo "  make build       - Build guest + host"
	@echo "  make lint        - Run linters"
	@echo "  make typecheck   - Run type checks"
	@echo "  make check       - Run lint + typecheck"
	@echo "  make test        - Run tests"
	@echo "  make format      - Format code"
	@echo "  make fix         - Alias for format"
	@echo "  make clean       - Clean build artifacts"
	@echo "  make docs        - Build documentation site (Zensical)"
	@echo "  make serve-docs  - Serve documentation locally (Zensical)"
	@echo "  make hooks       - Install git hooks"

build:
	@$(RUN_PARALLEL) -j 2 \
		"guest:build" "$(MAKE) -C guest build" \
		"host:build" "$(MAKE) -C host build"

lint:
	@$(RUN_PARALLEL) -j 2 \
		"guest:lint" "$(MAKE) -C guest lint" \
		"host:lint" "$(MAKE) -C host lint"

typecheck:
	@$(RUN_PARALLEL) -j 2 \
		"guest:typecheck" "$(MAKE) -C guest typecheck" \
		"host:typecheck" "$(MAKE) -C host typecheck"

check:
	@$(RUN_PARALLEL) -j 4 \
		"guest:lint" "$(MAKE) -C guest lint" \
		"guest:typecheck" "$(MAKE) -C guest typecheck" \
		"host:lint" "$(MAKE) -C host lint" \
		"host:typecheck" "$(MAKE) -C host typecheck"

test:
	@$(RUN_PARALLEL) -j 2 \
		"guest:test" "$(MAKE) -C guest test" \
		"host:test" "$(MAKE) -C host test"

format:
	@$(RUN_PARALLEL) -j 2 \
		"guest:format" "$(MAKE) -C guest format" \
		"host:format" "$(MAKE) -C host format"

fix: format

clean:
	@$(RUN_PARALLEL) -j 2 \
		"guest:clean" "$(MAKE) -C guest clean" \
		"host:clean" "$(MAKE) -C host clean"

hooks:
	@git config core.hooksPath .husky
	@chmod +x .husky/pre-commit .husky/_/pre-commit .husky/_/h
	@echo "Installed hooks (core.hooksPath=.husky)"

ZENSICAL_VERSION ?= 0.0.21

docs:
	@uvx --from "zensical==$(ZENSICAL_VERSION)" zensical build
	@touch site/.nojekyll

serve-docs:
	@uvx --from "zensical==$(ZENSICAL_VERSION)" zensical serve
