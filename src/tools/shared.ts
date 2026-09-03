import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Text, type Component } from "@earendil-works/pi-tui";
import type {
  AgentToolResult,
  ToolRenderResultOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { STALE_MS } from "../core/types";

/** Collapsed → blank tool row (operator doesn't read sit-rep output — it's
 *  for the model). Expanded → the full text. The model always receives the
 *  complete result.content regardless of what the renderer shows. */
export function quietToolResult(
  result: AgentToolResult<unknown>,
  { expanded }: ToolRenderResultOptions,
  theme: Theme,
): Component {
  if (!expanded) return new Text("", 0, 0);
  const t = result.content.find(c => c.type === "text");
  return new Text(t && t.type === "text" ? `\n${theme.fg("toolOutput", t.text)}` : "", 0, 0);
}

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

/** Tabs whose label says "don't close" are user-owned — never touch.
 *  Matches don't close / dont close / do not close (case- and
 *  apostrophe-insensitive, substring match so "don't close — frontend"
 *  and "dont-close-backend" both count). Coordinator can never create
 *  these via picode_tab_create (it rejects spaces/apostrophes), so any
 *  match is unambiguously the user's own tab. */
export function isProtectedTabLabel(label: string | undefined | null): boolean {
  if (!label) return false;
  const normalized = label
    .toLowerCase()
    .replace(/[\u2019\u2018`\u00b4]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  return (
    normalized.includes("don't close") ||
    normalized.includes("dont close") ||
    normalized.includes("do not close")
  );
}

/** Build tab_id → label map from a snapshot `tabs` array. */
export function tabLabelMap(tabs: Array<Record<string, unknown>> | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!tabs) return m;
  for (const t of tabs) {
    const id = t.tab_id as string;
    if (!id) continue;
    m.set(id, (t.label as string) || "");
  }
  return m;
}

/** Herdr resource IDs are workspace-local opaque IDs such as w1:p2 or
 *  w1:t2. Keep shell arguments constrained even though Herdr normally
 *  generates this format. */
export function isValidPaneId(paneId: string): boolean {
  return /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(paneId);
}

/** Check that a Herdr pane/tab ID belongs to current workspace. IDs are
 *  opaque to callers, but Herdr's public format keeps workspace prefix. */
export function belongsToWorkspace(resourceId: string, workspaceId: string): boolean {
  return resourceId.startsWith(`${workspaceId}:`);
}

/** Extract pane info from Herdr's JSON-RPC response. Current Herdr wraps it
 *  as `{ result: { pane: ... } }`; accept direct pane payloads too. */
export function extractPaneInfo(result: Record<string, unknown>): Record<string, unknown> | null {
  const payload = result.result;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const pane = record.pane;
  if (pane && typeof pane === "object") return pane as Record<string, unknown>;
  return typeof record.pane_id === "string" ? record : null;
}

/** Shell-quote a value for safe inclusion in a herdr CLI argument. Single-quote
 *  wrapping with embedded single-quote escaping — standard POSIX sh quoting. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
