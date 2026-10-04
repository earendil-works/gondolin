// Shared command line helpers for the release scripts.

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }

    const eq = token.indexOf("=");
    if (eq >= 0) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }

    const key = token.slice(2);
    const value = argv[++i];
    if (value === undefined) {
      throw new Error(`missing value for --${key}`);
    }
    args[key] = value;
  }
  return args;
}

export function requireArg(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing required --${name}`);
  }
  return value.trim();
}

export function normalizeVersion(value) {
  const version = value.trim().replace(/^v/, "");
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`invalid version: ${value}`);
  }
  return version;
}
