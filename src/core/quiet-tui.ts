import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { projectRoot } from "./model-config";

/** Operator-screen quiet mode — a DISPLAY-only switch. It hides picode's
 *  traffic rows (envelope batches, system prompts, tool call headers) without
 *  touching the protocol: pi's message/tool renderers and the `display` flag
 *  never affect what the model sees (`convertToLlm` ignores `display`), so
 *  envelopes, obligations, barriers, journal, and status all keep working.
 *
 *  Resolution order: PICODE_QUIET_TUI env (1/0/true/false) → project
 *  quiet-tui.json → global quiet-tui.json → loud (today's view). Render
 *  callbacks get no ctx.cwd, so they read a module-level flag via
 *  isQuietTui(); session_start and /picode-quiet refresh it. */

export type QuietSource = "env" | "project" | "global" | "default";
export type QuietScope = "global" | "project";

const CONFIG_DIR = ".picode";
const FILENAME = "quiet-tui.json";

let quiet = false;

/** What the renderers consult on every draw. */
export function isQuietTui(): boolean {
  return quiet;
}

export function setQuietTui(value: boolean): void {
  quiet = value;
}

/** Config file locations: global lives next to the global models.json,
 *  project at the git root's .picode/ (same dir as the project models.json). */
export function quietTuiPaths(
  cwd = process.cwd(),
  agentDir = getAgentDir(),
): { global: string; project: string } {
  return {
    global: join(agentDir, CONFIG_DIR, FILENAME),
    project: join(projectRoot(cwd), CONFIG_DIR, FILENAME),
  };
}

/** Read one layer's file. Missing, malformed, or non-boolean content means
 *  the layer doesn't apply (fail open to the next layer — a UI preference
 *  must never crash session_start). */
function readQuietFile(path: string): boolean | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "boolean" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Effective quiet mode plus the layer that decided it (status display and
 *  shadowed-write detection depend on knowing the source, not just the value). */
export function resolveQuietTui(
  cwd = process.cwd(),
  agentDir = getAgentDir(),
): { value: boolean; source: QuietSource } {
  const env = process.env.PICODE_QUIET_TUI?.trim().toLowerCase();
  if (env === "1" || env === "true") return { value: true, source: "env" };
  if (env === "0" || env === "false") return { value: false, source: "env" };
  const paths = quietTuiPaths(cwd, agentDir);
  const project = readQuietFile(paths.project);
  if (project !== undefined) return { value: project, source: "project" };
  const global = readQuietFile(paths.global);
  if (global !== undefined) return { value: global, source: "global" };
  return { value: false, source: "default" };
}

/** Persist the preference. Single-key whole-file write (no merge step — this
 *  file has exactly one key). Returns the path written. */
export function writeQuietTui(
  value: boolean,
  scope: QuietScope = "global",
  cwd = process.cwd(),
  agentDir = getAgentDir(),
): string {
  const path = quietTuiPaths(cwd, agentDir)[scope];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value) + "\n");
  return path;
}
