import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { findGuestDirFrom } from "../src/build/shared.ts";

const GUEST_PAYLOAD = ["build.zig", "build.zig.zon", "src", "LICENSE"];

function copyVendoredNodeVfs(pkgRoot: string): void {
  const vendoredSource = path.join(
    pkgRoot,
    "src",
    "vfs",
    "node",
    "vendored-node-vfs",
  );
  const vendoredDest = path.join(
    pkgRoot,
    "dist",
    "src",
    "vfs",
    "node",
    "vendored-node-vfs",
  );

  if (!fs.existsSync(vendoredSource)) {
    throw new Error(`missing vendored node-vfs source: ${vendoredSource}`);
  }

  fs.rmSync(vendoredDest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(vendoredDest), { recursive: true });
  fs.cpSync(vendoredSource, vendoredDest, { recursive: true });
}

export function findGuestSourceRoot(
  pkgRoot: string,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return findGuestDirFrom([pkgRoot, cwd], env);
}

export function copyGuestSources(
  pkgRoot: string,
  guestSourceRoot: string,
): void {
  const guestDistRoot = path.join(pkgRoot, "dist", "guest");

  fs.rmSync(guestDistRoot, { recursive: true, force: true });
  fs.mkdirSync(guestDistRoot, { recursive: true });

  for (const entry of GUEST_PAYLOAD) {
    const src = path.join(guestSourceRoot, entry);
    if (!fs.existsSync(src)) {
      throw new Error(`missing guest build payload entry: ${src}`);
    }
    const dest = path.join(guestDistRoot, entry);
    fs.cpSync(src, dest, { recursive: true });
  }
}

function rewriteDeclarationsInDir(dirPath: string): void {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      rewriteDeclarationsInDir(fullPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) {
      continue;
    }

    const source = fs.readFileSync(fullPath, "utf8");
    const rewritten = source
      .replace(/(from\s+["'])(\.{1,2}\/[^"']+)\.ts(["'])/g, "$1$2.js$3")
      .replace(
        /(import\(\s*["'])(\.{1,2}\/[^"']+)\.ts(["']\s*\))/g,
        "$1$2.js$3",
      );

    if (rewritten !== source) {
      fs.writeFileSync(fullPath, rewritten);
    }
  }
}

export type PostbuildOptions = {
  /** host package root containing `dist/` */
  pkgRoot?: string;
  /** working directory used for guest source discovery */
  cwd?: string;
  /** environment used for guest source discovery */
  env?: NodeJS.ProcessEnv;
  /** stream receiving diagnostics */
  stderr?: Pick<NodeJS.WritableStream, "write">;
};

export function runPostbuild({
  pkgRoot = path.resolve(import.meta.dirname, ".."),
  cwd = process.cwd(),
  env = process.env,
  stderr = process.stderr,
}: PostbuildOptions = {}): { guestSourceRoot: string | null } {
  copyVendoredNodeVfs(pkgRoot);

  const guestDistRoot = path.join(pkgRoot, "dist", "guest");
  fs.rmSync(guestDistRoot, { recursive: true, force: true });

  const guestSourceRoot = findGuestSourceRoot(pkgRoot, cwd, env);
  if (guestSourceRoot) {
    copyGuestSources(pkgRoot, guestSourceRoot);
  } else {
    stderr.write(
      "Skipping guest source bundling: missing guest source directory\n",
    );
  }

  const distRoot = path.join(pkgRoot, "dist");
  if (fs.existsSync(distRoot)) {
    rewriteDeclarationsInDir(distRoot);
  }

  return { guestSourceRoot };
}

if (process.argv[1]) {
  const entryHref = pathToFileURL(path.resolve(process.argv[1])).href;
  if (import.meta.url === entryHref) {
    runPostbuild();
  }
}
