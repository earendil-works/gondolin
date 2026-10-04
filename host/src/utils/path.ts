import path from "node:path";

/**
 * Check whether `candidate` is `root` itself or located below it.
 *
 * Both paths are resolved first; symlinks are not followed.
 */
export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
