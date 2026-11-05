/** Electron prefixes errors thrown in the main process; keep only the message. */
export function errorMessage(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
