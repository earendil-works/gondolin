const POSIX_CLASS_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\[\[:alnum:\]\]/g, "[A-Za-z0-9]"],
  [/\[\[:alpha:\]\]/g, "[A-Za-z]"],
  [/\[\[:digit:\]\]/g, "[0-9]"],
  [/\[\[:xdigit:\]\]/g, "[A-Fa-f0-9]"],
  [/\[\[:lower:\]\]/g, "[a-z]"],
  [/\[\[:upper:\]\]/g, "[A-Z]"],
  [/\[\[:space:\]\]/g, "[\\t\\r\\n\\f\\v ]"],
];

const INLINE_FLAG_TOKEN_RE = /^\(\?([A-Za-z-]+)\)/;
const SUPPORTED_INLINE_FLAGS_RE = /^-?[ims]+$/;

let scopedModifiersSupport: boolean | null = null;

function scopedModifiersSupported(): boolean {
  if (scopedModifiersSupport !== null) {
    return scopedModifiersSupport;
  }

  try {
    new RegExp("(?i:a)");
    scopedModifiersSupport = true;
  } catch {
    scopedModifiersSupport = false;
  }

  return scopedModifiersSupport;
}

function normalizeInlineFlags(pattern: string): string {
  let out = "";
  let escaped = false;
  let inCharClass = false;
  let depth = 0;

  const pendingClosures = new Map<number, number>();

  const queueClosure = (groupDepth: number): void => {
    pendingClosures.set(groupDepth, (pendingClosures.get(groupDepth) ?? 0) + 1);
  };

  const flushClosures = (groupDepth: number): void => {
    const count = pendingClosures.get(groupDepth) ?? 0;
    if (count > 0) {
      out += ")".repeat(count);
      pendingClosures.delete(groupDepth);
    }
  };

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }

    if (inCharClass) {
      out += ch;
      if (ch === "]") {
        inCharClass = false;
      }
      continue;
    }

    if (ch === "[") {
      out += ch;
      inCharClass = true;
      continue;
    }

    if (ch === "(" && pattern[i + 1] === "?") {
      const tokenMatch = INLINE_FLAG_TOKEN_RE.exec(pattern.slice(i));
      const flags = tokenMatch?.[1];

      if (tokenMatch && flags && SUPPORTED_INLINE_FLAGS_RE.test(flags)) {
        out += `(?${flags}:`;
        queueClosure(depth);
        i += tokenMatch[0].length - 1;
        continue;
      }

      depth += 1;
      out += ch;
      continue;
    }

    if (ch === ")") {
      flushClosures(depth);
      if (depth > 0) {
        depth -= 1;
      }
      out += ch;
      continue;
    }

    out += ch;
  }

  flushClosures(depth);

  if (pendingClosures.size > 0) {
    for (const [, count] of [...pendingClosures.entries()].sort(
      (a, b) => b[0] - a[0],
    )) {
      out += ")".repeat(count);
    }
  }

  return out;
}

function stripInlineFlags(pattern: string): { pattern: string; flags: string } {
  const collectedFlags = new Set<string>();

  const SCOPED_RE = /\(\?(-?)([ims]+):/g;
  let stripped = pattern.replace(
    SCOPED_RE,
    (_match, neg: string, flags: string) => {
      if (!neg) {
        for (const ch of flags) {
          collectedFlags.add(ch);
        }
      }
      return "(?:";
    },
  );

  const BARE_RE = /\(\?(-?)([ims]+)\)/g;
  stripped = stripped.replace(BARE_RE, (_match, neg: string, flags: string) => {
    if (!neg) {
      for (const ch of flags) {
        collectedFlags.add(ch);
      }
    }
    return "";
  });

  return {
    pattern: stripped,
    flags: [...collectedFlags].sort().join(""),
  };
}

export function normalizeRegexForJs(input: string): {
  pattern: string;
  flags: string;
} {
  let pattern = input;

  pattern = pattern.replace(/\\z/g, "$");

  for (const [source, target] of POSIX_CLASS_REPLACEMENTS) {
    pattern = pattern.replace(source, target);
  }

  pattern = pattern.replace(/\(\?P<([A-Za-z][A-Za-z0-9_]*)>/g, "(?<$1>");

  if (scopedModifiersSupported()) {
    pattern = normalizeInlineFlags(pattern);
    return { pattern, flags: "" };
  }

  return stripInlineFlags(pattern);
}

export function compilePattern(input: string): RegExp {
  const normalized = normalizeRegexForJs(input);
  return new RegExp(normalized.pattern, normalized.flags);
}
