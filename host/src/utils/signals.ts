/**
 * Linux signal numbers (the guest is Linux; the host's `os.constants.signals`
 * differ on macOS, e.g. `SIGUSR1`).
 */

const LINUX_SIGNALS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPWR: 30,
  SIGSYS: 31,
} as const;

/** A guest signal: a Linux signal name (`"SIGTERM"`) or number (1-64) */
export type ExecSignalName = keyof typeof LINUX_SIGNALS;

/** Linux signal number of `signal`; throws for unknown names or numbers */
export function linuxSignalNumber(signal: ExecSignalName | number): number {
  if (typeof signal === "number") {
    if (!Number.isInteger(signal) || signal < 1 || signal > 64) {
      throw new Error(`invalid signal number: ${signal} (expected 1-64)`);
    }
    return signal;
  }
  const name = String(signal).toUpperCase();
  const key = (name.startsWith("SIG") ? name : `SIG${name}`) as ExecSignalName;
  const number = LINUX_SIGNALS[key];
  if (number === undefined) {
    throw new Error(`unknown signal: ${String(signal)}`);
  }
  return number;
}
