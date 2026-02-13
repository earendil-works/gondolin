.PHONY: help fuzz cbor protocol repro-protocol run-cbor run-protocol print-protocol-last run-repro-protocol clean

ZIG ?= zig
FUZZ_OPTIMIZE ?= ReleaseSafe
REPRO_OPTIMIZE ?= Debug

TSX ?= ../../host/node_modules/.bin/tsx
GONDOLIN ?= $(TSX) ../../host/bin/gondolin.ts

# Keep this in sync with guest/Makefile
HOST_ARCH := $(shell uname -m)
HOST_OS := $(shell uname -s)
ifeq ($(HOST_OS),Darwin)
  ifeq ($(HOST_ARCH),x86_64)
    ifeq ($(shell sysctl -n hw.optional.arm64 2>/dev/null),1)
      HOST_ARCH := arm64
    endif
  endif
endif

ifeq ($(HOST_ARCH),arm64)
DEFAULT_ARCH := aarch64
else ifeq ($(HOST_ARCH),aarch64)
DEFAULT_ARCH := aarch64
else
DEFAULT_ARCH := x86_64
endif

FUZZ_ARCH ?= $(DEFAULT_ARCH)
ifeq ($(FUZZ_ARCH),arm64)
FUZZ_ARCH := aarch64
endif

TARGET ?= $(FUZZ_ARCH)-linux-musl

REPO_ROOT := $(abspath ../..)
OUT_DIR ?= $(abspath ./out/$(TARGET))
CACHE_DIR ?= $(abspath ./cache)

FUZZ_DEPS := $(shell find ../src -name '*.zig')

help:
	@echo "Guest fuzzing (Zig -ffuzz / libFuzzer-style runner)"
	@echo
	@echo "Build fuzzers:"
	@echo "  make fuzz"
	@echo
	@echo "Run in VM (stores corpus in guest/fuzz/cache):"
	@echo "  make run-cbor"
	@echo "  make run-protocol"
	@echo "  (these clear cache/v/ on the host to avoid stale coverage mismatches)"
	@echo
	@echo "Repro / debugging helpers:"
	@echo "  make print-protocol-last                   # prints newest corpus file path"
	@echo "  make repro-protocol                        # builds repro runner binary"
	@echo "  make run-repro-protocol [FILE=path]        # runs repro in VM (defaults to newest)"
	@echo
	@echo "Outputs (under cache dir):"
	@echo "  corpus:   $(CACHE_DIR)/f/<fuzzer-name>/"
	@echo "  coverage: $(CACHE_DIR)/v/<coverage-id>"
	@echo "  log:      $(CACHE_DIR)/tmp/libfuzzer.log"
	@echo
	@echo "Binaries:"
	@echo "  $(OUT_DIR)/{cbor-fuzz,protocol-fuzz,protocol-repro}"

fuzz: cbor protocol

$(OUT_DIR):
	@mkdir -p $(OUT_DIR)

cbor: $(OUT_DIR)/cbor-fuzz

protocol: $(OUT_DIR)/protocol-fuzz

repro-protocol: $(OUT_DIR)/protocol-repro

$(OUT_DIR)/cbor-fuzz: cbor_fuzz_test.zig $(FUZZ_DEPS) | $(OUT_DIR)
	$(ZIG) test -ffuzz -O$(FUZZ_OPTIMIZE) -target $(TARGET) --test-no-exec \
		--dep sandboxd -Mmain=$< -Msandboxd=../src/root.zig \
		-femit-bin=$@

$(OUT_DIR)/protocol-fuzz: protocol_fuzz_test.zig $(FUZZ_DEPS) | $(OUT_DIR)
	$(ZIG) test -ffuzz -O$(FUZZ_OPTIMIZE) -target $(TARGET) --test-no-exec \
		--dep sandboxd -Mmain=$< -Msandboxd=../src/root.zig \
		-femit-bin=$@

$(OUT_DIR)/protocol-repro: protocol_repro.zig $(FUZZ_DEPS) | $(OUT_DIR)
	$(ZIG) build-exe -O$(REPRO_OPTIMIZE) -target $(TARGET) \
		--dep sandboxd -Mmain=$< -Msandboxd=../src/root.zig \
		-femit-bin=$@

run-cbor: $(OUT_DIR)/cbor-fuzz
	@rm -rf $(CACHE_DIR)/v
	$(GONDOLIN) exec \
		--mount-hostfs $(REPO_ROOT):/workspace \
		-- /bin/sh -lc "mkdir -p /workspace/guest/fuzz/cache && exec /workspace/guest/fuzz/out/$(TARGET)/cbor-fuzz --cache-dir=/workspace/guest/fuzz/cache"

run-protocol: $(OUT_DIR)/protocol-fuzz
	@rm -rf $(CACHE_DIR)/v
	$(GONDOLIN) exec \
		--mount-hostfs $(REPO_ROOT):/workspace \
		-- /bin/sh -lc "mkdir -p /workspace/guest/fuzz/cache && exec /workspace/guest/fuzz/out/$(TARGET)/protocol-fuzz --cache-dir=/workspace/guest/fuzz/cache"

print-protocol-last:
	@set -e; \
		corpus_dir="$(CACHE_DIR)/f/protocol_decode"; \
		if [ ! -d "$$corpus_dir" ]; then \
			echo "missing corpus dir: $$corpus_dir" >&2; \
			exit 1; \
		fi; \
		f=$$(ls "$$corpus_dir" | LC_ALL=C sort -n | tail -n 1); \
		if [ -z "$$f" ]; then \
			echo "corpus dir is empty: $$corpus_dir" >&2; \
			exit 1; \
		fi; \
		echo "guest/fuzz/cache/f/protocol_decode/$$f"

run-repro-protocol: $(OUT_DIR)/protocol-repro
	@set -e; \
		file="$(FILE)"; \
		if [ -z "$$file" ]; then \
			file=$$($(MAKE) --no-print-directory print-protocol-last); \
		fi; \
		vm_file="$$file"; \
		case "$$vm_file" in /*) ;; *) vm_file="/workspace/$$vm_file" ;; esac; \
		$(GONDOLIN) exec \
			--mount-hostfs $(REPO_ROOT):/workspace \
			-- /bin/sh -lc "exec /workspace/guest/fuzz/out/$(TARGET)/protocol-repro $$vm_file"

clean:
	@rm -rf ./out ./cache
