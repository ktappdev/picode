/** Bounded idle polling for the coordinator's periodic sit-rep timer.
 *
 *  The timer exists so a coordinator that still owns worker panes re-checks
 *  their health (zombies, stale barriers, reusable idlers) every
 *  PICODE_SITREP_INTERVAL_MS. Each check is not a poll but a full agent run
 *  over the coordinator's whole context — measured at ~470k tokens of prefill
 *  per turn on a long-lived coordinator — so a picture that never changes must
 *  not be re-checked forever. After SITREP_MAX_IDLE consecutive checks find
 *  nothing new, the timer stops and the session waits in silence for real
 *  activity (an operator message, a delivered envelope) to re-arm it.
 *
 *  Everything here is pure — no clock, no store, no I/O — so the policy is
 *  unit-testable without a herdr socket, a live timer, or a model call. */

/** Consecutive unchanged checks tolerated before the timer stops itself.
 *  `0` disables the cap (poll forever — the behavior before this existed). */
export const SITREP_MAX_IDLE_DEFAULT = 3;

/** Parse `PICODE_SITREP_MAX_IDLE`. Unset, blank, negative, or non-numeric
 *  falls back to the default rather than to "no cap": a typo must not
 *  resurrect the unbounded polling this is here to prevent. */
export function resolveSitrepMaxIdle(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return SITREP_MAX_IDLE_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return SITREP_MAX_IDLE_DEFAULT;
  return Math.floor(parsed);
}

/** The inputs a sit-rep can actually act on. */
export interface SitrepInputs {
  /** Worker panes this picode still owns (herdr tracked-pane count). */
  trackedPanes: number;
  obligations: string[];
  barriers: string[];
  owed: string[];
}

/** Structural fingerprint of the picture a sit-rep inspects.
 *
 *  The picode lifecycle state is deliberately excluded: it flips
 *  open → thinking → done on every run, so including it would make even a
 *  no-op check look like news and the cap would never fire. Undelivered mail
 *  is excluded too — the 20s heartbeat drains it and re-arms the timer through
 *  the inbox hook, so queued traffic never reads as "nothing changed". */
export function sitrepSignature(input: SitrepInputs): string {
  const ids = (values: string[]) => [...values].sort().join(",");
  return [input.trackedPanes, ids(input.obligations), ids(input.barriers), ids(input.owed)].join(
    "|",
  );
}

/** How many consecutive checks have seen the same picture, and what it was. */
export interface SitrepStreak {
  idle: number;
  /** Signature at the last injected check; null before the first one. */
  fingerprint: string | null;
}

/** A fresh streak — the state after any real activity. */
export function initialSitrepStreak(): SitrepStreak {
  return { idle: 0, fingerprint: null };
}

export type SitrepDecision = "inject" | "pause";

/** Fold this tick's signature into the streak and decide what the timer does.
 *
 *  - A signature that differs from the last injected one resets the streak:
 *    the picture moved, so checks are earning their keep again. The first tick
 *    always injects — it establishes the baseline rather than repeating one.
 *  - `maxIdle` unchanged checks are allowed through (each one is a real
 *    chance to find a zombie or a stale barrier), and the check after them
 *    pauses instead of injecting. With the default of 3 that is four sit-reps
 *    total — one baseline plus three no-change checks — and then silence.
 *  - `maxIdle = 0` never pauses. */
export function advanceSitrep(
  prev: SitrepStreak,
  signature: string,
  maxIdle: number,
): { streak: SitrepStreak; decision: SitrepDecision } {
  if (prev.fingerprint !== signature) {
    return { streak: { idle: 0, fingerprint: signature }, decision: "inject" };
  }
  const idle = prev.idle + 1;
  if (maxIdle > 0 && idle > maxIdle) {
    return { streak: { idle, fingerprint: prev.fingerprint }, decision: "pause" };
  }
  return { streak: { idle, fingerprint: signature }, decision: "inject" };
}
