import { gondolinCacheDir } from "./cache.ts";

const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const IMAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const IMAGE_NAME_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type ParsedImageRef = {
  /** image name (may contain `/` separated segments) */
  name: string;
  /** image tag (`latest` if omitted) */
  tag: string;
  /** canonical `name:tag` form */
  canonical: string;
};

/** Root directory of the local image store */
export function getImageStoreDirectory(): string {
  return process.env.GONDOLIN_IMAGE_STORE ?? gondolinCacheDir("images");
}

/** Check whether a value is a content-derived image build id */
export function isImageBuildId(value: string): boolean {
  return BUILD_ID_PATTERN.test(value);
}

function validateImageNameSegments(name: string): void {
  const segments = name.split("/");
  if (segments.length === 0) {
    throw new Error(`invalid image name '${name}'`);
  }

  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.length === 0) {
      throw new Error(
        `invalid image name '${name}' (must not contain path traversal segments)`,
      );
    }
    if (!IMAGE_NAME_SEGMENT_PATTERN.test(segment)) {
      throw new Error(
        `invalid image name '${name}' (invalid segment '${segment}')`,
      );
    }
  }
}

/**
 * Parse an image reference (`name[:tag]`).
 *
 * Throws a descriptive error if the reference is invalid.
 */
export function parseImageRef(reference: string): ParsedImageRef {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new Error("image reference must not be empty");
  }

  const colon = trimmed.lastIndexOf(":");
  const hasExplicitTag = colon > 0 && colon < trimmed.length - 1;

  const name = hasExplicitTag ? trimmed.slice(0, colon) : trimmed;
  const tag = hasExplicitTag ? trimmed.slice(colon + 1) : "latest";

  if (!IMAGE_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid image name '${name}' (allowed: letters, numbers, '.', '_', '-', '/')`,
    );
  }
  validateImageNameSegments(name);

  if (!IMAGE_TAG_PATTERN.test(tag)) {
    throw new Error(
      `invalid image tag '${tag}' (allowed: letters, numbers, '.', '_', '-')`,
    );
  }

  return {
    name,
    tag,
    canonical: `${name}:${tag}`,
  };
}

/** Like {@link parseImageRef} but returns `null` for invalid references */
export function tryParseImageRef(reference: string): ParsedImageRef | null {
  try {
    return parseImageRef(reference);
  } catch {
    return null;
  }
}
