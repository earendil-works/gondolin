import fs from "node:fs";
import path from "node:path";

const pkgRoot = path.resolve(import.meta.dirname, "..");

const vendoredSource = path.join(pkgRoot, "src", "vfs", "node", "vendored-node-vfs");
const vendoredDest = path.join(pkgRoot, "dist", "src", "vfs", "node", "vendored-node-vfs");

if (!fs.existsSync(vendoredSource)) {
  throw new Error(`missing vendored node-vfs source: ${vendoredSource}`);
}

fs.rmSync(vendoredDest, { recursive: true, force: true });
fs.mkdirSync(path.dirname(vendoredDest), { recursive: true });
fs.cpSync(vendoredSource, vendoredDest, { recursive: true });

const distRoot = path.join(pkgRoot, "dist");

function rewriteDeclarationsInDir(dirPath) {
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
      .replace(
        /(from\s+["'])(\.{1,2}\/[^"']+)\.ts(["'])/g,
        "$1$2.js$3",
      )
      .replace(
        /(import\(\s*["'])(\.{1,2}\/[^"']+)\.ts(["']\s*\))/g,
        "$1$2.js$3",
      );

    if (rewritten !== source) {
      fs.writeFileSync(fullPath, rewritten);
    }
  }
}

if (fs.existsSync(distRoot)) {
  rewriteDeclarationsInDir(distRoot);
}
