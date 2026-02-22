.PHONY: build build-bins build-inner test test-inner clean run assets lint typecheck format fuzz fuzz-cbor fuzz-protocol fuzz-sandbox fuzz-cbor-last fuzz-protocol-last fuzz-sandbox-last fuzz-cbor-repro fuzz-protocol-repro fuzz-sandbox-repro fuzz-clean

RUN_PARALLEL ?= ../scripts/run-parallel

ZIG ?= zig
OPTIMIZE ?= ReleaseSmall
TSX ?= ../host/node_modules/.bin/tsx
GONDOLIN ?= $(TSX) ../host/bin/gondolin.ts
GONDOLIN_BUILD_CONFIG ?=
GONDOLIN_BUILD_EXTRA_ARGS ?=

ZIG_SOURCES := $(shell find src fuzz -name '*.zig') build.zig
ZIG_BUILD_DEPS := $(ZIG_SOURCES) build.zig.zon
# NOTE: guest image builds are driven by the host TypeScript builder (host/src/build/alpine.ts).
HOST_BUILD_DEPS := $(shell find ../host/src ../host/bin -name '*.ts') ../host/package.json ../host/tsconfig.json
GONDOLIN_CONFIG_DEP := $(if $(strip $(GONDOLIN_BUILD_CONFIG)),$(GONDOLIN_BUILD_CONFIG))
BUILD_DEPS := $(ZIG_BUILD_DEPS) $(HOST_BUILD_DEPS) $(GONDOLIN_CONFIG_DEP)

IMAGE_OUT ?= ./image/out
IMAGE_INITRAMFS ?= $(IMAGE_OUT)/initramfs.cpio.lz4
IMAGE_ROOTFS ?= $(IMAGE_OUT)/rootfs.ext4
KERNEL ?= $(IMAGE_OUT)/vmlinuz-virt

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

ALPINE_ARCH ?= $(DEFAULT_ARCH)
ifeq ($(ALPINE_ARCH),arm64)
ALPINE_ARCH := aarch64
endif
GONDOLIN_BUILD_ARGS = --output $(IMAGE_OUT) --arch $(ALPINE_ARCH)
GONDOLIN_BUILD_ARGS += $(if $(strip $(GONDOLIN_BUILD_CONFIG)),--config $(GONDOLIN_BUILD_CONFIG),)
GONDOLIN_BUILD_ARGS += $(GONDOLIN_BUILD_EXTRA_ARGS)

build:
	@$(RUN_PARALLEL) -j 1 \
		"guest:build" "$(MAKE) assets"

build-bins:
	@$(RUN_PARALLEL) -j 1 \
		"guest:build" "$(MAKE) build-inner"

build-inner:
	$(ZIG) build -Doptimize=$(OPTIMIZE)

run: build-bins
	./zig-out/bin/sandboxd

assets: $(IMAGE_INITRAMFS) $(IMAGE_ROOTFS) $(KERNEL)

$(IMAGE_INITRAMFS) $(IMAGE_ROOTFS) $(KERNEL): $(BUILD_DEPS)
	$(GONDOLIN) build $(GONDOLIN_BUILD_ARGS)

format:
	$(ZIG) fmt $(ZIG_SOURCES)

lint:
	$(ZIG) fmt --check $(ZIG_SOURCES)

typecheck: build-bins


test:
	@$(RUN_PARALLEL) -j 1 \
		"guest:test" "$(MAKE) test-inner"

test-inner: assets
	$(ZIG) build test-bins -Doptimize=$(OPTIMIZE)
	$(TSX) ../host/bin/guest-tests.ts

clean:
	@rm -rf zig-cache zig-out $(IMAGE_OUT)

# Build fuzzers (Zig -ffuzz / libFuzzer-style runner)
fuzz:
	$(MAKE) -C fuzz fuzz

# Run fuzzers in a VM
fuzz-cbor:
	$(MAKE) -C fuzz run-cbor

fuzz-protocol:
	$(MAKE) -C fuzz run-protocol

fuzz-sandbox:
	$(MAKE) -C fuzz run-sandbox

# Prints the newest corpus file produced by the CBOR fuzzer
fuzz-cbor-last:
	$(MAKE) -C fuzz print-cbor-last

# Prints the newest corpus file produced by the protocol fuzzer
fuzz-protocol-last:
	$(MAKE) -C fuzz print-protocol-last

# Prints the newest corpus file produced by the sandbox behavior fuzzer
fuzz-sandbox-last:
	$(MAKE) -C fuzz print-sandbox-last

# Runs the CBOR repro runner in a VM (defaults to newest corpus file)
fuzz-cbor-repro:
	$(MAKE) -C fuzz run-repro-cbor FILE="$(FILE)"

# Runs the protocol repro runner in a VM (defaults to newest corpus file)
fuzz-protocol-repro:
	$(MAKE) -C fuzz run-repro-protocol FILE="$(FILE)"

# Runs the sandbox behavior repro runner in a VM (defaults to newest corpus file)
fuzz-sandbox-repro:
	$(MAKE) -C fuzz run-repro-sandbox FILE="$(FILE)"

fuzz-clean:
	$(MAKE) -C fuzz clean
