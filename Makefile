.PHONY: help lint typecheck build test check format fix clean hooks docs serve-docs fuzz fuzz-host fuzz-cbor fuzz-protocol fuzz-sandbox fuzz-cbor-last fuzz-protocol-last fuzz-sandbox-last fuzz-cbor-repro fuzz-protocol-repro fuzz-sandbox-repro fuzz-clean libkrun libkrunfw-kernel krun-runner

RUN_PARALLEL ?= ./scripts/run-parallel

LIBKRUN_VERSION ?= v1.17.4
LIBKRUN_FULL_VERSION ?= $(patsubst v%,%,$(LIBKRUN_VERSION))
LIBKRUN_REPO ?= https://github.com/containers/libkrun.git
LIBKRUN_SRC_DIR ?= .cache/libkrun-$(LIBKRUN_VERSION)
LIBKRUN_BUILD_FLAGS ?= BLK=1 NET=1
LIBKRUN_PREFIX ?= $(CURDIR)/.cache/libkrun-install/$(LIBKRUN_VERSION)

LIBKRUNFW_VERSION ?= v5.2.1
LIBKRUNFW_REPO ?= https://github.com/containers/libkrunfw

UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

ifeq ($(UNAME_M),arm64)
LIBKRUN_TARGET_ARCH := aarch64
LIBKRUNFW_TARGET_ARCH := aarch64
else ifeq ($(UNAME_M),x86_64)
LIBKRUN_TARGET_ARCH := x86_64
LIBKRUNFW_TARGET_ARCH := x86_64
else
LIBKRUN_TARGET_ARCH := $(UNAME_M)
LIBKRUNFW_TARGET_ARCH := $(UNAME_M)
endif

LIBKRUNFW_CACHE_DIR ?= $(HOME)/.cache/gondolin/krun/libkrunfw/$(LIBKRUNFW_VERSION)/$(LIBKRUNFW_TARGET_ARCH)
LIBKRUNFW_KERNEL_PATH ?= $(LIBKRUNFW_CACHE_DIR)/Image
LIBKRUNFW_EMPTY_INITRD_PATH ?= $(HOME)/.cache/gondolin/krun/empty-initrd
LIBKRUNFW_PREBUILT_URL ?= $(LIBKRUNFW_REPO)/releases/download/$(LIBKRUNFW_VERSION)/libkrunfw-prebuilt-$(LIBKRUNFW_TARGET_ARCH).tgz
LIBKRUNFW_ARCHIVE_URL ?= $(LIBKRUNFW_REPO)/releases/download/$(LIBKRUNFW_VERSION)/libkrunfw-$(LIBKRUNFW_TARGET_ARCH).tgz

ifeq ($(UNAME_S),Darwin)
BREW_PREFIX ?= $(shell brew --prefix 2>/dev/null)
LIBKRUN_LLVM_CLANG ?= $(BREW_PREFIX)/opt/llvm/bin/clang
LIBKRUN_LLVM_LIB ?= $(BREW_PREFIX)/opt/llvm/lib
LIBKRUN_SYSROOT_ABS := $(CURDIR)/$(LIBKRUN_SRC_DIR)/linux-sysroot
LIBKRUN_CC_LINUX ?= $(LIBKRUN_LLVM_CLANG) -target $(LIBKRUN_TARGET_ARCH)-linux-gnu -fuse-ld=lld -Wl,-strip-debug --sysroot $(LIBKRUN_SYSROOT_ABS) -Wno-c23-extensions
LIBKRUN_MAKE_ARGS ?= $(LIBKRUN_BUILD_FLAGS) CC_LINUX="$(LIBKRUN_CC_LINUX)"
LIBKRUN_BUILD_ENV ?= PATH="$(BREW_PREFIX)/opt/llvm/bin:$(BREW_PREFIX)/opt/lld/bin:$$PATH" LIBCLANG_PATH="$(LIBKRUN_LLVM_LIB)" DYLD_FALLBACK_LIBRARY_PATH="$(LIBKRUN_LLVM_LIB):$$DYLD_FALLBACK_LIBRARY_PATH"
else
LIBKRUN_MAKE_ARGS ?= $(LIBKRUN_BUILD_FLAGS)
LIBKRUN_BUILD_ENV ?=
endif

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
	@echo "  make fuzz-host   - Run host-side fuzzers (TypeScript)"
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
	@echo "  make libkrun     - Build + stage libkrun locally under .cache/"
	@echo "  make libkrunfw-kernel - Download/extract libkrunfw-compatible kernel Image"
	@echo "  make krun-runner - Build libkrun + host/krun-runner helper"

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

libkrun:
	@command -v git >/dev/null 2>&1 || (echo "git is required" && exit 1)
	@command -v cargo >/dev/null 2>&1 || (echo "Rust toolchain (cargo) is required to build libkrun" && exit 1)
	@if [ "$(UNAME_S)" = "Darwin" ]; then \
		[ -x "$(LIBKRUN_LLVM_CLANG)" ] || { echo "LLVM clang is required on macOS ($(LIBKRUN_LLVM_CLANG)). Install: brew install llvm lld xz"; exit 1; }; \
		[ -f "$(LIBKRUN_LLVM_LIB)/libclang.dylib" ] || { echo "libclang.dylib is required at $(LIBKRUN_LLVM_LIB). Install: brew install llvm"; exit 1; }; \
		command -v ld.lld >/dev/null 2>&1 || { echo "ld.lld is required on macOS. Install: brew install lld"; exit 1; }; \
		command -v xz >/dev/null 2>&1 || { echo "xz is required on macOS. Install: brew install xz"; exit 1; }; \
	fi
	@mkdir -p .cache
	@if [ ! -d "$(LIBKRUN_SRC_DIR)/.git" ]; then \
		echo "Cloning libkrun $(LIBKRUN_VERSION) into $(LIBKRUN_SRC_DIR)"; \
		git clone --depth 1 --branch "$(LIBKRUN_VERSION)" "$(LIBKRUN_REPO)" "$(LIBKRUN_SRC_DIR)"; \
	fi
	@echo "Building libkrun ($(LIBKRUN_BUILD_FLAGS))"
	@env $(LIBKRUN_BUILD_ENV) $(MAKE) -C "$(LIBKRUN_SRC_DIR)" $(LIBKRUN_MAKE_ARGS)
	@rm -rf "$(LIBKRUN_PREFIX)"
	@mkdir -p "$(LIBKRUN_PREFIX)"
	@echo "Staging libkrun into $(LIBKRUN_PREFIX)"
	@env $(LIBKRUN_BUILD_ENV) $(MAKE) -C "$(LIBKRUN_SRC_DIR)" $(LIBKRUN_MAKE_ARGS) install PREFIX="$(LIBKRUN_PREFIX)"
	@if [ "$(UNAME_S)" = "Darwin" ]; then \
		install_name_tool -id @rpath/libkrun.1.dylib "$(LIBKRUN_PREFIX)/lib/libkrun.$(LIBKRUN_FULL_VERSION).dylib"; \
	fi
	@echo "Staged libkrun under $(LIBKRUN_PREFIX)"

libkrunfw-kernel:
	@command -v curl >/dev/null 2>&1 || (echo "curl is required to download libkrunfw artifacts" && exit 1)
	@command -v tar >/dev/null 2>&1 || (echo "tar is required to extract libkrunfw artifacts" && exit 1)
	@command -v cc >/dev/null 2>&1 || (echo "a C compiler (cc) is required to extract the embedded kernel" && exit 1)
	@mkdir -p "$(LIBKRUNFW_CACHE_DIR)"
	@if [ ! -s "$(LIBKRUNFW_KERNEL_PATH)" ]; then \
		set -eu; \
		tmpdir="$$(mktemp -d)"; \
		trap 'rm -rf "$$tmpdir"' EXIT; \
		if curl -fsSL "$(LIBKRUNFW_PREBUILT_URL)" -o "$$tmpdir/libkrunfw.tgz" 2>/dev/null; then \
			echo "Using libkrunfw prebuilt archive ($(LIBKRUNFW_VERSION), $(LIBKRUNFW_TARGET_ARCH))"; \
			tar -xzf "$$tmpdir/libkrunfw.tgz" -C "$$tmpdir"; \
			printf '%s\n' \
				'#include <stdio.h>' \
				'#include <stddef.h>' \
				'#ifndef ABI_VERSION' \
				'#define ABI_VERSION 0' \
				'#endif' \
				'#include "libkrunfw/kernel.c"' \
				'int main(void) {' \
				'    size_t load_addr = 0, entry_addr = 0, size = 0;' \
				'    char *kernel = krunfw_get_kernel(&load_addr, &entry_addr, &size);' \
				'    (void)load_addr;' \
				'    (void)entry_addr;' \
				'    if (!kernel || size == 0) {' \
				'        return 1;' \
				'    }' \
				'    return fwrite(kernel, 1, size, stdout) == size ? 0 : 1;' \
				'}' > "$$tmpdir/extract-kernel.c"; \
			cc -O2 -I"$$tmpdir" "$$tmpdir/extract-kernel.c" -o "$$tmpdir/extract-kernel"; \
			"$$tmpdir/extract-kernel" > "$(LIBKRUNFW_KERNEL_PATH)"; \
		else \
			echo "Prebuilt archive missing for $(LIBKRUNFW_TARGET_ARCH); falling back to libkrunfw archive"; \
			curl -fsSL "$(LIBKRUNFW_ARCHIVE_URL)" -o "$$tmpdir/libkrunfw.tgz"; \
			tar -xzf "$$tmpdir/libkrunfw.tgz" -C "$$tmpdir"; \
			printf '%s\n' \
				'#include <stdio.h>' \
				'#include <stddef.h>' \
				'extern char *krunfw_get_kernel(size_t *load_addr, size_t *entry_addr, size_t *size);' \
				'int main(void) {' \
				'    size_t load_addr = 0, entry_addr = 0, size = 0;' \
				'    char *kernel = krunfw_get_kernel(&load_addr, &entry_addr, &size);' \
				'    (void)load_addr;' \
				'    (void)entry_addr;' \
				'    if (!kernel || size == 0) {' \
				'        return 1;' \
				'    }' \
				'    return fwrite(kernel, 1, size, stdout) == size ? 0 : 1;' \
				'}' > "$$tmpdir/extract-kernel.c"; \
			libdir="$$tmpdir/lib64"; \
			if [ ! -e "$$libdir/libkrunfw.so" ]; then libdir="$$tmpdir/lib"; fi; \
			[ -e "$$libdir/libkrunfw.so" ] || { echo "libkrunfw.so not found in fallback archive"; exit 1; }; \
			cc -O2 "$$tmpdir/extract-kernel.c" -L"$$libdir" -Wl,-rpath,"$$libdir" -lkrunfw -o "$$tmpdir/extract-kernel"; \
			LD_LIBRARY_PATH="$$libdir:$${LD_LIBRARY_PATH:-}" "$$tmpdir/extract-kernel" > "$(LIBKRUNFW_KERNEL_PATH)"; \
		fi; \
		echo "Extracted kernel: $(LIBKRUNFW_KERNEL_PATH)"; \
	fi
	@mkdir -p "$(dir $(LIBKRUNFW_EMPTY_INITRD_PATH))"
	@if [ ! -e "$(LIBKRUNFW_EMPTY_INITRD_PATH)" ]; then : > "$(LIBKRUNFW_EMPTY_INITRD_PATH)"; fi
	@echo "Prepared empty initrd: $(LIBKRUNFW_EMPTY_INITRD_PATH)"

krun-runner: libkrun libkrunfw-kernel
	@command -v zig >/dev/null 2>&1 || (echo "zig is required to build host/krun-runner" && exit 1)
	@echo "Building host krun runner"
	@cd host/krun-runner && \
		PKG_CONFIG_PATH="$(LIBKRUN_PREFIX)/lib64/pkgconfig:$(LIBKRUN_PREFIX)/lib/pkgconfig" \
		PKG_CONFIG_LIBDIR="$(LIBKRUN_PREFIX)/lib64/pkgconfig:$(LIBKRUN_PREFIX)/lib/pkgconfig" \
		C_INCLUDE_PATH="$(LIBKRUN_PREFIX)/include:$$C_INCLUDE_PATH" \
		LIBRARY_PATH="$(LIBKRUN_PREFIX)/lib64:$(LIBKRUN_PREFIX)/lib:$$LIBRARY_PATH" \
		zig build -Doptimize=ReleaseSafe -Dlibkrun-prefix="$(LIBKRUN_PREFIX)"
	@mkdir -p host/krun-runner/zig-out/lib
	@set -eu; \
		copied=0; \
		for d in "$(LIBKRUN_PREFIX)/lib" "$(LIBKRUN_PREFIX)/lib64"; do \
			if [ -d "$$d" ]; then \
				if ls "$$d"/libkrun* >/dev/null 2>&1; then \
					cp -af "$$d"/libkrun* host/krun-runner/zig-out/lib/; \
					copied=1; \
				fi; \
			fi; \
		done; \
		if [ "$$copied" -ne 1 ]; then \
			echo "Failed to find staged libkrun libraries under $(LIBKRUN_PREFIX)/lib{,64}"; \
			exit 1; \
		fi
	@echo "Built runner: host/krun-runner/zig-out/bin/gondolin-krun-runner"
	@echo "Bundled libs: host/krun-runner/zig-out/lib/libkrun*"
	@echo "Prepared krun kernel: $(LIBKRUNFW_KERNEL_PATH)"
	@echo "Prepared empty initrd: $(LIBKRUNFW_EMPTY_INITRD_PATH)"
	@echo "Run with: GONDOLIN_VMM=krun GONDOLIN_KRUN_RUNNER=$$(pwd)/host/krun-runner/zig-out/bin/gondolin-krun-runner npx @earendil-works/gondolin bash"

ZENSICAL_VERSION ?= 0.0.21

docs:
	@uvx --from "zensical==$(ZENSICAL_VERSION)" zensical build
	@touch site/.nojekyll

serve-docs:
	@uvx --from "zensical==$(ZENSICAL_VERSION)" zensical serve

fuzz:
	@$(MAKE) -C guest fuzz

# Host-side fuzzing
HOST_FUZZ_TARGET ?= virtio
fuzz-host:
	@$(MAKE) -C host fuzz TARGET="$(HOST_FUZZ_TARGET)"

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
