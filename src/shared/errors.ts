/**
 * Error class for failures that should NOT be retried by the SQS poller.
 * Examples: invalid event payload, card no longer exists, irreversible config error.
 *
 * Anything else thrown by the orchestrator is treated as transient and the
 * SQS message is left intact so it gets redelivered after the visibility timeout.
 */
export class PermanentError extends Error {
  readonly isPermanent = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

export function isPermanentError(err: unknown): boolean {
  return err instanceof PermanentError
    || (err !== null && typeof err === 'object' && (err as { isPermanent?: boolean }).isPermanent === true);
}

/**
 * Heuristic: treat well-known network / rate-limit / timeout errors as transient.
 * Used as a fallback for errors thrown by libraries we don't control.
 */
export function isLikelyTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  const code = (err as NodeJS.ErrnoException).code;

  const transientCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'];
  if (code && transientCodes.includes(code)) return true;

  return /timeout|timed out|rate ?limit|throttl|503|502|504|temporarily unavailable|service unavailable|network error|socket hang up/i.test(msg);
}
