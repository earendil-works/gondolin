/**
 * Canonical Linux errno values sent to the guest over filesystem RPC
 *
 * Host-side Node.js errors expose platform-neutral `error.code` strings, but
 * `error.errno` numbers are host-OS specific (for example macOS ENOTEMPTY is
 * `66` while Linux ENOTEMPTY is `39`). The guest interprets errno numbers as
 * Linux values, so translate by code first.
 */
export const LINUX_ERRNO: Readonly<Record<string, number>> = Object.freeze({
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,
  E2BIG: 7,
  ENOEXEC: 8,
  EBADF: 9,
  ECHILD: 10,
  EAGAIN: 11,
  EWOULDBLOCK: 11,
  ENOMEM: 12,
  EACCES: 13,
  EFAULT: 14,
  ENOTBLK: 15,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENODEV: 19,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENFILE: 23,
  EMFILE: 24,
  ENOTTY: 25,
  ETXTBSY: 26,
  EFBIG: 27,
  ENOSPC: 28,
  ESPIPE: 29,
  EROFS: 30,
  EMLINK: 31,
  EPIPE: 32,
  EDOM: 33,
  ERANGE: 34,
  EDEADLK: 35,
  EDEADLOCK: 35,
  ENAMETOOLONG: 36,
  ENOLCK: 37,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ELOOP: 40,
  ENOMSG: 42,
  EIDRM: 43,
  ENOSTR: 60,
  ENODATA: 61,
  ETIME: 62,
  ENOSR: 63,
  ENOLINK: 67,
  EPROTO: 71,
  EMULTIHOP: 72,
  EBADMSG: 74,
  EOVERFLOW: 75,
  EILSEQ: 84,
  ENOTSOCK: 88,
  EDESTADDRREQ: 89,
  EMSGSIZE: 90,
  EPROTOTYPE: 91,
  ENOPROTOOPT: 92,
  EPROTONOSUPPORT: 93,
  ESOCKTNOSUPPORT: 94,
  EOPNOTSUPP: 95,
  ENOTSUP: 95,
  EPFNOSUPPORT: 96,
  EAFNOSUPPORT: 97,
  EADDRINUSE: 98,
  EADDRNOTAVAIL: 99,
  ENETDOWN: 100,
  ENETUNREACH: 101,
  ENETRESET: 102,
  ECONNABORTED: 103,
  ECONNRESET: 104,
  ENOBUFS: 105,
  EISCONN: 106,
  ENOTCONN: 107,
  ESHUTDOWN: 108,
  ETOOMANYREFS: 109,
  ETIMEDOUT: 110,
  ECONNREFUSED: 111,
  EHOSTDOWN: 112,
  EHOSTUNREACH: 113,
  EALREADY: 114,
  EINPROGRESS: 115,
  ESTALE: 116,
  EDQUOT: 122,
  ENOMEDIUM: 123,
  EMEDIUMTYPE: 124,
  ECANCELED: 125,
  EOWNERDEAD: 130,
  ENOTRECOVERABLE: 131,
  ERFKILL: 132,
  EHWPOISON: 133,
});

export function toLinuxErrno(
  error: Pick<NodeJS.ErrnoException, "code" | "errno">,
  fallback = LINUX_ERRNO.EIO,
): number {
  if (typeof error.code === "string") {
    const mapped = LINUX_ERRNO[error.code];
    if (mapped !== undefined) {
      return mapped;
    }
  }

  if (typeof error.errno === "number" && Number.isFinite(error.errno)) {
    return Math.abs(Math.trunc(error.errno));
  }

  return fallback;
}
