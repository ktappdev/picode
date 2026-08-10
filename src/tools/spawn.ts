import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { err, extractRole, effectiveAgentStatus, shellQuote } from "./shared";
import type { PicodeStore } from "../core/types";
import { trackPane } from "../herdr/listener";

/** Worker role labels (same pattern as cleanup-panes.ts). Used to identify
 *  dead worker panes — labeled but no agent — that findEmptyPane should
 *  reclaim instead of leaving them to block grid growth. */
const WORKER_ROLE_PATTERN =
  /^(builder|reviewer|tester|worker|scout|bug-hunter|designer|planner|runner|visionary|explorer)(-[0-9]+)?$/i;

/** Check if a PID is alive (same logic as state.ts). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    return true; // EPERM or other — process exists
  }
}

/** Module-level cache for .picode/models.json */
let modelsJson: Record<string, string> | null = null;
let modelsJsonMtime: number | null = null;

function herdr(args: string): string {
  return execSync(`herdr ${args}`, { encoding: "utf-8", timeout: 15_000 });
}

function herdrJson(args: string): Record<string, unknown> {
  const raw = herdr(args);
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[spawn_worker] herdr JSON parse failed for: ${args} — ${String(e)}`);
    return {};
  }
}

/** Role name validation — prevents shell injection via params.role */
function validateRole(role: string): string | null {
  if (role.length > 32) {
    return `role too long: ${role.length} chars (max 32)`;
  }
  if (!/^[a-zA-Z0-9-]+$/.test(role)) {
    return `role contains invalid characters: ${role} (only a-z, A-Z, 0-9, hyphen)`;
  }
  return null;
}

export function loadModelsJson(): Record<string, string> {
  try {
    let root: string;
    try {
      root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
    } catch {
      root = process.cwd();
    }
    const path = join(root, ".picode", "models.json");
    if (existsSync(path)) {
      const mtime = statSync(path).mtimeMs;
      if (!modelsJson || mtime !== modelsJsonMtime) {
        modelsJson = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
        modelsJsonMtime = mtime;
      }
      return modelsJson;
    }
    if (!modelsJson) {
      modelsJson = {};
    }
    return modelsJson;
  } catch {
    if (!modelsJson) {
      modelsJson = {};
    }
    return modelsJson;
  }
}

function resolveModel(role: string, override?: string): string {
  if (override) return override;
  const cfg = loadModelsJson();
  // Exact role match first, then prefix match
  if (cfg[role]) return cfg[role];
  const prefix = role.split("-")[0];
  if (prefix !== role && cfg[prefix]) return cfg[prefix];
  if (cfg["default"]) return cfg["default"];
  return "";
}

function resolveTheme(role: string, override?: string): string | null {
  if (override) return override;
  const cfg = loadModelsJson();
  // Per-role theme takes precedence: themes.<role>, then themes.<prefix>.
  // Falls back to the global "theme" key for unconfigured roles.
  const prefix = role.split("-")[0];
  const roleTheme = cfg[`themes.${role}`] ?? cfg[`themes.${prefix}`];
  const themeName = roleTheme ?? cfg["theme"];
  if (!themeName) return null;

  // If it's already a path with extension, use directly
  if (themeName.includes("/") || themeName.includes(".json")) return themeName;

  // Look in PICODE_THEMES_DIR
  const themesDir = process.env.PICODE_THEMES_DIR;
  if (themesDir) {
    const fullPath = join(themesDir, `${themeName}.json`);
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

interface SplitTarget {
  paneId: string;
  direction: "right" | "down";
}

/** Ratio thresholds relative to workspace area — screen-size independent. */
const MIN_PANE_RATIO = 0.2; // pane must be ≥20% of workspace dimension to be split candidate
const MIN_RESULT_RATIO = 0.15; // resulting pane must be ≥15% of workspace dimension

function isCoordinatorLabel(label: string): boolean {
  const stripped = label
    .replace(
      /[\u{26AA}\u{1F9ED}\u{1F528}\u{1F50D}\u{1F9EA}\u{1F3A8}\u{1F41B}\u{1F4CB}\u{2699}\u{1F3C3}]\s*/u,
      "",
    )
    .trim()
    .toLowerCase();
  return stripped === "coordinator";
}

/** Fetch and parse the herdr API snapshot once. Returns panes, layouts, and
 *  a pre-built rect map so callers don't each fetch their own snapshot.
 *  Returns null if the snapshot can't be fetched. */
interface SnapshotData {
  panes: Array<Record<string, unknown>>;
  layouts: Array<Record<string, unknown>>;
  rectMap: Map<string, { x: number; y: number; width: number; height: number }>;
}

function fetchSnapshot(): SnapshotData | null {
  try {
    const snapshot = herdrJson("api snapshot");
    const snap =
      ((snapshot.result as Record<string, unknown> | undefined)?.snapshot as
        Record<string, unknown> | undefined) || {};

    const panes = ((snap.panes as Record<string, unknown>[] | undefined) || []) as Array<
      Record<string, unknown>
    >;
    const layouts = ((snap.layouts as Record<string, unknown>[] | undefined) || []) as Array<
      Record<string, unknown>
    >;

    const rectMap = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const layout of layouts) {
      const layoutPanes = (layout.panes as Record<string, unknown>[] | undefined) || [];
      for (const lp of layoutPanes) {
        const pid = lp.pane_id as string;
        const r = lp.rect as Record<string, unknown> | undefined;
        if (pid && r) {
          rectMap.set(pid, {
            x: Number(r.x) || 0,
            y: Number(r.y) || 0,
            width: Number(r.width) || 0,
            height: Number(r.height) || 0,
          });
        }
      }
    }

    return { panes, layouts, rectMap };
  } catch {
    return null;
  }
}

/** Count panes with agents in a specific tab. Used to detect whether a tab
 *  is full (no split candidates) vs. empty (first-worker exception). */
export function countPanesInTab(
  panes: Array<Record<string, unknown>>,
  workspaceId: string,
  tabId: string,
): number {
  return panes.filter(p => p.workspace_id === workspaceId && p.tab_id === tabId && p.agent_status)
    .length;
}

/** Find the sole pane in a tab (regardless of agent status). Returns pane_id
 *  or null if the tab has 0 or 2+ panes. Used for the first-worker-in-empty-tab
 *  exception — a freshly created tab has one agent-less root pane. */
export function solePaneInTab(
  panes: Array<Record<string, unknown>>,
  workspaceId: string,
  tabId: string,
): string | null {
  const tabPanes = panes.filter(p => p.workspace_id === workspaceId && p.tab_id === tabId);
  return tabPanes.length === 1 ? (tabPanes[0].pane_id as string) || null : null;
}

/** Find the best pane to split in the target tab. Returns null when the tab
 *  is full (no candidate ≥ MIN_PANE_RATIO and more than 1 pane) — the caller
 *  should open a new tab via picode_tab_create.
 *
 *  First-worker exception: if the tab has exactly 1 pane (e.g. a freshly
 *  created tab's root pane with no agent), that pane is returned as the
 *  split target even though it has no agent_status. */
function getSplitTarget(
  currentPaneId: string,
  workspaceId: string,
  role: string,
  targetTabId: string,
  snap: SnapshotData,
): SplitTarget | null {
  const { panes, layouts, rectMap } = snap;

  // Find workspace area dimensions for ratio calculations
  const wsLayout = layouts.find(l => l.workspace_id === workspaceId && l.tab_id === targetTabId);
  const wsArea = wsLayout?.area as Record<string, unknown> | undefined;
  const wsWidth = Number(wsArea?.width) || 0;
  const wsHeight = Number(wsArea?.height) || 0;

  // Minimum pane size based on workspace ratios
  const minWidth = wsWidth * MIN_PANE_RATIO;
  const minHeight = wsHeight * MIN_PANE_RATIO;

  // Score candidates — never split coordinator if any other pane exists
  let bestPaneId: string | null = null;
  let bestScore = -1;

  for (const pane of panes) {
    const paneId = pane.pane_id as string;
    const tabId = pane.tab_id as string;
    const agentStatus = pane.agent_status as string | undefined;
    const label = (pane.label as string) || "";

    // Must be in same workspace
    if (pane.workspace_id !== workspaceId) continue;

    // Must be in target tab
    if (tabId !== targetTabId) continue;

    // Must have an agent
    if (!agentStatus) continue;

    // NEVER split coordinator — hard exclusion, not just a penalty.
    // Coordinator pane is the command center; keep it large.
    if (isCoordinatorLabel(label)) continue;

    // Never split own pane (safety — coordinator is own pane)
    if (paneId === currentPaneId) continue;

    const rect = rectMap.get(paneId);
    if (!rect) continue;

    // Score by area
    let score = rect.width * rect.height;

    // Penalize panes below minimum size — still prefer over coordinator,
    // but deprioritize so we pick the largest usable worker first
    if (rect.width < minWidth || rect.height < minHeight) {
      score = score * 0.3;
    }

    // Prefer idle/done (safe to split) over working (disruptive but better
    // than shrinking coordinator)
    if (agentStatus !== "idle" && agentStatus !== "done") {
      score = score * 0.5;
    }

    // Bonus for same role — groups same workers together
    const paneRole = extractRole(label).toLowerCase();
    if (paneRole === role.toLowerCase()) {
      score = score * 1.2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestPaneId = paneId;
    }
  }

  // If we found a candidate, use it
  if (bestPaneId) {
    const direction = computeDirection(bestPaneId, rectMap, wsWidth, wsHeight, panes, targetTabId);
    return { paneId: bestPaneId, direction };
  }

  // First-worker-in-empty-tab exception: if the tab has only 1 pane (the
  // root pane from picode_tab_create, which has no agent), split it.
  const solePaneId = solePaneInTab(panes, workspaceId, targetTabId);
  if (solePaneId) {
    const direction = computeDirection(solePaneId, rectMap, wsWidth, wsHeight, panes, targetTabId);
    return { paneId: solePaneId, direction };
  }

  // 0 panes in tab → impossible in practice (herdr always creates a root
  // pane), but handle gracefully: treat as full so caller opens a new tab
  // rather than crashing. The pane_count in the tab_full message will be 0,
  // which signals something is wrong with the tab.
  // 2+ panes but no candidate ≥ MIN_PANE_RATIO → tab is genuinely full.
  return null;
}

function computeDirection(
  paneId: string,
  rectMap: Map<string, { x: number; y: number; width: number; height: number }>,
  wsWidth: number,
  wsHeight: number,
  panes: Array<Record<string, unknown>>,
  currentTabId: string,
): "right" | "down" {
  const rect = rectMap.get(paneId);
  if (!rect) return "right";

  const width = rect.width;
  const height = rect.height;

  // Extreme aspect ratios take priority
  if (height > width * 2) return "down";
  if (width > height * 4) return "right";

  // Check resulting pane sizes using ratios — avoid creating unusable panes
  const minResultWidth = wsWidth * MIN_RESULT_RATIO;
  const minResultHeight = wsHeight * MIN_RESULT_RATIO;
  const rightOk = width / 2 >= minResultWidth;
  const downOk = height / 2 >= minResultHeight;

  // If only one direction keeps panes usable, pick it
  if (rightOk && !downOk) return "right";
  if (downOk && !rightOk) return "down";

  // Grid awareness: count panes that share the same x-range (vertical stack)
  // vs same y-range (horizontal row) in the same tab. If we already have a
  // tall stack, split right to start a new column. If we have a wide row,
  // split down to start a new row.
  const tolerance = Math.max(width, height) * 0.1; // 10% tolerance for alignment
  let verticalStack = 0; // panes above/below each other (same x, different y)
  let horizontalRow = 0; // panes side by side (same y, different x)

  for (const pane of panes) {
    if ((pane.tab_id as string) !== currentTabId) continue;
    const pid = pane.pane_id as string;
    const pr = rectMap.get(pid);
    if (!pr) continue;

    // Same x-range (within tolerance) → vertical stack neighbor
    if (Math.abs(pr.x - rect.x) < tolerance) {
      verticalStack++;
    }
    // Same y-range (within tolerance) → horizontal row neighbor
    if (Math.abs(pr.y - rect.y) < tolerance) {
      horizontalRow++;
    }
  }

  // If 2+ panes already stacked vertically, split right to balance the grid
  if (verticalStack >= 3 && rightOk) return "right";
  // If 2+ panes already in a horizontal row, split down to balance the grid
  if (horizontalRow >= 3 && downOk) return "down";

  // Both OK or both bad — prefer right for wide panes, down for square-ish
  return width > height * 1.5 ? "right" : "down";
}

/** Check if a picode-id already exists in the workspace.
 *  Checks two sources:
 *  1. Pane labels (visible live workers)
 *  2. .picode/picodes/<id>/state.json with status=running and live PID
 *     (catches dead panes with lost labels that still hold picode-id registration)
 *  Returns true if a live picode with that exact id exists. */
function threadIdExists(workspaceId: string, picodeId: string): boolean {
  // 1. Check pane labels
  try {
    const result = herdrJson(`pane list --workspace ${workspaceId}`);
    const panes =
      ((result.result as Record<string, unknown> | undefined)?.panes as
        Record<string, unknown>[] | undefined) || [];

    for (const pane of panes) {
      const label = (pane.label as string) || "";
      const paneRole = extractRole(label);
      if (paneRole.toLowerCase() === picodeId.toLowerCase()) return true;
    }
  } catch {
    // Ignore list errors
  }

  // 2. Check picode state directory for running picodes with live PIDs
  const picodesRoot = join(process.cwd(), ".picode", "picodes");
  const statePath = join(picodesRoot, picodeId, "state.json");
  if (existsSync(statePath)) {
    try {
      const s = JSON.parse(readFileSync(statePath, "utf8"));
      if (s.status === "running") {
        // Verify PID is alive — stale state from crashed process doesn't count
        if (typeof s.pid === "number" && !isPidAlive(s.pid)) {
          // Stale — previous instance crashed, don't count it
        } else {
          return true;
        }
      }
    } catch {
      // Corrupt state file — ignore
    }
  }

  return false;
}

/** Generate a unique picode-id by suffixing -1, -2, etc. if needed. */
function uniquePicodeId(role: string, workspaceId: string): string {
  if (!threadIdExists(workspaceId, role)) return role;

  let suffix = 1;
  while (threadIdExists(workspaceId, `${role}-${suffix}`)) {
    suffix++;
  }
  return `${role}-${suffix}`;
}

/** Look for an existing pane with the given role label in the target tab.
 *  Prefers idle/done panes (safe to reuse) over unknown/stopped.
 *  Returns pane_id of best match or null if none found.
 *
 *  Tab-scoped: only considers panes in targetTabId. Cross-tab reuse would
 *  break tab isolation — if you spawn into tab X, you don't want to reuse
 *  an idle worker from tab Y. */
function findExistingPane(
  workspaceId: string,
  role: string,
  targetTabId: string,
  panes: Array<Record<string, unknown>>,
): string | null {
  let bestMatch: string | null = null;
  let bestPriority = -1; // -1=none, 0=unknown/stopped, 1=idle/done

  for (const pane of panes) {
    // Must be in same workspace and target tab
    if (pane.workspace_id !== workspaceId) continue;
    if ((pane.tab_id as string) !== targetTabId) continue;

    const label = (pane.label as string) || "";
    const paneRole = extractRole(label);
    if (paneRole.toLowerCase() !== role.toLowerCase()) continue;

    const agentStatus = (pane.agent_status as string) || "unknown";
    const paneId = (pane.pane_id as string) || null;
    if (!paneId) continue;

    // Prefer idle/done (safe to reuse) over unknown/stopped
    const priority = agentStatus === "idle" || agentStatus === "done" ? 1 : 0;
    if (priority > bestPriority) {
      bestPriority = priority;
      bestMatch = paneId;
    }
  }
  return bestMatch;
}

/** Look for an empty or dead pane in the target tab. Claiming it avoids an
 *  unnecessary split and keeps the layout compact.
 *
 *  Two kinds of pane are claimable:
 *  1. Truly empty — no agent, no label, has terminal (fresh root pane).
 *  2. Dead worker — no agent, but has a stale worker-role label (e.g.
 *     "scout-1") and a terminal. The worker process exited but herdr kept
 *     the pane. Without reclaiming it, the dead pane blocks grid growth:
 *     getSplitTarget skips it (no agent_status) and solePaneInTab returns
 *     null (2+ panes) → false tab_full → premature new-tab creation.
 *
 *  Both require: no foreground process running (stale scripts intercept
 *  pane run text). Must NOT be the coordinator's own pane.
 *  Returns pane_id or null. */
function findEmptyPane(
  workspaceId: string,
  currentPaneId: string,
  targetTabId: string,
  panes: Array<Record<string, unknown>>,
): string | null {
  for (const pane of panes) {
    const paneId = (pane.pane_id as string) || "";
    if (paneId === currentPaneId) continue; // never claim own pane
    if (pane.workspace_id !== workspaceId) continue;
    if ((pane.tab_id as string) !== targetTabId) continue;

    const agent = pane.agent as string | null;
    const label = (pane.label as string) || "";
    const terminalId = (pane.terminal_id as string) || "";

    // Claimable: no agent + has terminal + (no label OR dead worker label)
    if (!agent && terminalId) {
      const role = extractRole(label);
      const isDeadWorker = role !== "" && WORKER_ROLE_PATTERN.test(role);
      const isTrulyEmpty = !label;
      if (!isTrulyEmpty && !isDeadWorker) continue; // labeled non-worker (e.g. coordinator) — skip

      // Check for foreground processes — a stale script (e.g. picode_run
      // temp .sh) would intercept pane run text instead of letting pi
      // launch. Skip panes with running foreground processes.
      try {
        const procInfo = herdrJson(`pane process-info --pane ${paneId}`);
        const info = (procInfo.result as Record<string, unknown> | undefined)?.process_info as
          Record<string, unknown> | undefined;
        const fgProcs = (info?.foreground_processes as Array<Record<string, unknown>>) || [];
        if (fgProcs.length > 0) {
          // Has a running process — not truly empty, skip
          continue;
        }
      } catch {
        // Can't check process info — skip to be safe
        continue;
      }
      return paneId;
    }
  }
  return null;
}

export function registerSpawnTool(pi: ExtensionAPI, store: PicodeStore) {
  pi.registerTool({
    name: "spawn_worker",
    label: "Spawn Worker",
    description:
      "Spawn a new worker pane in one call: splits the current pane, names it, launches pi with the right model/theme, and waits for it to be ready.",
    promptSnippet:
      "Spawn a new worker pane in one call: split, name, launch pi, wait for idle (coordinator only).",
    parameters: Type.Object({
      role: Type.String({
        description: "Worker role / picode-id (e.g. 'builder', 'visionary', 'scout', 'worker-1')",
      }),
      direction: Type.Optional(
        Type.Union([Type.Literal("right"), Type.Literal("down")], {
          description: "Override split direction. Omit to auto-detect from pane geometry.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Override model (provider/model). Omit to read from .picode/models.json",
        }),
      ),
      theme: Type.Optional(
        Type.String({
          description: "Override theme name or path. Omit to read from .picode/models.json",
        }),
      ),
      reuse: Type.Optional(
        Type.Boolean({
          description:
            "If false, always create a new pane. Default: true (reuse existing idle/done pane if available).",
        }),
      ),
      tab: Type.Optional(
        Type.String({
          description:
            "Tab ID to spawn in (e.g. w1:t3). Default: current tab. Get from picode_panes() or picode_tab_create. When the requested tab is full, returns tab_full=true instead of splitting — call picode_tab_create then retry.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (store.role !== "coordinator") {
        return err("spawn_worker is coordinator-only — send work to your coordinator instead.");
      }

      const paneId = process.env.HERDR_PANE_ID;
      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      const currentTabId = process.env.HERDR_TAB_ID || "";

      if (!paneId || !workspaceId) {
        return err(
          "HERDR_PANE_ID / HERDR_WORKSPACE_ID not set — spawn_worker only works inside Herdr panes.",
        );
      }

      // Resolve target tab: explicit param, else current tab from env
      const targetTabId = params.tab || currentTabId;
      if (!targetTabId) {
        return err(
          "No tab id — HERDR_TAB_ID not set and no tab param provided. Get a tab_id from picode_panes() or picode_tab_create().",
        );
      }

      // Fetch snapshot once — reused by findEmptyPane, getSplitTarget, countPanesInTab
      const snap = fetchSnapshot();
      if (!snap) {
        return err("Failed to fetch herdr snapshot — is herdr running?");
      }

      try {
        // 1. Validate role
        const roleErr = validateRole(params.role);
        if (roleErr) {
          return err(`invalid role: ${roleErr}`);
        }

        // 2. Check for existing pane with matching role (default: reuse=true)
        let reused = false;
        let paneIdToUse: string | null = null;

        if (params.reuse !== false) {
          const existingPaneId = findExistingPane(
            workspaceId,
            params.role,
            targetTabId,
            snap.panes,
          );
          if (existingPaneId) {
            // Get pane status to decide what to do
            try {
              const paneResult = herdrJson(`pane get ${existingPaneId}`);
              const paneInfo = (paneResult.result as Record<string, unknown> | undefined) || {};
              const label = (paneInfo.label as string) || "";
              const picodeId = extractRole(label);
              const herdrStatus = (paneInfo.agent_status as string) || "unknown";
              // Cross-check picode heartbeat: herdr may report working/
              // blocked for a dead process. A stale heartbeat → treat as
              // unknown so we reuse (or skip) based on truth, not a lie.
              const agentStatus = effectiveAgentStatus(herdrStatus, picodeId);

              if (agentStatus === "working" || agentStatus === "blocked") {
                // Busy same-role pane is not reusable. Continue to unique ID
                // generation so parallel work becomes role-1, role-2, etc.
              } else if (agentStatus === "idle" || agentStatus === "done") {
                // Safe to reuse.
                paneIdToUse = existingPaneId;
                reused = true;
              } else {
                // unknown/stopped — check if pane is actually usable
                const terminalId = (paneInfo.terminal_id as string) || "";
                if (terminalId) {
                  // Has a terminal — might be usable, try to reuse
                  paneIdToUse = existingPaneId;
                  reused = true;
                }
                // No terminal — fall through to create new pane
              }
            } catch {
              // Can't determine status — fall through to create new pane
            }
          }
        }

        // 3. Generate unique picode-id (auto-suffix if role already exists)
        // When reusing, use the role name directly (existing pane's picode ID).
        const uniqueId = reused ? params.role : uniquePicodeId(params.role, workspaceId);

        let newPaneId: string;
        let direction: string | undefined;
        let splitTargetPaneId = paneId;
        let actualRole: string = params.role;
        let claimedEmpty = false;

        if (paneIdToUse) {
          // Reuse existing pane — skip split, rename, and launch.
          // The agent is already running with its existing picode-id.
          newPaneId = paneIdToUse;

          // Get the actual role from the pane label (could be "builder-1" etc.)
          try {
            const paneResult = herdrJson(`pane get ${newPaneId}`);
            const paneInfo = (paneResult.result as Record<string, unknown> | undefined) || {};
            const label = (paneInfo.label as string) || "";
            actualRole = extractRole(label) || params.role;
          } catch {
            // Fall back to requested role if we can't read the label
            actualRole = params.role;
          }
        } else {
          // 3a. Check for an empty pane (no agent, no label, has terminal)
          //     Claiming it avoids an unnecessary split.
          const emptyPaneId = findEmptyPane(workspaceId, paneId, targetTabId, snap.panes);
          if (emptyPaneId) {
            newPaneId = emptyPaneId;
            claimedEmpty = true;
          } else {
            // 3b. Determine split target and direction
            // Always run getSplitTarget for pane selection (never split
            // coordinator). If direction is overridden, use it but still
            // pick the smart split target — don't force coordinator pane.
            const target = getSplitTarget(paneId, workspaceId, params.role, targetTabId, snap);
            if (!target) {
              // Tab is full — no split candidate ≥ MIN_PANE_RATIO and more
              // than 1 pane. Signal the coordinator to open a new tab.
              const paneCount = countPanesInTab(snap.panes, workspaceId, targetTabId);
              const fullResult = {
                ok: false,
                tab_full: true,
                tab_id: targetTabId,
                pane_count: paneCount,
                message:
                  paneCount === 0
                    ? `Tab ${targetTabId} has no panes — it may be invalid. Try a different tab or create a new one with picode_tab_create().`
                    : `Tab ${targetTabId} is full (${paneCount} panes, none ≥20% to split). Call picode_tab_create() then retry spawn_worker with the new tab_id.`,
              };
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(fullResult),
                  },
                ],
                details: fullResult,
              };
            }
            splitTargetPaneId = target.paneId;
            direction = params.direction || target.direction;

            // 4. Split pane
            try {
              const splitResult = herdrJson(
                `pane split ${splitTargetPaneId} --direction ${direction} --no-focus`,
              );
              const splitPane = (splitResult.result as Record<string, unknown>)?.pane as
                Record<string, unknown> | undefined;
              newPaneId = splitPane?.pane_id as string;
              if (!newPaneId) {
                return err(
                  `herdr pane split succeeded but no pane_id in response: ${JSON.stringify(splitResult)}`,
                );
              }
            } catch (e) {
              return err(`herdr pane split failed: ${String(e)}`);
            }
          }

          // 5. Rename pane (use uniqueId for label)
          try {
            herdr(`pane rename ${newPaneId} "${uniqueId}"`);
          } catch (e) {
            return err(`herdr pane rename failed: ${String(e)}`);
          }
        }

        // 7. Resolve model and theme
        const model = resolveModel(actualRole, params.model);
        const theme = resolveTheme(actualRole, params.theme);

        // 8. Build launch command (only for new panes)
        const parts = ["pi"];
        if (model) parts.push(`--model ${shellQuote(model)}`);
        if (theme) parts.push(`--theme ${shellQuote(theme)}`);
        parts.push(`--picode-id ${shellQuote(uniqueId)}`);
        const launchCmd = parts.join(" ");

        // 9. Run launch command in new/claimed pane (not for reused panes)
        if (!paneIdToUse) {
          // Safety net: if we claimed an empty pane, send Ctrl-C first to
          // kill any stale process that might intercept pane run text.
          // findEmptyPane checks for foreground processes, but race
          // conditions can leave a process running between check and claim.
          if (claimedEmpty) {
            try {
              herdr(`pane send-keys ${newPaneId} C-c`);
            } catch {
              // Non-fatal — may not have a process to interrupt
            }
          }
          try {
            herdr(`pane run ${newPaneId} "${launchCmd}"`);
          } catch (e) {
            return err(`herdr pane run failed: ${String(e)}`);
          }

          // 10. Wait for agent to be idle (only for new/claimed panes)
          let warning: string | undefined;
          try {
            herdr(`wait agent-status ${newPaneId} --status idle --timeout 30000`);
          } catch {
            warning = "agent did not become idle within 30s timeout — may still be starting";
          }

          // Soft signal: if tab has 4+ agent panes after this spawn, warn
          // the coordinator that the next spawn should go in a new tab.
          // Separate from the hard tab_full (physical 20% threshold).
          const paneCountAfter =
            countPanesInTab(snap.panes, workspaceId, targetTabId) + (reused ? 0 : 1);
          const nearFull = paneCountAfter >= 4;

          const result = {
            ok: true,
            pane_id: newPaneId,
            role: actualRole,
            model: model || "(pi default)",
            theme: theme || "(none)",
            reused,
            ...(claimedEmpty ? { claimed_empty: true } : {}),
            ...(direction ? { direction } : {}),
            ...(splitTargetPaneId !== paneId ? { split_from: splitTargetPaneId } : {}),
            tab_id: targetTabId,
            ...(nearFull ? { tab_near_full: true, pane_count: paneCountAfter } : {}),
            ...(warning ? { warning } : {}),
          };

          trackPane(newPaneId);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result),
              },
            ],
            details: result,
          };
        }

        // Reuse path — return immediately without launching
        // Soft signal for reused panes too (count doesn't change on reuse)
        const paneCountReuse = countPanesInTab(snap.panes, workspaceId, targetTabId);
        const nearFullReuse = paneCountReuse >= 4;

        const result = {
          ok: true,
          pane_id: newPaneId,
          role: actualRole,
          model: model || "(pi default)",
          theme: theme || "(none)",
          reused: true,
          tab_id: targetTabId,
          ...(nearFullReuse ? { tab_near_full: true, pane_count: paneCountReuse } : {}),
        };

        trackPane(newPaneId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
          details: result,
        };
      } catch (e) {
        return err(`spawn_worker unexpected error: ${String(e)}`);
      }
    },
  });
}
