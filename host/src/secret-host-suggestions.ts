import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "node:child_process";

import {
  ensureTrufflehogBinary,
  ensureTrufflehogSourceDir,
} from "./build/trufflehog.ts";

const URL_RE = /https?:\/\/[^\s"'`<>]+/gi;
const DETECTOR_SOURCE_SKIP_FILE_RE = /(?:^|\/)(?:[^/]+_test|[^/]+_integration_test)\.go$/;

type TrufflehogScanResult = {
  stdout: string;
  stderr: string;
};

type TrufflehogFinding = {
  DetectorName?: string;
  ExtraData?: Record<string, string>;
};

export type SecretHostSuggestion = {
  /** suggested host name */
  host: string;
  /** evidence file path relative to the scan root or synthetic `detector:<name>` */
  file: string;
  /** evidence line number or `0` for synthetic detector metadata */
  line: number;
  /** one-line evidence snippet */
  snippet: string;
  /** evidence hit count for this host */
  count: number;
};

export type SuggestSecretHostsOptions = {
  /** secret value to search for */
  secretValue: string;
};

function extractUrlHosts(snippet: string): string[] {
  const hosts = new Set<string>();

  for (const match of snippet.matchAll(URL_RE)) {
    try {
      const hostname = new URL(match[0]).hostname.toLowerCase();
      if (hostname) hosts.add(hostname);
    } catch {
      // ignore invalid urls
    }
  }

  return [...hosts];
}

function parseTrufflehogJsonLines(stdout: string): TrufflehogFinding[] {
  const findings: TrufflehogFinding[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      findings.push(JSON.parse(trimmed) as TrufflehogFinding);
    } catch (error) {
      throw new Error(
        `failed to parse trufflehog json line: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return findings;
}

async function runTrufflehogSecretDetection(
  secretValue: string,
): Promise<TrufflehogFinding[]> {
  const binaryPath = await ensureTrufflehogBinary();
  const tmpRoot = fs.mkdtempSync(
    path.join(process.env.TMPDIR ?? os.tmpdir(), "gondolin-secret-detect-"),
  );
  const filePath = path.join(tmpRoot, "secret.txt");

  try {
    fs.writeFileSync(filePath, `${secretValue}\n`, { mode: 0o600 });
    const result = await new Promise<TrufflehogScanResult>((resolve, reject) => {
      const child = spawn(
        binaryPath,
        [
          "filesystem",
          filePath,
          "--json",
          "--no-update",
          "--no-verification",
          "--results=verified,unknown,unverified",
        ],
        {
          cwd: tmpRoot,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0 || code === 183) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          new Error(
            `trufflehog secret detection failed with exit code ${code ?? "unknown"}${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      });
    });

    return parseTrufflehogJsonLines(result.stdout);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function collectDetectorSourceFiles(
  detectorsDir: string,
  detectorName: string,
): string[] {
  const files: string[] = [];
  const needle = `DetectorType_${detectorName}`;
  const stack = [detectorsDir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".go")) continue;
      const content = fs.readFileSync(fullPath, "utf8");
      if (content.includes(needle)) {
        files.push(fullPath);
        const dir = path.dirname(fullPath);
        for (const sibling of fs.readdirSync(dir)) {
          const siblingPath = path.join(dir, sibling);
          if (
            siblingPath !== fullPath &&
            sibling.endsWith(".go") &&
            fs.statSync(siblingPath).isFile()
          ) {
            files.push(siblingPath);
          }
        }
      }
    }
  }

  return [...new Set(files)];
}

function normalizeSuggestedHost(host: string): string | null {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === "localhost") return null;
  if (!trimmed.includes(".")) return null;
  return trimmed;
}

function collectSuggestionsFromDetectorSource(
  sourceRoot: string,
  detectorName: string,
): SecretHostSuggestion[] {
  const detectorsDir = path.join(sourceRoot, "pkg", "detectors");
  if (!fs.existsSync(detectorsDir)) {
    return [];
  }

  const sourceFiles = collectDetectorSourceFiles(detectorsDir, detectorName);
  const suggestions: SecretHostSuggestion[] = [];

  for (const filePath of sourceFiles) {
    if (DETECTOR_SOURCE_SKIP_FILE_RE.test(filePath)) {
      continue;
    }

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const hosts = extractUrlHosts(lines[i]);
      for (const host of hosts) {
        const normalized = normalizeSuggestedHost(host);
        if (!normalized) continue;
        suggestions.push({
          host: normalized,
          file: path.relative(sourceRoot, filePath),
          line: i + 1,
          snippet: lines[i].trim().slice(0, 160),
          count: 1,
        });
      }
    }
  }

  return suggestions;
}

function mergeSuggestions(
  suggestions: SecretHostSuggestion[],
): SecretHostSuggestion[] {
  const merged = new Map<string, SecretHostSuggestion>();

  for (const suggestion of suggestions) {
    const existing = merged.get(suggestion.host);
    if (!existing) {
      merged.set(suggestion.host, suggestion);
      continue;
    }
    existing.count += suggestion.count;
  }

  return [...merged.values()].sort(
    (a, b) => b.count - a.count || a.host.localeCompare(b.host),
  );
}

export async function suggestHostsForSecret(
  options: SuggestSecretHostsOptions,
): Promise<SecretHostSuggestion[]> {
  if (!options.secretValue) {
    return [];
  }

  const findings = await runTrufflehogSecretDetection(options.secretValue);
  const detectorSuggestions: SecretHostSuggestion[] = [];
  const detectorNames = new Set<string>();
  const sourceRoot = findings.some((finding) => finding.DetectorName)
    ? await ensureTrufflehogSourceDir()
    : null;

  for (const finding of findings) {
    if (finding.DetectorName && sourceRoot && !detectorNames.has(finding.DetectorName)) {
      detectorNames.add(finding.DetectorName);
      detectorSuggestions.push(
        ...collectSuggestionsFromDetectorSource(sourceRoot, finding.DetectorName),
      );
    }
    if (!finding.DetectorName) continue;
    for (const value of Object.values(finding.ExtraData ?? {})) {
      for (const host of extractUrlHosts(value)) {
        const normalized = normalizeSuggestedHost(host);
        if (!normalized) continue;
        detectorSuggestions.push({
          host: normalized,
          file: `detector:${finding.DetectorName}`,
          line: 0,
          snippet: value.slice(0, 160),
          count: 1,
        });
      }
    }
  }

  return mergeSuggestions(detectorSuggestions);
}

export const __test = {
  extractUrlHosts,
  parseTrufflehogJsonLines,
  collectSuggestionsFromDetectorSource,
  mergeSuggestions,
};
