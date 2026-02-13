.PHONY: help lint typecheck build test check format fix clean hooks docs serve-docs fuzz fuzz-cbor fuzz-protocol fuzz-sandbox fuzz-cbor-last fuzz-protocol-last fuzz-sandbox-last fuzz-cbor-repro fuzz-protocol-repro fuzz-sandbox-repro fuzz-clean

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
	@echo "  make fuzz        - Build guest fuzzers (protocol + cbor + sandbox)"
	@echo "  make fuzz-cbor   - Run CBOR fuzzer in a VM"
	@echo "  make fuzz-protocol - Run protocol fuzzer in a VM"
	@echo "  make fuzz-sandbox - Run sandbox behavior fuzzer in a VM"
	@echo "  make fuzz-cbor-last - Print newest CBOR fuzzer corpus file"
	@echo "  make fuzz-protocol-last - Print newest protocol fuzzer corpus file"
	@echo "  make fuzz-sandbox-last - Print newest sandbox behavior fuzzer corpus file"
	@echo "  make fuzz-cbor-repro [FILE=path] - Run CBOR repro in VM (defaults to newest)"
	@echo "  make fuzz-protocol-repro [FILE=path] - Run protocol repro in VM (defaults to newest)"
	@echo "  make fuzz-sandbox-repro [FILE=path] - Run sandbox repro in VM (defaults to newest)"
	@echo "  make fuzz-clean  - Remove fuzz binaries + cache"
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
	@$(MAKE) -C guest test
	@$(MAKE) -C host test

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

fuzz:
	@$(MAKE) -C guest fuzz

fuzz-cbor:
	@$(MAKE) -C guest fuzz-cbor

fuzz-protocol:
	@$(MAKE) -C guest fuzz-protocol

fuzz-sandbox:
	@$(MAKE) -C guest fuzz-sandbox

fuzz-cbor-last:
	@$(MAKE) -C guest fuzz-cbor-last

fuzz-protocol-last:
	@$(MAKE) -C guest fuzz-protocol-last

fuzz-sandbox-last:
	@$(MAKE) -C guest fuzz-sandbox-last

fuzz-cbor-repro:
	@$(MAKE) -C guest fuzz-cbor-repro FILE="$(FILE)"

fuzz-protocol-repro:
	@$(MAKE) -C guest fuzz-protocol-repro FILE="$(FILE)"

fuzz-sandbox-repro:
	@$(MAKE) -C guest fuzz-sandbox-repro FILE="$(FILE)"

fuzz-clean:
	@$(MAKE) -C guest fuzz-clean
