import { DEFAULT_OBLIGATION_DEADLINE_MS } from "./types";

export function nowIso(): string {
  return new Date().toISOString();
}

/** Convert a user-facing `deadlineSeconds`/`fireInSeconds` offset into the
 *  absolute ISO timestamp stored in state. Falls back to the default
 *  obligation deadline (15 min) when no seconds are given, so
 *  barriers and obligations without an explicit deadline still get a
 *  one-time overdue nudge from checkDeadlines (§9.2). */
export function deadlineFromSeconds(seconds?: number): string {
  // Caller passes seconds (or omits for the default). Multiply to ms.
  // Reject ≤0 explicitly — a zero or negative deadline would be in the
  // past the instant we mint it, and the inbox would treat the envelope
  // as undeliverable on the first sweep, silently dropping the request.
  const totalMs = seconds === undefined
    ? DEFAULT_OBLIGATION_DEADLINE_MS
    : seconds * 1000;
  if (totalMs <= 0) {
    throw new RangeError(`deadlineSeconds must be > 0, got ${seconds}`);
  }
  return new Date(Date.now() + totalMs).toISOString();
}
