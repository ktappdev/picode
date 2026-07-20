import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { err, extractRole } from "./shared";

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

function resolveTheme(override?: string): string | null {
  if (override) return override;
  const cfg = loadModelsJson();
  const themeName = cfg["theme"];
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
    .replace(/[🧭🔨🔍🧪🎨🐛📋⚙️🏃]\s*/, "")
    .trim()
    .toLowerCase();
  return stripped === "coordinator";
}

function getSplitTarget(currentPaneId: string, workspaceId: string, role: string): SplitTarget {
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

    // Find current pane's tab_id
    const currentPane = panes.find(p => p.pane_id === currentPaneId);
    const currentTabId = (currentPane?.tab_id as string) || "";

    // Build rect map: pane_id → {width, height}
    const rectMap = new Map<string, { width: number; height: number }>();
    for (const layout of layouts) {
      const layoutPanes = (layout.panes as Record<string, unknown>[] | undefined) || [];
      for (const lp of layoutPanes) {
        const pid = lp.pane_id as string;
        const r = lp.rect as Record<string, unknown> | undefined;
        if (pid && r) {
          rectMap.set(pid, {
            width: Number(r.width) || 0,
            height: Number(r.height) || 0,
          });
        }
      }
    }

    // Find workspace area dimensions for ratio calculations
    const wsLayout = layouts.find(l => l.workspace_id === workspaceId && l.tab_id === currentTabId);
    const wsArea = wsLayout?.area as Record<string, unknown> | undefined;
    const wsWidth = Number(wsArea?.width) || 0;
    const wsHeight = Number(wsArea?.height) || 0;

    // Minimum pane size based on workspace ratios
    const minWidth = wsWidth * MIN_PANE_RATIO;
    const minHeight = wsHeight * MIN_PANE_RATIO;

    // Score candidates
    let bestPaneId: string | null = null;
    let bestScore = -1;

    for (const pane of panes) {
      const paneId = pane.pane_id as string;
      const tabId = pane.tab_id as string;
      const agentStatus = pane.agent_status as string | undefined;
      const label = (pane.label as string) || "";

      // Must be in same workspace
      if (pane.workspace_id !== workspaceId) continue;

      // Must be in same tab
      if (tabId !== currentTabId) continue;

      // Must have an agent
      if (!agentStatus) continue;

      // Must be idle or done (safe to split)
      if (agentStatus !== "idle" && agentStatus !== "done") continue;

      // Check minimum size (ratio-based)
      const rect = rectMap.get(paneId);
      if (!rect) continue;
      if (rect.width < minWidth || rect.height < minHeight) continue;

      // Score by area
      let score = rect.width * rect.height;

      // Strong penalty for coordinator — only use if no workers available
      if (isCoordinatorLabel(label)) {
        score = score * 0.1;
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

    // Fallback to current pane if no valid candidate
    const targetPaneId = bestPaneId || currentPaneId;
    const direction = computeDirection(targetPaneId, rectMap, wsWidth, wsHeight);

    return { paneId: targetPaneId, direction };
  } catch {
    return { paneId: currentPaneId, direction: "right" };
  }
}

function computeDirection(
  paneId: string,
  rectMap: Map<string, { width: number; height: number }>,
  wsWidth: number,
  wsHeight: number,
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

  // Both OK or both bad — prefer right for wide panes, down for square-ish
  return width > height * 1.5 ? "right" : "down";
}

/** Check if a picode-id already exists in the workspace.
 *  Returns true if a pane with that exact picode-id label exists. */
function threadIdExists(workspaceId: string, picodeId: string): boolean {
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

/** Look for an existing pane with the given role label.
 *  Prefers idle/done panes (safe to reuse) over unknown/stopped.
 *  Returns pane_id of best match or null if none found. */
function findExistingPane(workspaceId: string, role: string): string | null {
  let bestMatch: string | null = null;
  let bestPriority = -1; // -1=none, 0=unknown/stopped, 1=idle/done

  try {
    const result = herdrJson(`pane list --workspace ${workspaceId}`);
    const panes =
      ((result.result as Record<string, unknown> | undefined)?.panes as
        Record<string, unknown>[] | undefined) || [];

    for (const pane of panes) {
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
  } catch {
    // Ignore list errors — proceed to create new pane
  }
  return bestMatch;
}

export function registerSpawnTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "spawn_worker",
    label: "Spawn Worker",
    description:
      "Spawn a new worker pane in one call: splits the current pane, names it, launches pi with the right model/theme, and waits for it to be ready.",
    promptSnippet:
      "Spawn a new worker pane in one call: split, name, launch pi, wait for idle (coordinator only).",
    parameters: Type.Object({
      role: Type.String({
        description: "Worker role / picode-id (e.g. 'builder', 'scout', 'worker-1')",
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
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const paneId = process.env.HERDR_PANE_ID;
      const workspaceId = process.env.HERDR_WORKSPACE_ID;

      if (!paneId || !workspaceId) {
        return err(
          "HERDR_PANE_ID / HERDR_WORKSPACE_ID not set — spawn_worker only works inside Herdr panes.",
        );
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
          const existingPaneId = findExistingPane(workspaceId, params.role);
          if (existingPaneId) {
            // Get pane status to decide what to do
            try {
              const paneResult = herdrJson(`pane get ${existingPaneId}`);
              const paneInfo = (paneResult.result as Record<string, unknown> | undefined) || {};
              const agentStatus = (paneInfo.agent_status as string) || "unknown";

              if (agentStatus === "working" || agentStatus === "blocked") {
                return err(
                  `worker already active in pane ${existingPaneId} (status: ${agentStatus})`,
                );
              }
              // idle/done — safe to reuse
              // unknown/stopped — only reuse if pane has no running process
              if (agentStatus === "idle" || agentStatus === "done") {
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
          // 3. Determine split target and direction
          if (params.direction) {
            direction = params.direction;
            splitTargetPaneId = paneId;
          } else {
            const target = getSplitTarget(paneId, workspaceId, params.role);
            splitTargetPaneId = target.paneId;
            direction = target.direction;
          }

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

          // 5. Rename pane (use uniqueId for label)
          try {
            herdr(`pane rename ${newPaneId} "${uniqueId}"`);
          } catch (e) {
            return err(`herdr pane rename failed: ${String(e)}`);
          }
        }

        // 7. Resolve model and theme
        const model = resolveModel(actualRole, params.model);
        const theme = resolveTheme(params.theme);

        // 8. Build launch command (only for new panes)
        const parts = ["pi"];
        if (model) parts.push(`--model ${model}`);
        if (theme) parts.push(`--theme ${theme}`);
        parts.push(`--picode-id ${actualRole}`);
        const launchCmd = parts.join(" ");

        // 9. Run launch command in new pane (only for new panes)
        if (!paneIdToUse) {
          try {
            herdr(`pane run ${newPaneId} "${launchCmd}"`);
          } catch (e) {
            return err(`herdr pane run failed: ${String(e)}`);
          }

          // 10. Wait for agent to be idle (only for new panes)
          let warning: string | undefined;
          try {
            herdr(`wait agent-status ${newPaneId} --status idle --timeout 30000`);
          } catch {
            warning = "agent did not become idle within 30s timeout — may still be starting";
          }

          const result = {
            ok: true,
            pane_id: newPaneId,
            role: actualRole,
            model: model || "(pi default)",
            theme: theme || "(none)",
            reused,
            ...(direction ? { direction } : {}),
            ...(splitTargetPaneId !== paneId ? { split_from: splitTargetPaneId } : {}),
            ...(warning ? { warning } : {}),
          };

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
        const result = {
          ok: true,
          pane_id: newPaneId,
          role: actualRole,
          model: model || "(pi default)",
          theme: theme || "(none)",
          reused: true,
        };

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
