/**
 * Generates `cases.json`: the node CLI's network configuration for a matrix of
 * flags, as the native engine would send it (`buildVmOptions` →
 * `NativeNetwork.configure()`), for the Rust flag compiler
 * (`gondolin_egress::cli_policy`) to be compared against.
 *
 * Run from `host/`: `node ../native/crates/gondolin-egress/tests/fixtures/cli-net/gen.ts`
 *
 * Normalised: the random secret marker (`<MARKER>`), the MITM CA (`<CERT>`,
 * `<KEY>`), the home directory (`<HOME>`); dropped: upstream trust
 * (`upstream_ca_pems`, `use_*_roots`: node's CA store vs the system/webpki
 * roots of the Rust CLI) and resolvers that come from this machine
 * (`system_resolvers`, implicit `trusted_servers`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { __test } from "../../../../../../host/bin/gondolin.ts";
import { NativeNetwork } from "../../../../../../host/src/native/net.ts";

type Flags = {
  allow_hosts?: string[];
  secrets?: Array<{ name: string; hosts: string[]; value: string }>;
  disable_websockets?: boolean;
  dns?: {
    mode?: string;
    trusted_servers?: string[];
    synthetic_host_mapping?: string;
  };
  tcp_maps?: Array<[string, string]>;
  ssh?: {
    allow_hosts?: string[];
    agent?: string;
    known_hosts_files?: string[];
    credentials?: Array<{
      host: string;
      username?: string;
      private_key_pem: string;
      passphrase?: string;
    }>;
  };
};

type Case = {
  name: string;
  flags: Flags;
  ctx?: { checksum_offload?: boolean; mac?: string };
};

const cases: Case[] = [
  { name: "empty", flags: {} },
  { name: "allow-hosts", flags: { allow_hosts: ["api.example.com", "*.GitHub.com", "api.example.com"] } },
  {
    name: "secrets-and-hosts",
    flags: {
      allow_hosts: ["api.example.com"],
      secrets: [
        { name: "API_KEY", hosts: ["api.example.com"], value: "s3cret" },
        { name: "other token", hosts: ["*.example.org", "API.example.org"], value: "v2" },
      ],
    },
  },
  { name: "secrets-only", flags: { secrets: [{ name: "TOKEN", hosts: [], value: "x" }] } },
  {
    name: "secret-duplicate-name",
    flags: {
      secrets: [
        { name: "TOKEN", hosts: ["a.example"], value: "first" },
        { name: "TOKEN", hosts: ["b.example"], value: "second" },
      ],
    },
  },
  {
    name: "secret-identifier-collision",
    flags: {
      secrets: [
        { name: "FOO BAR", hosts: [], value: "a" },
        { name: "foo_bar", hosts: [], value: "b" },
      ],
    },
  },
  { name: "disable-websockets", flags: { disable_websockets: true } },
  { name: "dns-trusted", flags: { dns: { mode: "trusted", trusted_servers: ["1.1.1.1", "9.9.9.9", "1.1.1.1"] } } },
  { name: "dns-trusted-implicit", flags: { dns: { mode: "trusted" } } },
  { name: "dns-open", flags: { dns: { mode: "open" } } },
  { name: "dns-per-host", flags: { dns: { synthetic_host_mapping: "per-host" } } },
  { name: "dns-trusted-server-without-mode", flags: { dns: { trusted_servers: ["1.1.1.1"] } } },
  { name: "dns-trusted-server-wrong-mode", flags: { dns: { mode: "open", trusted_servers: ["1.1.1.1"] } } },
  { name: "dns-mapping-wrong-mode", flags: { dns: { mode: "open", synthetic_host_mapping: "per-host" } } },
  { name: "dns-invalid-mode", flags: { dns: { mode: "magic" } } },
  { name: "dns-invalid-mapping", flags: { dns: { synthetic_host_mapping: "many" } } },
  { name: "dns-invalid-server", flags: { dns: { mode: "trusted", trusted_servers: ["::1"] } } },
  {
    name: "tcp-maps",
    flags: {
      tcp_maps: [
        ["DB.internal:5432", "127.0.0.1:15432"],
        ["cache.internal.", "[::1]:6379"],
        ["db.internal", "db.example.com:5432"],
      ],
    },
  },
  { name: "tcp-map-trusted-dns", flags: { tcp_maps: [["db", "127.0.0.1:1"]], dns: { mode: "trusted", trusted_servers: ["1.1.1.1"] } } },
  { name: "tcp-map-single-mapping", flags: { tcp_maps: [["db", "127.0.0.1:1"]], dns: { synthetic_host_mapping: "single" } } },
  { name: "tcp-map-missing-port", flags: { tcp_maps: [["db", "127.0.0.1"]] } },
  { name: "tcp-map-wildcard", flags: { tcp_maps: [["*.db", "127.0.0.1:1"]] } },
  { name: "tcp-map-duplicate", flags: { tcp_maps: [["DB:1", "127.0.0.1:1"], ["db:1", "127.0.0.1:2"]] } },
  { name: "tcp-map-bad-port", flags: { tcp_maps: [["db:70000", "127.0.0.1:1"]] } },
  {
    name: "ssh-agent",
    flags: {
      ssh: {
        allow_hosts: ["github.com", "ssh.github.com:443", "GitHub.com"],
        agent: "/tmp/agent.sock",
        known_hosts_files: ["/etc/known_hosts", " /etc/known_hosts "],
      },
    },
  },
  { name: "ssh-default-known-hosts", flags: { ssh: { allow_hosts: ["github.com"], agent: "/tmp/a.sock" } } },
  {
    name: "ssh-credential",
    flags: {
      ssh: {
        known_hosts_files: ["/etc/known_hosts"],
        credentials: [
          { host: "git.example.com:2222", username: "git", private_key_pem: "KEY1" },
          { host: "github.com", private_key_pem: "KEY2", passphrase: "pw" },
        ],
      },
    },
  },
  { name: "ssh-agent-without-hosts", flags: { ssh: { agent: "/tmp/a.sock" } } },
  { name: "ssh-trusted-dns", flags: { ssh: { allow_hosts: ["github.com"], agent: "/a" }, dns: { mode: "trusted", trusted_servers: ["1.1.1.1"] } } },
  { name: "ssh-single-mapping", flags: { ssh: { allow_hosts: ["github.com"], agent: "/a" }, dns: { synthetic_host_mapping: "single" } } },
  { name: "krun-offload", flags: { allow_hosts: ["a.example"] }, ctx: { checksum_offload: true } },
  { name: "custom-mac", flags: {}, ctx: { mac: "02:aa:bb:cc:dd:ee" } },
];

const DEFAULT_MAC = "02:00:00:00:00:01";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cli-net-"));
const home = os.homedir();

function commonOptions(flags: Flags) {
  const keyFiles = (flags.ssh?.credentials ?? []).map((c, i) => {
    const file = path.join(tmp, `key${i}`);
    fs.writeFileSync(file, c.private_key_pem);
    return { host: c.host, username: c.username, keyPath: file, passphrase: c.passphrase };
  });
  const tcpHostMappings: Record<string, string> = {};
  for (const [key, value] of flags.tcp_maps ?? []) tcpHostMappings[key] = value;
  return {
    mounts: [],
    memoryMounts: [],
    allowedHosts: [...(flags.allow_hosts ?? [])],
    secrets: (flags.secrets ?? []).map((s) => ({ ...s, hosts: [...s.hosts] })),
    disableWebSockets: flags.disable_websockets,
    dnsMode: flags.dns?.mode,
    dnsTrustedServers: [...(flags.dns?.trusted_servers ?? [])],
    dnsSyntheticHostMapping: flags.dns?.synthetic_host_mapping,
    tcpHostMappings,
    sshAllowedHosts: [...(flags.ssh?.allow_hosts ?? [])],
    sshAgent: flags.ssh?.agent,
    sshKnownHostsFiles: [...(flags.ssh?.known_hosts_files ?? [])],
    sshCredentials: keyFiles,
  };
}

/** CLI argument validation the parser does before `buildVmOptions` */
function validateFlags(flags: Flags) {
  const mode = flags.dns?.mode;
  if (mode !== undefined && !["synthetic", "trusted", "open"].includes(mode)) {
    throw new Error("--dns must be one of: synthetic, trusted, open");
  }
  const mapping = flags.dns?.synthetic_host_mapping;
  if (mapping !== undefined && !["single", "per-host"].includes(mapping)) {
    throw new Error("--dns-synthetic-host-mapping must be one of: single, per-host");
  }
  for (const ip of flags.dns?.trusted_servers ?? []) {
    if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(ip) || ip.split(".").some((p) => Number(p) > 255)) {
      throw new Error("--dns-trusted-server must be a valid IPv4 address");
    }
  }
}

function normalize(value: unknown, marker: string | undefined): unknown {
  if (typeof value === "string") {
    let out = value;
    if (marker) out = out.split(marker).join("<MARKER>");
    if (out.startsWith(`${home}/`)) out = `<HOME>${out.slice(home.length)}`;
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, marker));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, marker)]),
    );
  }
  return value;
}

const out: unknown[] = [];
for (const c of cases) {
  const record: Record<string, unknown> = { name: c.name, flags: c.flags, ctx: c.ctx ?? {} };
  try {
    validateFlags(c.flags);
    const opts = __test.buildVmOptions(commonOptions(c.flags) as any);
    const network = new NativeNetwork({
      httpHooks: opts.httpHooks,
      allowWebSockets: opts.allowWebSockets,
      maxHttpBodyBytes: 64 * 1024 * 1024,
      maxHttpResponseBodyBytes: 64 * 1024 * 1024,
      dns: opts.dns,
      ssh: opts.ssh,
      tcp: opts.tcp,
      netMac: c.ctx?.mac ?? DEFAULT_MAC,
      checksumOffload: c.ctx?.checksum_offload ?? false,
      mitmCertDir: path.join(tmp, "mitm"),
    });
    const net = (await network.configure()) as Record<string, any>;
    const marker: string | undefined = net.policy?.rules?.marker;
    delete net.upstream_ca_pems;
    delete net.use_system_roots;
    delete net.use_webpki_roots;
    delete net.system_resolvers;
    if (!c.flags.dns?.trusted_servers?.length) delete net.stack.dns.trusted_servers;
    net.mitm = { cert_pem: "<CERT>", key_pem: "<KEY>" };
    record.net = normalize(net, marker);
    record.guest_env = normalize(opts.env ?? {}, marker);
  } catch (err) {
    record.error = (err as Error).message;
  }
  out.push(record);
}

fs.rmSync(tmp, { recursive: true, force: true });
const target = path.join(import.meta.dirname, "cases.json");
fs.writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${out.length} cases to ${target}`);
