.PHONY: build release dist check lint fmt-check clippy test test-linux format clean

CARGO ?= cargo

# Debug build of the workspace for this machine
build:
	@$(CARGO) build --workspace

# Optimised gondolind for this machine (native/target/release/gondolind)
release:
	@$(CARGO) build --release -p gondolind

# Static release binaries for all targets into target/dist/<target>/
# (TARGETS="aarch64-unknown-linux-musl ..." to restrict, EXAMPLES=1 to include examples)
dist:
	@./scripts/build-release.sh $(if $(EXAMPLES),--examples) $(TARGETS)

# fmt + clippy (warnings are errors)
check: fmt-check clippy

lint: check

fmt-check:
	@$(CARGO) fmt --all --check

clippy:
	@$(CARGO) clippy --workspace --all-targets --examples -- -D warnings

test:
	@$(CARGO) test --workspace

# Workspace tests cross-compiled for Linux, run inside a Gondolin VM
test-linux:
	@./scripts/test-linux.sh $(ARGS)

format:
	@$(CARGO) fmt --all

clean:
	@$(CARGO) clean
