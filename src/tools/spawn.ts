import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { err } from "./shared";

/** Module-level cache for .thread/models.json */
let modelsJson: Record<string, string> | null = null;

/** Track consecutive right-splits for round-robin layout. */
let consecutiveRights = 0;
const MAX_RIGHTS = 2;

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

function loadModelsJson(): Record<string, string> {
  if (modelsJson) return modelsJson;
  try {
    let root: string;
    try {
      root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
    } catch {
      root = process.cwd();
    }
    const path = join(root, ".thread", "models.json");
    if (existsSync(path)) {
      modelsJson = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
    } else {
      modelsJson = {};
    }
  } catch {
    modelsJson = {};
  }
  return modelsJson!;
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
  // Round-robin: after 2 consecutive rights, force down
  if (consecutiveRights >= MAX_RIGHTS) {
    consecutiveRights = 0;
    return "down";
  }

  try {
    const layout = herdrJson(`pane layout --pane ${paneId}`);
    const result = layout.result as Record<string, unknown> | undefined;
    const area = result?.layout as Record<string, unknown> | undefined;
    const areaDims = area?.area as Record<string, unknown> | undefined;
    const width = Number(areaDims?.width) || 0;
    const height = Number(areaDims?.height) || 0;

    if (width > height) {
      consecutiveRights++;
      return "right";
    }
    consecutiveRights = 0;
    return "down";
  } catch {
    consecutiveRights++;
    return "right";
  }
}

export function registerSpawnTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "spawn_worker",
    label: "Spawn Worker",
    description:
      "Spawn a new worker pane in one call: splits the current pane, names it, launches pi with the right model/theme, and waits for it to be ready.",
    parameters: Type.Object({
      role: Type.String({ description: "Worker role / thread-id (e.g. 'builder', 'explorer', 'worker-1')" }),
      model: Type.Optional(Type.String({ description: "Override model (provider/model). Omit to read from .thread/models.json" })),
      theme: Type.Optional(Type.String({ description: "Override theme name or path. Omit to read from .thread/models.json" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const paneId = process.env.HERDR_PANE_ID;
      const workspaceId = process.env.HERDR_WORKSPACE_ID;

      if (!paneId || !workspaceId) {
        return err("HERDR_PANE_ID / HERDR_WORKSPACE_ID not set — spawn_worker only works inside Herdr panes.");
      }

      try {
        // 1. Determine split direction
        const direction = getSplitDirection(paneId);

        // 2. Split pane
        let newPaneId: string;
        try {
          const splitResult = herdrJson(`pane split ${paneId} --direction ${direction} --no-focus`);
          const splitPane = (splitResult.result as Record<string, unknown>)?.pane as Record<string, unknown> | undefined;
          newPaneId = splitPane?.pane_id as string;
          if (!newPaneId) {
            return err(`herdr pane split succeeded but no pane_id in response: ${JSON.stringify(splitResult)}`);
          }
        } catch (e) {
          return err(`herdr pane split failed: ${String(e)}`);
        }

        // 3. Rename pane
        try {
          herdr(`pane rename ${newPaneId} "${params.role}"`);
        } catch {
          // Non-fatal — continue even if rename fails
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
        try {
          herdr(`wait agent-status ${newPaneId} --status idle --timeout 30000`);
        } catch {
          // Non-fatal — agent may take longer or already be idle
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                pane_id: newPaneId,
                role: params.role,
                model: model || "(pi default)",
                theme: theme || "(none)",
                direction,
              }),
            },
          ],
          details: { ok: true, pane_id: newPaneId, role: params.role, model, direction },
        };
      } catch (e) {
        return err(`spawn_worker unexpected error: ${String(e)}`);
      }
    },
  });
}
