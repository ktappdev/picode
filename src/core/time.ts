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
  const ms = (seconds ?? DEFAULT_OBLIGATION_DEADLINE_MS / 1000) * 1000;
  return new Date(Date.now() + ms).toISOString();
}
