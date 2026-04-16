import fs from "node:fs";
import path from "node:path";

const pkgRoot = path.resolve(import.meta.dirname, "..");
const distDir = path.join(pkgRoot, "dist");

fs.rmSync(distDir, { recursive: true, force: true });
