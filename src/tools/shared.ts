import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STALE_MS } from "../core/types";

/** Uniform tool-error payload: message for the model, ok:false for callers. */
export function err(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { ok: false },
  };
}

/** Strip emoji prefix from label to get the role name.
 *  Labels may have emoji prefix like "🔨 builder" — take the last word. */
export function extractRole(label: string): string {
  const parts = label.trim().split(/\s+/);
  return parts[parts.length - 1] || "";
}

/** Herdr's `agent_status` can lie when a worker process dies without a
 *  clean shutdown — it keeps reporting `working`/`blocked` forever because
 *  nothing flips the status on process exit. Picode's own `state.json` has
 *  a heartbeat (`lastSeen`, refreshed every HEARTBEAT_MS=20s) that goes
 *  stale after STALE_MS=60s. Cross-check it: if the picode's heartbeat is
 *  stale, herdr's `working`/`blocked` is almost certainly a lie (the
 *  process is gone) → override to `unknown` so reuse/cleanup logic sees
 *  the truth and doesn't spawn duplicates or protect zombies.
 *
 *  `idle`/`done`/`unknown`/`stopped` are passed through unchanged — a stale
 *  idle worker is still idle (just dead), and cleanup_panes already treats
 *  unknown/stopped as cleanup candidates.
 *
 *  Returns the input status if the picode's state.json can't be found or
 *  parsed (fail-open: don't override on missing data). */
export function effectiveAgentStatus(
  herdrStatus: string,
  picodeId: string,
  staleMs = STALE_MS,
  now: number = Date.now(),
): string {
  // Only working/blocked can be lies — idle/done/unknown/stopped are safe.
  if (herdrStatus !== "working" && herdrStatus !== "blocked") return herdrStatus;

  const statePath = join(process.cwd(), ".picode", "picodes", picodeId, "state.json");
  if (!existsSync(statePath)) return herdrStatus; // fail-open
  try {
    const s = JSON.parse(readFileSync(statePath, "utf8")) as { lastSeen?: string };
    if (!s.lastSeen) return herdrStatus;
    if (now - new Date(s.lastSeen).getTime() > staleMs) return "unknown";
    return herdrStatus;
  } catch {
    return herdrStatus; // fail-open on corrupt/unreadable state
  }
}

/** Herdr pane IDs are workspace-local opaque IDs such as w1:p2. Keep shell
 *  arguments constrained even though Herdr normally generates this format. */
export function isValidPaneId(paneId: string): boolean {
  return /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(paneId);
}

/** Shell-quote a value for safe inclusion in a herdr CLI argument. Single-quote
 *  wrapping with embedded single-quote escaping — standard POSIX sh quoting. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
