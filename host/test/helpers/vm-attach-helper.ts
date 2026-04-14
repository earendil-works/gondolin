import { VM } from "../../src/vm/core.ts";

function parsePort(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`invalid port: ${String(raw)}`);
  }
  return value;
}

async function main(): Promise<void> {
  const mappedPort = parsePort(process.argv[2]);

  const vm = await VM.create({
    sandbox: {
      console: "none",
      dns: {
        mode: "synthetic",
        syntheticHostMapping: "per-host",
      },
      tcp: {
        hosts: {
          "local.test:8080": `127.0.0.1:${mappedPort}`,
        },
      },
    },
    vfs: null,
  });

  await vm.start();

  const setup = await vm.exec([
    "/bin/sh",
    "-lc",
    "echo reconnect-ok > /tmp/reconnect-marker; while true; do sleep 60; done >/dev/null 2>&1 & echo $! > /tmp/reconnect-worker.pid",
  ]);
  if (setup.exitCode !== 0) {
    throw new Error(`guest setup failed: ${setup.stderr}`);
  }

  const networkProbe = await vm.exec([
    "/bin/sh",
    "-lc",
    "curl -fsS http://local.test:8080/ || wget -qO- http://local.test:8080/",
  ]);
  if (networkProbe.exitCode !== 0 || networkProbe.stdout.trim() !== "attach-ok") {
    throw new Error(
      `guest network probe failed exit=${networkProbe.exitCode}: ${networkProbe.stderr || networkProbe.stdout}`,
    );
  }

  process.stdout.write(`${JSON.stringify({ id: vm.id })}\n`);
  setInterval(() => {}, 1000);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
