import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { PicodeStore } from "../core/types";
import { resolveModelForRole } from "../core/model-config";
import type { TuiosRuntime, TuiosWindow } from "../runtime/tuios";
import { resolveTheme, resolveThinking } from "./spawn";
import { validateLabel } from "./tab-create";
import {
  err,
  extractRole,
  isProtectedTabLabel,
  quietCallRenderer,
  quietToolResult,
  shellQuote,
} from "./shared";

/**
 * TUIOS model-facing pane tools.
 *
 * The public tool names, parameters and core result fields match the Herdr
 * tools in `spawn.ts`, `panes.ts`, `pane-read.ts`, `cleanup-panes.ts`,
 * `tab-create.ts` and `tab-close.ts` so a coordinator is backend-agnostic.
 *
 * TUIOS topology mapping (see PLAN-tuios-runtime.md):
 *   Herdr workspace → TUIOS session   (the routing/scope boundary)
 *   Herdr tab       → TUIOS workspace (a fixed slot numbered 1..9)
 *   Herdr pane      → TUIOS window
 *
 * The differences that shape this file:
 * - TUIOS workspaces are fixed slots 1..9, not deletable objects. "Tab create"
 *   therefore claims an unused empty slot by naming it; workers launch directly
 *   into it. "Tab close" empties a workspace and clears its name but never
 *   claims the physical slot was destroyed.
 * - `new-window` takes an argv `command` that no shell parses, so a worker is
 *   launched without building or quoting a shell line.
 * - Workers tile via `split-window`, which divides an existing pane through
 *   the attached client's BSP (like Herdr's split). It runs a shell in the
 *   new pane, so Pi is sent as text. Falls back to `new-window` when there
 *   is nothing to split (empty workspace) or tiling is off.
 */

/** Pane-size floors for split candidates, as workspace-area ratios — same
 *  thresholds Herdr uses (screen-size independent). */
const MIN_PANE_RATIO = 0.2;
const MIN_RESULT_RATIO = 0.15;
/** Cap panes per workspace before overflow — matches the Herdr grid of 4. */
const MAX_GRID_PANES = 4;

/** Worker role labels (same pattern as spawn.ts / cleanup-panes.ts). Used to
 *  decide what cleanup may touch — a window with no worker-role label is
 *  never bulk-closed, which keeps user shells and the coordinator safe. */
const WORKER_ROLE_PATTERN =
  /^(builder|reviewer|tester|worker|scout|bug-hunter|designer|planner|runner|visionary|gauntlet|explorer)(-[0-9]+)?$/i;

/** Agent statuses Picode reasons about after the runtime normalizes TUIOS's
 *  `agent_state` (`needs_input` → `blocked`, `none`/`errored` → `unknown`).
 *  A status outside this set is malformed metadata: cleanup and tab close fail
 *  closed rather than guessing whether a window is safe to remove. `unknown`
 *  is recognized for reporting but cleanup refuses it: missing telemetry is
 *  not proof that the process stopped. */
const KNOWN_STATUSES = new Set(["working", "blocked", "idle", "done", "unknown"]);

/** Capture sources exposed to the model, mapped onto TUIOS `capture-pane`.
 *  TUIOS accepts `visible` and `recent` only (plus `last-command-output`);
 *  it has no unwrapped or detection buffer, so those Herdr-era names collapse
 *  onto `recent` and tell the caller so. */
const CAPTURE_SOURCES: Record<string, { source: "visible" | "recent"; warning?: string }> = {
  visible: { source: "visible" },
  recent: { source: "recent" },
  "recent-unwrapped": {
    source: "recent",
    warning:
      'source "recent-unwrapped" does not exist in TUIOS; captured "recent" (physically wrapped rows) instead.',
  },
  detection: {
    source: "recent",
    warning: 'source "detection" does not exist in TUIOS; captured "recent" instead.',
  },
};

const DEFAULT_READ_LINES = 80;
const MAX_READ_LINES = 500;
const WAIT_TIMEOUT_MS = 30_000;
/** Client timeout must exceed the wait-for timeout or the socket gives up first. */
const WAIT_CLIENT_TIMEOUT_MS = WAIT_TIMEOUT_MS + 5_000;

/** Optional wiring the parent supplies. Kept out of the tools so this module
 *  never imports the Herdr listener or assumes a TUIOS event subscriber. */
export interface TuiosToolHooks {
  /** Called with each window id Picode creates, so the runtime's event
   *  listener can track it for death notices. */
  trackPane?: (paneId: string) => void;
  untrackPane?: (paneId: string) => void;
}

type ToolOk = { ok: true } & Record<string, unknown>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ok(details: ToolOk) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

/** Role name validation — prevents a caller-supplied role reaching argv. */
function validateRole(role: string): string | null {
  if (role.length > 32) {
    return `role too long: ${role.length} chars (max 32)`;
  }
  if (!/^[a-zA-Z0-9-]+$/.test(role)) {
    return `role contains invalid characters: ${role} (only a-z, A-Z, 0-9, hyphen)`;
  }
  return null;
}

/** Check if a PID is alive (same logic as spawn.ts / state.ts). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true; // EPERM or other — process exists
  }
}

/** A picode-id is taken when a live window carries it, or when its state.json
 *  says running with a PID that is still alive. A stale state file from a
 *  crashed process does not count. */
function threadIdExists(paneRoles: Set<string>, picodeId: string): boolean {
  if (paneRoles.has(picodeId.toLowerCase())) return true;

  const statePath = join(process.cwd(), ".picode", "picodes", picodeId, "state.json");
  if (!existsSync(statePath)) return false;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { status?: string; pid?: number };
    if (state.status !== "running") return false;
    if (typeof state.pid === "number" && !isPidAlive(state.pid)) return false;
    return true;
  } catch {
    return false; // corrupt state file — don't count it
  }
}

/** Generate a unique picode-id by suffixing -1, -2, … if the role is taken. */
function uniquePicodeId(role: string, paneRoles: Set<string>): string {
  if (!threadIdExists(paneRoles, role)) return role;
  let suffix = 1;
  while (threadIdExists(paneRoles, `${role}-${suffix}`)) suffix++;
  return `${role}-${suffix}`;
}

/** Reuse an idle/done window already labelled with the role, but only inside
 *  the target workspace: reusing across workspaces would break tab isolation.
 *  A window in any other state is left for `cleanup_panes` rather than having
 *  `pi` launched into an unknown process. */
function canonicalCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function findReusablePane(
  runtime: TuiosRuntime,
  role: string,
  workspace: number,
  cwd: string,
): TuiosWindow | null {
  for (const window of runtime.panes) {
    if (window.workspace !== workspace) continue;
    if (window.id === runtime.ownPane) continue;
    if (window.status !== "idle" && window.status !== "done") continue;
    if (extractRole(window.label).toLowerCase() !== role.toLowerCase()) continue;
    if (canonicalCwd(window.cwd) !== canonicalCwd(cwd)) continue;
    return window;
  }
  return null;
}

/** Build the worker's argv. `new-window` execs this directly — no shell parses
 *  it, so nothing needs quoting and nothing can be injected. */
function buildWorkerArgv(options: {
  picodeId: string;
  role: string;
  model: string | null;
  theme: string | null;
}): string[] {
  const argv = ["env", "PICODE_RUNTIME=tuios", "pi"];
  if (options.model) argv.push("--model", options.model);
  if (options.theme) argv.push("--theme", options.theme);
  const thinking = resolveThinking(options.role);
  if (thinking) argv.push("--thinking", thinking);
  argv.push("--picode-id", options.picodeId);
  return argv;
}

/** Shell line typed into a split-created pane. Unlike new-window's argv, this
 *  is parsed by the pane's shell, so every value is quoted. cd + exec so the
 *  pane lands in the right directory and pi replaces the shell. */
function buildWorkerShellCommand(options: {
  picodeId: string;
  role: string;
  model: string | null;
  theme: string | null;
  cwd: string;
}): string {
  const piArgs: string[] = [`env PICODE_RUNTIME=tuios pi`];
  if (options.model) piArgs.push(`--model ${shellQuote(options.model)}`);
  if (options.theme) piArgs.push(`--theme ${shellQuote(options.theme)}`);
  const thinking = resolveThinking(options.role);
  if (thinking) piArgs.push(`--thinking ${thinking}`);
  piArgs.push(`--picode-id ${shellQuote(options.picodeId)}`);
  // cd first, then exec pi so it replaces the pane's shell.
  return `cd ${shellQuote(options.cwd)} && exec ${piArgs.join(" ")}`;
}

interface SplitTarget {
  paneId: string;
  direction: "right" | "down";
}

function isCoordinatorLabel(label: string): boolean {
  return extractRole(label).toLowerCase() === "coordinator";
}

/** Mirror of Herdr's getSplitTarget: pick the largest non-coordinator pane in
 *  the workspace; never split the coordinator when a worker exists; overflow
 *  (return null) once the grid reaches MAX_GRID_PANES so the caller opens a
 *  new workspace. Empty workspace → split the sole pane even without an agent.
 */
function getSplitTarget(
  runtime: TuiosRuntime,
  role: string,
  workspace: number,
): SplitTarget | null {
  const panes = runtime.panes.filter(w => w.workspace === workspace);
  if (panes.length === 0) return null;
  if (panes.length >= MAX_GRID_PANES) return null;

  // Workspace area from the bounding box of its panes (daemon tracks rects).
  let maxX = 0,
    maxY = 0;
  for (const p of panes) {
    maxX = Math.max(maxX, p.rect.x + p.rect.width);
    maxY = Math.max(maxY, p.rect.y + p.rect.height);
  }
  const minW = maxX * MIN_PANE_RATIO;
  const minH = maxY * MIN_PANE_RATIO;

  let best: TuiosWindow | null = null;
  let bestScore = -1;
  for (const w of panes) {
    if (w.id === runtime.ownPane) continue;
    if (isCoordinatorLabel(w.label)) continue;
    if (w.rect.width <= 0 || w.rect.height <= 0) continue;
    let score = w.rect.width * w.rect.height;
    if (w.rect.width < minW || w.rect.height < minH) score *= 0.3;
    if (w.status !== "idle" && w.status !== "done") score *= 0.5;
    if (extractRole(w.label).toLowerCase() === role.toLowerCase()) score *= 1.2;
    if (score > bestScore) {
      bestScore = score;
      best = w;
    }
  }

  // First-worker-in-workspace: the only pane is the coordinator (or a bare
  // shell with no agent). Split it so the grid starts beside it.
  if (!best) {
    if (panes.length === 1) {
      const only = panes[0];
      return { paneId: only.id, direction: "right" };
    }
    return null;
  }
  return { paneId: best.id, direction: computeSplitDirection(best, maxX, maxY, panes) };
}

/** Mirror of Herdr's computeDirection: split the wider axis, balance the grid
 *  when one axis is already saturated. */
function computeSplitDirection(
  pane: TuiosWindow,
  wsWidth: number,
  wsHeight: number,
  panes: TuiosWindow[],
): "right" | "down" {
  const { width, height } = pane.rect;
  if (height > width * 2) return "down";
  if (width > height * 4) return "right";
  const rightOk = width / 2 >= wsWidth * MIN_RESULT_RATIO;
  const downOk = height / 2 >= wsHeight * MIN_RESULT_RATIO;
  if (rightOk && !downOk) return "right";
  if (downOk && !rightOk) return "down";

  const tol = Math.max(width, height) * 0.1;
  let vStack = 0,
    hRow = 0;
  for (const p of panes) {
    if (Math.abs(p.rect.x - pane.rect.x) < tol) vStack++;
    if (Math.abs(p.rect.y - pane.rect.y) < tol) hRow++;
  }
  if (vStack >= 3 && rightOk) return "right";
  if (hRow >= 3 && downOk) return "down";
  return width > height * 1.5 ? "right" : "down";
}

function resolveModel(role: string, override?: string): string {
  return override || resolveModelForRole(role);
}

/** The current workspace number, or 0 when the snapshot has not resolved one
 *  yet. 0 matches no real workspace, so protection checks simply never fire. */
function ownWorkspaceNumber(runtime: TuiosRuntime): number {
  try {
    return runtime.tabNumber(runtime.tabId);
  } catch {
    return 0;
  }
}

function workspaceName(runtime: TuiosRuntime, workspace: number): string {
  return runtime.tabs.find(tab => tab.number === workspace)?.name ?? "";
}

export function registerTuiosTools(
  pi: ExtensionAPI,
  store: PicodeStore,
  runtime: TuiosRuntime,
  hooks: TuiosToolHooks = {},
) {
  // --- spawn_worker ------------------------------------------------------
  pi.registerTool({
    name: "spawn_worker",
    label: "Spawn Worker",
    description:
      "Spawn a new worker window in one call: creates a TUIOS window with an argv Pi launch, names it, and waits for it to report idle. Coordinator-only.",
    promptSnippet:
      "Spawn a new worker window in one call: create, name, launch pi, wait for idle (coordinator only).",
    parameters: Type.Object({
      role: Type.String({
        description: "Worker role / picode-id (e.g. 'builder', 'visionary', 'scout', 'worker-1')",
      }),
      direction: Type.Optional(
        Type.Union([Type.Literal("right"), Type.Literal("down")], {
          description:
            "Advisory only under TUIOS: windows are placed by the daemon, not split from a target. Recorded in the result as a warning.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Override model (provider/model). Omit to use project override, global default, or built-in default.",
        }),
      ),
      theme: Type.Optional(
        Type.String({
          description:
            "Override theme name or path. Omit to use project config, then global config.",
        }),
      ),
      reuse: Type.Optional(
        Type.Boolean({
          description:
            "If false, always create a new window. Default: true (reuse an idle/done window already labelled with the role in the target workspace).",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Worker working directory. Default: current project directory.",
        }),
      ),
      tab: Type.Optional(
        Type.String({
          description:
            "Tab ID to spawn in (e.g. tuios:<session-id>:t3). Default: the coordinator's current workspace. Get one from picode_panes() or picode_tab_create.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (store.role !== "coordinator") {
        return err("spawn_worker is coordinator-only — send work to your coordinator instead.");
      }
      try {
        const roleError = validateRole(params.role);
        if (roleError) return err(`invalid role: ${roleError}`);

        await runtime.refresh();

        // The target tab is addressed by its exact id; tabNumber + tab() reject
        // anything outside this session and assertWritableTab rejects a
        // user-owned ("don't close") workspace.
        const targetTabId = params.tab || runtime.tabId;
        let targetWorkspace: number;
        try {
          targetWorkspace = runtime.assertWritableTab(targetTabId).number;
        } catch (e) {
          return err(
            `${message(e)} Get an exact tab ID from picode_panes() or picode_tab_create().`,
          );
        }

        const paneRoles = new Set(
          runtime.panes.map(window => extractRole(window.label).toLowerCase()).filter(Boolean),
        );

        const targetCwd = params.cwd || process.cwd();
        const reusable =
          params.reuse !== false
            ? findReusablePane(runtime, params.role, targetWorkspace, targetCwd)
            : null;
        if (reusable) {
          const actualRole = extractRole(reusable.label) || params.role;
          const model = resolveModel(actualRole, params.model);
          const theme = resolveTheme(params.theme);
          hooks.trackPane?.(reusable.id);
          return ok({
            ok: true,
            pane_id: reusable.id,
            role: actualRole,
            model: model || "(pi default)",
            theme: theme || "(none)",
            reused: true,
            tab_id: runtime.tabFor(targetWorkspace),
          });
        }

        const model = resolveModel(params.role, params.model);
        const theme = resolveTheme(params.theme);
        const uniqueId = uniquePicodeId(params.role, paneRoles);
        const argv = buildWorkerArgv({
          picodeId: uniqueId,
          role: params.role,
          model,
          theme,
        });

        // Prefer a real BSP split (Herdr-style grid) over a floating
        // new-window. getSplitTarget returns null when the workspace is empty
        // (nothing to split) or full (≥ MAX_GRID_PANES → overflow to a new
        // workspace instead of overcrowding).
        const splitTarget = getSplitTarget(runtime, params.role, targetWorkspace);
        const paramsDirection: "right" | "down" | undefined =
          params.direction === "right" || params.direction === "down"
            ? params.direction
            : undefined;
        let windowId = "";
        let usedSplit = false;
        let splitError: string | undefined;
        let warning: string | undefined;
        if (splitTarget) {
          const direction = paramsDirection ?? splitTarget.direction;
          try {
            const createdId = await runtime.split(splitTarget.paneId, direction);
            if (createdId) {
              windowId = createdId;
              usedSplit = true;
              await runtime.rename(windowId, uniqueId);
              // The split pane runs a plain shell: cd + exec pi into it.
              await runtime.sendText(
                windowId,
                buildWorkerShellCommand({
                  picodeId: uniqueId,
                  role: params.role,
                  model,
                  theme,
                  cwd: targetCwd,
                }) + "\r",
              );
            } else {
              splitError = "split-window returned no window id";
            }
          } catch (e) {
            // needs_client (no attached TUI / headless session) or tiling off →
            // fall back to a floating new-window rather than failing the spawn.
            splitError = message(e);
          }
        }
        if (!usedSplit) {
          // Nothing to split (empty workspace) or grid full — create directly.
          try {
            const created = await runtime.call("new-window", {
              name: uniqueId,
              workspace: targetWorkspace,
              cwd: targetCwd,
              focus: false,
              command: argv,
            });
            windowId = typeof created.window_id === "string" ? created.window_id : "";
            if (!windowId) {
              return err(`TUIOS new-window returned no window_id: ${JSON.stringify(created)}`);
            }
          } catch (e) {
            return err(`TUIOS new-window failed: ${message(e)}`);
          }
          if (splitError) {
            warning = `split unavailable (${splitError}); used a floating window`;
          }
        }
        if (!windowId) {
          return err("TUIOS did not produce a window for the worker.");
        }

        // TUIOS currently leaves cwd empty for daemon-created windows in its
        // snapshots, so retain the directory we just successfully launched in.
        runtime.rememberWindowCwd(windowId, targetCwd);
        // Track immediately so an exit during the readiness wait cannot be
        // lost between the create response and listener registration.
        hooks.trackPane?.(windowId);
        try {
          await runtime.call(
            "wait-for",
            {
              condition: "agent-state",
              window: windowId,
              until: "idle",
              timeout: WAIT_TIMEOUT_MS,
            },
            WAIT_CLIENT_TIMEOUT_MS,
          );
        } catch {
          warning = "agent did not report idle/done within 30s — it may still be starting.";
        }
        try {
          await runtime.refresh();
          runtime.pane(windowId);
        } catch {
          hooks.untrackPane?.(windowId);
          return err(`Worker window ${windowId} closed before spawn_worker completed.`);
        }

        if (params.direction && !usedSplit) {
          const directionNote =
            "direction ignored: workspace had nothing to split, so the window was placed by the daemon.";
          warning = warning ? `${warning} ${directionNote}` : directionNote;
        }

        return ok({
          ok: true,
          pane_id: windowId,
          role: params.role,
          model: model || "(pi default)",
          theme: theme || "(none)",
          reused: false,
          tab_id: runtime.tabFor(targetWorkspace),
          ...(warning ? { warning } : {}),
        });
      } catch (e) {
        return err(`spawn_worker unexpected error: ${message(e)}`);
      }
    },
    renderCall: quietCallRenderer("spawn_worker"),
    renderResult: quietToolResult,
  });

  // --- picode_panes ------------------------------------------------------
  pi.registerTool({
    name: "picode_panes",
    label: "Picode Panes",
    description:
      "Survey TUIOS windows in the current session. Shows agent status, workspace, and role for each window. Use this to check which workers are idle (reuse them), working (leave alone), or stopped (clean them up).",
    promptSnippet:
      "Survey current-session TUIOS windows: status, workspace, role (find idle workers to reuse).",
    parameters: Type.Object({
      workspace: Type.Optional(
        Type.String({
          description:
            "Compatibility filter. Must exactly match the current TUIOS session scope; omit it to use the current session automatically.",
        }),
      ),
      status: Type.Optional(
        Type.String({
          description:
            "Filter by agent_status: idle, working, blocked, done, unknown. Default: all.",
        }),
      ),
      includeLayout: Type.Optional(
        Type.Boolean({ description: "Include the window rect. Default: false." }),
      ),
    }),
    async execute(_id, params) {
      if (params.workspace && params.workspace !== runtime.workspaceId) {
        return err(
          `workspace "${params.workspace}" is outside the current TUIOS session "${runtime.workspaceId}". Picode pane tools are session-locked; omit workspace or use the exact current id.`,
        );
      }

      try {
        await runtime.refresh();
        const tabNames = new Map(runtime.tabs.map(tab => [runtime.tabFor(tab.number), tab.name]));

        let windows = runtime.panes.filter(window => window.status !== undefined);
        if (params.status) windows = windows.filter(window => window.status === params.status);

        const summaries = windows.map(window => {
          const tabId = runtime.tabFor(window.workspace);
          const tabName = tabNames.get(tabId) ?? "";
          const inProtectedTab = isProtectedTabLabel(tabName);

          let suggestion: string;
          if (window.id === runtime.ownPane) {
            suggestion = "SELF: this coordinator's own window — off-limits";
          } else if (inProtectedTab) {
            suggestion = `OFF-LIMITS: user-owned workspace ("don't close") — leave alone`;
          } else if (window.status === "working") {
            suggestion = "LEAVE: currently working";
          } else if (window.status === "blocked") {
            suggestion = "CHECK: blocked — may need input";
          } else if (window.status === "idle" || window.status === "done") {
            suggestion = "REUSE: idle and available for new work";
          } else {
            suggestion = "UNKNOWN: do not close until agent state is available";
          }

          return {
            pane_id: window.id,
            label: window.label,
            agent_status: window.status,
            workspace_id: runtime.workspaceId,
            tab_id: tabId,
            cwd: window.cwd,
            ...(params.includeLayout ? { rect: window.rect } : {}),
            suggestion,
          };
        });

        const idleCount = summaries.filter(
          s => s.agent_status === "idle" || s.agent_status === "done",
        ).length;
        const workingCount = summaries.filter(s => s.agent_status === "working").length;
        const blockedCount = summaries.filter(s => s.agent_status === "blocked").length;
        const unknownCount = summaries.filter(s => s.agent_status === "unknown").length;

        const lines: string[] = [];
        lines.push(
          `Panes: ${summaries.length} total (${workingCount} working, ${idleCount} idle, ${blockedCount} blocked, ${unknownCount} unknown)`,
        );
        lines.push("");

        const byTab = new Map<string, typeof summaries>();
        for (const summary of summaries) {
          const bucket = byTab.get(summary.tab_id) ?? [];
          bucket.push(summary);
          byTab.set(summary.tab_id, bucket);
        }

        for (const [tabId, tabPanes] of byTab) {
          let number: number;
          try {
            number = runtime.tabNumber(tabId);
          } catch {
            number = 0;
          }
          const name = tabNames.get(tabId) ?? "";
          const header = `Workspace ${number}${name ? ` ("${name}")` : ""}`;
          lines.push(
            `${header}${isProtectedTabLabel(name) ? ' — OFF-LIMITS ("don\'t close")' : ""}`,
          );
          for (const pane of tabPanes) {
            const rectStr = pane.rect
              ? ` [${pane.rect.x}x${pane.rect.y}, ${pane.rect.width}x${pane.rect.height}]`
              : "";
            lines.push(
              `  ${pane.pane_id}  ${pane.label.padEnd(20)} ${pane.agent_status.padEnd(10)} ${pane.cwd}${rectStr}`,
            );
            lines.push(`    → ${pane.suggestion}`);
          }
          lines.push("");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n") || `Session ${runtime.workspaceId} — no windows found.`,
            },
          ],
          details: {
            ok: true,
            workspace_id: runtime.workspaceId,
            total: summaries.length,
            byStatus: {
              working: workingCount,
              idle: idleCount,
              blocked: blockedCount,
              unknown: unknownCount,
            },
            panes: summaries,
          },
        };
      } catch (e) {
        return err(`picode_panes unexpected error: ${message(e)}`);
      }
    },
    renderCall: quietCallRenderer("picode_panes"),
    renderResult: quietToolResult,
  });

  // --- picode_pane_read --------------------------------------------------
  pi.registerTool({
    name: "picode_pane_read",
    label: "Read Pane Output",
    description:
      "Read a worker window's terminal output (capture-pane). Use for silent worker recovery — when a worker owes a reply but hasn't sent one via picode_send, read its window to find a plain-text answer. Also for inspecting blocked workers or error output.",
    promptSnippet:
      "Read a worker window's terminal output — silent worker recovery, inspect blocked/stuck workers.",
    parameters: Type.Object({
      pane_id: Type.String({
        description:
          "Window ID to read. Get it from picode_panes() or a spawn_worker return. Exact IDs only — names and prefixes are not accepted.",
      }),
      lines: Type.Optional(
        Type.Number({ description: `Number of lines to read. Default: ${DEFAULT_READ_LINES}.` }),
      ),
      source: Type.Optional(
        Type.String({
          description:
            "Read source: 'recent' (default), 'visible' (current viewport). 'recent-unwrapped' and 'detection' are Herdr-era names and fall back to 'recent' with a warning.",
        }),
      ),
      format: Type.Optional(
        Type.String({
          description:
            "Output format: 'text' (default) or 'ansi' (preserves colors/styling — use when terminal styling is evidence).",
        }),
      ),
    }),
    async execute(_id, params) {
      const paneId = (params.pane_id || "").trim();
      if (!paneId) {
        return err("pane_id is required — get it from picode_panes() or a spawn_worker return.");
      }
      // Reading our own output is never useful and wastes a turn.
      if (paneId === runtime.ownPane) {
        return err(
          `pane_id ${paneId} is this coordinator's own window — reading it is not useful. Pass a worker window ID instead.`,
        );
      }

      const lines = params.lines ?? DEFAULT_READ_LINES;
      if (lines < 1 || lines > MAX_READ_LINES) {
        return err(`lines must be between 1 and ${MAX_READ_LINES}, got ${lines}.`);
      }

      const requestedSource = params.source ?? "recent";
      const mapped = CAPTURE_SOURCES[requestedSource];
      if (!mapped) {
        return err(
          `source must be one of: ${Object.keys(CAPTURE_SOURCES).join(", ")}. Got: ${requestedSource}.`,
        );
      }

      const format = params.format ?? "text";
      if (format !== "text" && format !== "ansi") {
        return err(`format must be 'text' or 'ansi'. Got: ${format}.`);
      }

      try {
        await runtime.refresh();
        // Exact-ID lookup against the current snapshot: a name or prefix that
        // capture-pane would resolve for us never reaches the daemon.
        try {
          runtime.pane(paneId);
        } catch {
          return err(
            `Pane ${paneId} is not in this session — it may have been closed. Run picode_panes() to see current windows.`,
          );
        }

        const captured = await runtime.call("capture-pane", {
          window: paneId,
          source: mapped.source,
          lines,
          styled: format === "ansi",
        });
        const content = typeof captured.content === "string" ? captured.content : "";
        const warning = mapped.warning;
        const text = `${warning ? `[note] ${warning}\n\n` : ""}${content || `(no output from pane ${paneId})`}`;
        return {
          content: [{ type: "text" as const, text }],
          details: {
            ok: true,
            pane_id: paneId,
            lines,
            source: mapped.source,
            format,
            bytes: content.length,
            ...(warning ? { warning } : {}),
          },
        };
      } catch (e) {
        return err(`picode_pane_read failed: ${message(e)}`);
      }
    },
    renderCall: quietCallRenderer("picode_pane_read"),
    renderResult: quietToolResult,
  });

  // --- cleanup_panes -----------------------------------------------------
  pi.registerTool({
    name: "cleanup_panes",
    label: "Cleanup Panes",
    description:
      "Close stale TUIOS worker windows spawned by the coordinator. Removes windows with worker role labels that are not working. Pass pane_id to close a specific window. Pass force=true to close idle workers too (e.g. when user says 'close all').",
    promptSnippet:
      "Close stale TUIOS worker windows (use when the session is cluttered with dead workers).",
    parameters: Type.Object({
      dry_run: Type.Optional(
        Type.Boolean({
          description: "If true, list what would be closed without actually closing them.",
        }),
      ),
      pane_id: Type.Optional(
        Type.String({
          description:
            "Close a specific window by exact ID. When provided, only that window is targeted — no bulk scan. Get the ID from picode_panes().",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "If true, close idle workers too — not just stale ones. Use when user says 'close all'. Default: false.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (store.role !== "coordinator") {
        return err("cleanup_panes is coordinator-only — report pane problems to your coordinator.");
      }

      try {
        await runtime.refresh();
      } catch (e) {
        return err(`cleanup_panes cannot read the TUIOS session: ${message(e)}`);
      }

      try {
        // --- Targeted mode: close one exact window ---
        if (params.pane_id) {
          const targetId = params.pane_id.trim();
          let pane: TuiosWindow;
          try {
            pane = runtime.pane(targetId);
          } catch {
            return err(
              `Pane ${targetId} not found — it may already be closed. Run picode_panes() to see current windows.`,
            );
          }

          if (targetId === runtime.ownPane) {
            return err(
              `pane_id ${targetId} is this coordinator's own window — refusing to close. Pass a worker window ID.`,
            );
          }
          if (!KNOWN_STATUSES.has(pane.status)) {
            return err(
              `Pane ${targetId} reports an unrecognized status "${pane.status}" — refusing to close. Run picode_panes() to inspect it.`,
            );
          }
          const tabName = workspaceName(runtime, pane.workspace);
          if (isProtectedTabLabel(tabName)) {
            return err(
              `Pane ${targetId} is in user-owned workspace "${tabName}" ("don't close") — refusing to close. That workspace is off-limits.`,
            );
          }
          if (pane.status === "working" || pane.status === "blocked" || pane.status === "unknown") {
            return err(
              `Pane ${targetId} is ${pane.status} — cleanup_panes protects active, blocked, and unknown windows. Install TUIOS's Pi agent-state integration or close it manually.`,
            );
          }
          if (pane.status === "idle" && !params.force) {
            return err(`Pane ${targetId} is idle — pass force=true to close idle workers.`);
          }

          if (params.dry_run) {
            return ok({
              ok: true,
              action: "would close",
              closed: [targetId],
              skipped: [],
              count: 1,
            });
          }

          try {
            await runtime.close(targetId);
          } catch (e) {
            return err(`Pane ${targetId} close failed: ${message(e)}`);
          }
          return ok({ ok: true, action: "closed", closed: [targetId], skipped: [], count: 1 });
        }

        // --- Bulk mode: scan and close stale worker windows ---
        const toClose: string[] = [];
        const skipped: string[] = [];

        for (const window of runtime.panes) {
          // Never close the pane running this tool.
          if (window.id === runtime.ownPane) {
            skipped.push(window.id);
            continue;
          }
          // Never touch a window inside a user-owned workspace.
          if (isProtectedTabLabel(workspaceName(runtime, window.workspace))) continue;
          // Only worker-role windows are bulk-closable; user shells and
          // anything unlabelled are out of scope.
          if (!WORKER_ROLE_PATTERN.test(extractRole(window.label))) continue;
          // Malformed status: fail closed and leave it for inspection.
          if (!KNOWN_STATUSES.has(window.status)) {
            skipped.push(window.id);
            continue;
          }
          // Without Pi agent-state integration, a live worker reports none/
          // unknown. Never interpret missing telemetry as permission to kill it.
          if (
            window.status === "working" ||
            window.status === "blocked" ||
            window.status === "unknown"
          ) {
            skipped.push(window.id);
            continue;
          }
          // Idle windows need force=true.
          if (window.status === "idle" && !params.force) {
            skipped.push(window.id);
            continue;
          }
          toClose.push(window.id);
        }

        const closed: string[] = [];
        if (!params.dry_run) {
          for (const windowId of toClose) {
            try {
              await runtime.close(windowId);
              closed.push(windowId);
            } catch {
              // Do not claim a failed close succeeded.
            }
          }
        }

        const result = params.dry_run ? toClose : closed;
        return ok({
          ok: true,
          action: params.dry_run ? "would close" : "closed",
          closed: result,
          skipped,
          count: result.length,
        });
      } catch (e) {
        return err(`cleanup_panes unexpected error: ${message(e)}`);
      }
    },
    renderCall: quietCallRenderer("cleanup_panes"),
    renderResult: quietToolResult,
  });

  // --- picode_tab_create -------------------------------------------------
  pi.registerTool({
    name: "picode_tab_create",
    label: "Create Tab",
    description:
      "Claim an unused TUIOS workspace (1-9) for worker spawning when the current workspace is full. TUIOS slots are named but no root shell is created; spawn workers directly with spawn_worker(tab=<tab_id>). root_pane_id is null because no root window exists.",
    promptSnippet: "Claim an unused TUIOS workspace slot for worker spawning.",
    parameters: Type.Object({
      label: Type.Optional(
        Type.String({
          description:
            "Workspace label (e.g. 'frontend', 'workers-2'). Default: workers-<slot> so the claimed slot is not selected twice.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Compatibility parameter; an empty TUIOS workspace has no cwd. Pass the desired cwd to spawn_worker instead.",
        }),
      ),
      focus: Type.Optional(
        Type.Boolean({
          description:
            "Compatibility parameter; TUIOS cannot focus an empty workspace without opening a window.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (store.role !== "coordinator") {
        return err(
          "picode_tab_create is coordinator-only — request a new tab from your coordinator.",
        );
      }

      const requestedLabel = (params.label || "").trim();
      if (requestedLabel) {
        const labelError = validateLabel(requestedLabel);
        if (labelError) return err(`invalid label: ${labelError}`);
      }

      try {
        await runtime.refresh();
      } catch (e) {
        return err(`picode_tab_create cannot read the TUIOS session: ${message(e)}`);
      }

      try {
        // TUIOS workspaces are fixed slots 1..9. Claim one that is empty, has
        // no name of its own, and is not the coordinator's own workspace — so
        // an existing (possibly user-owned) workspace is never reused.
        const ownWorkspace = ownWorkspaceNumber(runtime);
        const occupied = new Set(runtime.panes.map(window => window.workspace));
        const candidate = runtime.tabs.find(
          tab =>
            tab.number >= 1 &&
            tab.number <= 9 &&
            tab.number !== ownWorkspace &&
            tab.windowCount === 0 &&
            !occupied.has(tab.number) &&
            tab.name.trim() === "",
        );
        if (!candidate) {
          return err(
            "No unused TUIOS workspace (1-9) is available for a new worker tab. Close a worker tab with picode_tab_close() first.",
          );
        }

        // An empty named workspace is the TUIOS tab equivalent. Unlike
        // creating a default shell, it cannot become an untracked unknown
        // process that prevents tab_close from safely reclaiming the slot.
        const label = requestedLabel || `workers-${candidate.number}`;
        try {
          await runtime.call("set-workspace-name", { workspace: candidate.number, name: label });
          await runtime.refresh();
          if (runtime.tab(runtime.tabFor(candidate.number)).name !== label) {
            return err(
              `TUIOS workspace ${candidate.number} was concurrently claimed; no tab was returned. Run picode_panes() and retry.`,
            );
          }
        } catch (e) {
          return err(`TUIOS workspace claim failed: ${message(e)}`);
        }

        const warnings = [
          ...(params.cwd ? ["TUIOS workspaces have no cwd; pass cwd to spawn_worker."] : []),
          ...(params.focus ? ["TUIOS cannot focus an empty workspace slot."] : []),
        ];
        return ok({
          ok: true,
          tab_id: runtime.tabFor(candidate.number),
          root_pane_id: null,
          root_window_created: false,
          label,
          ...(warnings.length ? { warnings } : {}),
        });
      } catch (e) {
        return err(`picode_tab_create unexpected error: ${message(e)}`);
      }
    },
  });

  // --- picode_tab_close --------------------------------------------------
  pi.registerTool({
    name: "picode_tab_close",
    label: "Close Tab",
    description:
      "Empty a worker TUIOS workspace: closes its windows and clears its name. Refuses the coordinator's own workspace or workspaces with working/blocked windows. TUIOS workspaces are fixed slots, so the slot itself is not destroyed — it becomes reusable by picode_tab_create.",
    promptSnippet: "Empty a worker TUIOS workspace after its windows are cleaned up.",
    parameters: Type.Object({
      tab_id: Type.String({
        description:
          "Tab ID to close (e.g. tuios:<session-id>:t3). Get it from picode_panes() or picode_tab_create.",
      }),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Close even if idle/done windows remain. Default: false. Working/blocked windows are always protected.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (store.role !== "coordinator") {
        return err(
          "picode_tab_close is coordinator-only — request tab closure from your coordinator.",
        );
      }

      const tabId = (params.tab_id || "").trim();
      if (!tabId) {
        return err("tab_id is required — get it from picode_panes() or picode_tab_create.");
      }

      try {
        await runtime.refresh();
      } catch (e) {
        return err(
          `picode_tab_close cannot verify tab ${tabId} is safe to close: ${message(e)}. Run picode_panes() to check manually.`,
        );
      }

      try {
        let tab: { number: number; name: string };
        try {
          tab = runtime.assertWritableTab(tabId);
        } catch (e) {
          return err(message(e));
        }

        if (tab.number === ownWorkspaceNumber(runtime)) {
          return err(
            `tab_id ${tabId} is this coordinator's own workspace — refusing to close. Pass a worker tab ID.`,
          );
        }

        const tabPanes = runtime.panes.filter(window => window.workspace === tab.number);
        let hasWorking = false;
        let hasIdle = false;
        let hasUnknown = false;
        for (const window of tabPanes) {
          if (window.id === runtime.ownPane) {
            return err(`tab_id ${tabId} holds this coordinator's own window — refusing to close.`);
          }
          if (!KNOWN_STATUSES.has(window.status)) {
            return err(
              `Window ${window.id} in tab ${tabId} reports an unrecognized status "${window.status}" — refusing to close the tab. Run picode_panes().`,
            );
          }
          if (window.status === "working" || window.status === "blocked") hasWorking = true;
          if (window.status === "idle" || window.status === "done") hasIdle = true;
          if (window.status === "unknown") hasUnknown = true;
        }

        if (hasWorking || hasUnknown) {
          return err(
            `Tab ${tabId} has working, blocked, or unknown windows — refusing to close them. Install TUIOS's Pi agent-state integration or close unknown shells manually.`,
          );
        }
        if (hasIdle && !params.force) {
          return err(
            `Tab ${tabId} has idle/done windows — pass force=true to close them along with the tab, or run cleanup_panes(force=true) first.`,
          );
        }

        const failed: string[] = [];
        for (const window of tabPanes) {
          try {
            await runtime.close(window.id);
          } catch {
            failed.push(window.id);
          }
        }
        if (failed.length > 0) {
          return err(
            `Tab ${tabId} was not fully cleared — failed to close window(s): ${failed.join(", ")}.`,
          );
        }

        // Clear the name so picode_tab_create can claim the slot again.
        // TUIOS has no delete-workspace verb; nothing physical is removed.
        try {
          await runtime.call("set-workspace-name", { workspace: tab.number, name: "" });
          await runtime.refresh();
          if (runtime.tab(tabId).name !== "") {
            throw new Error("TUIOS did not clear the workspace name");
          }
        } catch (e) {
          return err(
            `Tab ${tabId} is empty but its workspace name could not be cleared; the slot is not reusable. Retry picode_tab_close: ${message(e)}`,
          );
        }

        return ok({ ok: true, tab_id: tabId, closed: true });
      } catch (e) {
        return err(`picode_tab_close unexpected error: ${message(e)}`);
      }
    },
  });
}
