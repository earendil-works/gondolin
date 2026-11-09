.PHONY: build release dist check lint fmt-check clippy test test-linux test-docker format clean fuzz

CARGO ?= cargo

# Debug build of the workspace for this machine
build:
	@$(CARGO) build --workspace

# Optimised binaries for this machine: the multi-call gondolin (static CLI and
# daemon, what the packages ship) and gondolind (native/target/release/)
release:
	@$(CARGO) build --release -p gondolin-cli -p gondolind

# Static release binaries for all targets into target/dist/<target>/
# (TARGETS="aarch64-unknown-linux-musl ..." to restrict, EXAMPLES=1 to include examples)
dist:
	@./scripts/build-release.sh $(if $(EXAMPLES),--examples) $(TARGETS)

# fmt + clippy (warnings are errors)
check: fmt-check clippy deps

lint: check

fmt-check:
	@$(CARGO) fmt --all --check

clippy:
	@$(CARGO) clippy --workspace --all-targets --examples -- -D warnings

# runtime crates of the gondolin binary against native/deps-budget
deps:
	@./scripts/count-deps.sh

test:
	@$(CARGO) test --workspace

# Workspace tests cross-compiled for Linux, run inside a Gondolin VM
test-linux:
	@./scripts/test-linux.sh $(ARGS)

# Linux tests in Docker: cargo test (arm64), x86_64 musl tests (emulated amd64),
# native engine VMs under QEMU TCG and host tests (PHASES="cargo amd64 vm host-tests")
test-docker:
	@./scripts/test-linux-docker.sh $(PHASES)

format:
	@$(CARGO) fmt --all

clean:
	@$(CARGO) clean

# cargo-fuzz targets for the guest-facing parsers (needs nightly + cargo-fuzz)
# FUZZ_TARGETS="a b" to restrict, FUZZ_TIME seconds per target
FUZZ_TARGETS ?= netstack_parse netstack_stack egress_flow egress_policy http_codec http_conn url_parse x509_parse tls_client_hello wire_guest sshproxy_flow sshproxy_parse ssh_transport ssh_keys wire_cbor wire_json assets_tar assets_gzip hooks_djs qcow2_parse
FUZZ_TIME ?= 120
fuzz:
	@cd fuzz && for t in $(FUZZ_TARGETS); do \
		echo "=== fuzz $$t ($(FUZZ_TIME)s)"; \
		mkdir -p corpus/$$t; \
		cargo +nightly fuzz run $$t corpus/$$t $$( [ -d seeds/$$t ] && echo seeds/$$t ) -- \
			-max_total_time=$(FUZZ_TIME) -rss_limit_mb=4096 -timeout=30 || exit 1; \
	done
