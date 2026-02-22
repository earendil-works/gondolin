/**
 * Hostname allowlist pattern matching helpers
 *
 * Pattern syntax:
 * - "*" matches any hostname
 * - "*" wildcards inside the pattern match any substring
 */

/** normalize hostname allowlist pattern */
export function normalizeHostnamePattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}

/** match a hostname against a normalized allowlist pattern */
export function matchHostname(hostname: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === "*") return true;

  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(hostname);
}

/** test a hostname against multiple allowlist patterns */
export function matchesAnyHost(hostname: string, patterns: string[]): boolean {
  const normalized = hostname.toLowerCase();
  return patterns.some((pattern) => matchHostname(normalized, pattern));
}
