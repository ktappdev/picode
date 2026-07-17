import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { err } from "./shared";

/** Module-level cache for .thread/models.json */
let modelsJson: Record<string, string> | null = null;
let modelsJsonMtime: number | null = null;

function herdr(args: string): string {
  return execSync(`herdr ${args}`, { encoding: "utf-8", timeout: 15_000 });
}

function herdrJson(args: string): Record<string, unknown> {
  const raw = herdr(args);
  try {
    return JSON.parse(raw);
  } catch {
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
    const path = join(root, ".thread", "models.json");
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

    if (width > height) {
      return "right";
    }
    return "down";
  } catch {
    return "right";
  }
}

/** Strip emoji prefix from label to get the role name. */
function extractRole(label: string): string {
  const parts = label.trim().split(/\s+/);
  return parts[parts.length - 1] || "";
}

/** Look for an existing pane with the given role label. Returns pane_id or null. */
function findExistingPane(workspaceId: string, role: string): string | null {
  try {
    const result = herdrJson(`pane list --workspace ${workspaceId}`);
    const panes = ((result.result as Record<string, unknown> | undefined)?.panes as Record<string, unknown>[] | undefined) || [];

    for (const pane of panes) {
      const label = (pane.label as string) || "";
      const paneRole = extractRole(label);
      if (paneRole.toLowerCase() === role.toLowerCase()) {
        return (pane.pane_id as string) || null;
      }
    }
  } catch {
    // Ignore list errors — proceed to create new pane
  }
  return null;
}

export function registerSpawnTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "spawn_worker",
    label: "Spawn Worker",
    description:
      "Spawn a new worker pane in one call: splits the current pane, names it, launches pi with the right model/theme, and waits for it to be ready.",
    parameters: Type.Object({
      role: Type.String({
        description: "Worker role / thread-id (e.g. 'builder', 'explorer', 'worker-1')",
      }),
      direction: Type.Optional(
        Type.Union([Type.Literal("right"), Type.Literal("down")], {
          description: "Override split direction. Omit to auto-detect from pane geometry.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Override model (provider/model). Omit to read from .thread/models.json",
        }),
      ),
      theme: Type.Optional(
        Type.String({
          description: "Override theme name or path. Omit to read from .thread/models.json",
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

        // 2. Check for existing pane with matching role
        const existingPaneId = findExistingPane(workspaceId, params.role);
        let reused = false;
        let paneIdToUse: string | null = null;

        if (existingPaneId) {
          // Get pane status to decide what to do
          try {
            const paneResult = herdrJson(`pane get ${existingPaneId}`);
            const paneInfo = (paneResult.result as Record<string, unknown> | undefined) || {};
            const agentStatus = (paneInfo.agent_status as string) || "unknown";

            if (agentStatus === "working" || agentStatus === "blocked") {
              return err(`worker already active in pane ${existingPaneId} (status: ${agentStatus})`);
            }
            // idle, done, unknown, stopped — safe to reuse
            paneIdToUse = existingPaneId;
            reused = true;
          } catch {
            // Can't determine status — reuse anyway (likely dead pane)
            paneIdToUse = existingPaneId;
            reused = true;
          }
        }

        let newPaneId: string;
        let direction: string | undefined;

        if (paneIdToUse) {
          // Reuse existing pane — skip split and rename
          newPaneId = paneIdToUse;
        } else {
          // 3. Determine split direction
          direction = params.direction || getSplitDirection(paneId);

          // 4. Split pane
          try {
            const splitResult = herdrJson(`pane split ${paneId} --direction ${direction} --no-focus`);
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

          // 5. Rename pane
          try {
            herdr(`pane rename ${newPaneId} "${params.role}"`);
          } catch {
            // Non-fatal — continue even if rename fails
          }
        }

        // 4. Resolve model and theme
        const model = resolveModel(params.role, params.model);
        const theme = resolveTheme(params.theme);

        // 5. Build launch command
        const parts = ["pi"];
        if (model) parts.push(`--model ${model}`);
        if (theme) parts.push(`--theme ${theme}`);
        parts.push(`--thread-id ${params.role}`);
        const launchCmd = parts.join(" ");

        // 6. Run launch command in new pane
        try {
          herdr(`pane run ${newPaneId} "${launchCmd}"`);
        } catch (e) {
          return err(`herdr pane run failed: ${String(e)}`);
        }

        // 7. Wait for agent to be idle
        let warning: string | undefined;
        try {
          herdr(`wait agent-status ${newPaneId} --status idle --timeout 30000`);
        } catch {
          warning = "agent did not become idle within 30s timeout — may still be starting";
        }

        const result = {
          ok: true,
          pane_id: newPaneId,
          role: params.role,
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
      } catch (e) {
        return err(`spawn_worker unexpected error: ${String(e)}`);
      }
    },
  });
}
