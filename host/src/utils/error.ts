/** Return the message of an `Error`, or the stringified value otherwise */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
