import { getSystemErrorName } from "node:util";

export function createErrnoError(
  errno: number,
  syscall: string,
  path?: string,
): NodeJS.ErrnoException {
  let code = "EUNKNOWN";
  try {
    code = getSystemErrorName(errno);
  } catch {
    code = `ERRNO_${errno}`;
  }
  const message = path
    ? `${code}: ${syscall} '${path}'`
    : `${code}: ${syscall}`;
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  error.errno = errno;
  error.syscall = syscall;
  if (path) error.path = path;
  return error;
}
