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

function loadModelsJson(): Record<string, string> {
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

function getSplitDirection(paneId: string): "right" | "down" {
  try {
    const layout = herdrJson(`pane layout --pane ${paneId}`);
    const result = layout.result as Record<string, unknown> | undefined;
    const area = result?.layout as Record<string, unknown> | undefined;
    const areaDims = area?.area as Record<string, unknown> | undefined;
    const width = Number(areaDims?.width) || 0;
    const height = Number(areaDims?.height) || 0;

    // Extreme aspect ratios take priority
    if (height > width * 2) return "down"; // very tall
    if (width > height * 4) return "right"; // very wide

    // Count existing panes in current tab to alternate directions
    const panes = (area?.panes as Record<string, unknown>[] | undefined) || [];
    const paneCount = panes.length;

    // Alternate: odd count → right, even count → down
    // Creates grid instead of endless row of narrow columns
    if (paneCount % 2 === 0) {
      return "down";
    }
    return "right";
  } catch {
    return "right";
  }
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
          // 3. Determine split direction
          direction = params.direction || getSplitDirection(paneId);

          // 4. Split pane
          try {
            const splitResult = herdrJson(
              `pane split ${paneId} --direction ${direction} --no-focus`,
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
