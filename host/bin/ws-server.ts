import {
  SandboxWsServer,
  SandboxWsServerOptions,
  resolveSandboxWsServerOptions,
} from "../src/sandbox-ws-server";

function parseArgs(argv: string[]): SandboxWsServerOptions {
  const args: SandboxWsServerOptions = {};

  const fail = (message: string): never => {
    console.error(message);
    usage();
    process.exit(1);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    switch (arg) {
      case "--host":
        args.host = argv[++i] ?? args.host;
        break;
      case "--port":
        args.port = Number(argv[++i]);
        if (!Number.isFinite(args.port)) fail("--port must be a number");
        break;
      case "--qemu":
        args.qemuPath = argv[++i];
        break;
      case "--kernel":
        args.kernelPath = argv[++i];
        break;
      case "--initrd":
        args.initrdPath = argv[++i];
        break;
      case "--memory":
        args.memory = argv[++i];
        break;
      case "--cpus":
        args.cpus = Number(argv[++i]);
        if (!Number.isFinite(args.cpus)) fail("--cpus must be a number");
        break;
      case "--virtio-sock":
        args.virtioSocketPath = argv[++i];
        break;
      case "--net-sock":
        args.netSocketPath = argv[++i];
        break;
      case "--virtio-fs-sock":
        args.virtioFsSocketPath = argv[++i];
        break;
      case "--net-mac":
        args.netMac = argv[++i];
        break;
      case "--no-net":
        args.netEnabled = false;
        break;
      case "--net-debug":
        args.netDebug = true;
        break;
      case "--machine":
        args.machineType = argv[++i];
        break;
      case "--accel":
        args.accel = argv[++i];
        break;
      case "--cpu":
        args.cpu = argv[++i];
        break;
      case "--console":
        args.console = argv[++i] === "none" ? "none" : "stdio";
        break;
      case "--token":
        args.token = argv[++i];
        break;
      case "--no-restart":
        args.autoRestart = false;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  const defaults = resolveSandboxWsServerOptions();
  console.log("Usage: gondolin ws-server [options]");
  console.log("Options:");
  console.log(`  --host HOST          Host to bind (default ${defaults.host})`);
  console.log(`  --port PORT          Port to bind (default ${defaults.port})`);
  console.log(`  --qemu PATH          QEMU binary (default ${defaults.qemuPath})`);
  console.log("  --kernel PATH        Kernel path");
  console.log("  --initrd PATH        Initrd path");
  console.log(`  --memory SIZE        Memory size (default ${defaults.memory})`);
  console.log(`  --cpus N             vCPU count (default ${defaults.cpus})`);
  console.log("  --virtio-sock PATH   Virtio serial socket path");
  console.log("  --virtio-fs-sock PATH Virtio filesystem socket path");
  console.log("  --net-sock PATH      QEMU net socket path");
  console.log("  --net-mac MAC        MAC address for virtio-net");
  console.log("  --no-net             Disable QEMU net backend");
  console.log("  --net-debug          Enable net backend debug logging");
  console.log("                       (or set GONDOLIN_DEBUG=net)");
  console.log("  --machine TYPE       Override QEMU machine type");
  console.log("  --accel TYPE         Override QEMU accel (kvm/hvf/tcg)");
  console.log("  --cpu TYPE           Override QEMU CPU type");
  console.log("  --console stdio|none Console output");
  console.log("  --token TOKEN        Require token in Authorization header");
  console.log("  --no-restart          Disable auto restart on exit");
}

function formatLog(message: string) {
  if (message.endsWith("\n")) return message;
  return `${message}\n`;
}

export async function runWsServer(argv: string[] = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const server = new SandboxWsServer(args);

  server.on("log", (message: string) => {
    process.stdout.write(formatLog(message));
  });

  server.on("error", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(formatLog(message));
  });

  const address = await server.start();
  console.log(`WebSocket server listening on ${address.url}`);

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
}

if (require.main === module) {
  runWsServer().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
