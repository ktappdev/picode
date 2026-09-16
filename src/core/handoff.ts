import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** A worker's own account of how its contract ended.
 *
 *  Authored by the worker (`picode_finish`), never by the coordinator: the
 *  coordinator knows what it dispatched, the worker knows what actually
 *  happened. It is deliberately *not* a success verdict — models report
 *  "done, all good" while blocked or half-finished — but a handoff: what
 *  landed, and what was left unverified.
 *
 *  This note is enrichment, never a requirement. A worker whose pane was
 *  killed never writes one, and the ledger row still exists (derived from
 *  state.json + the session file). Nothing may depend on this file existing. */
export interface HandoffNote {
  id: string;
  role: string;
  outcome: HandoffOutcome;
  /** What actually landed. Free text, may be empty. */
  changed: string;
  /** What the worker did not check, ran out of scope on, or is unsure of. */
  leftUnverified: string;
  /** ISO timestamp of the finish call. */
  at: string;
}

export type HandoffOutcome = "completed" | "blocked" | "abandoned";

const OUTCOMES: readonly HandoffOutcome[] = ["completed", "blocked", "abandoned"];

/** Handoff notes live beside the picode's state, in its own directory — so
 *  there is no shared file and therefore no cross-process read-modify-write
 *  race, and purging a picode takes its note with it. */
export function handoffPath(picodeDir: string): string {
  return join(picodeDir, "handoff.json");
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isHandoff(value: unknown): value is HandoffNote {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    isString(record.id) &&
    record.id.length > 0 &&
    isString(record.role) &&
    isString(record.outcome) &&
    OUTCOMES.includes(record.outcome as HandoffOutcome) &&
    isString(record.changed) &&
    isString(record.leftUnverified) &&
    isString(record.at) &&
    record.at.length > 0
  );
}

/** Read a picode's handoff note. A missing file, unreadable file, or corrupt
 *  payload all read as absent — presence is never assumed. */
export function readHandoff(picodeDir: string): HandoffNote | null {
  try {
    const value: unknown = JSON.parse(readFileSync(handoffPath(picodeDir), "utf8"));
    return isHandoff(value) ? value : null;
  } catch {
    return null;
  }
}

/** Write a handoff note atomically (write-tmp + rename), so a reader never
 *  sees a partial file. Last write wins — a revived worker's second finish
 *  replaces the first; the accumulated neighbourhood lives in the session,
 *  not here. */
export function writeHandoff(picodeDir: string, note: HandoffNote): void {
  mkdirSync(picodeDir, { recursive: true });
  const path = handoffPath(picodeDir);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(note, null, 2));
  renameSync(temp, path);
}
