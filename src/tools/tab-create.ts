import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import { existsSync } from "node:fs";
import { err, shellQuote } from "./shared";
import type { PicodeStore } from "../core/types";

function herdr(args: string): string {
  return execSync(`herdr ${args}`, { encoding: "utf-8", timeout: 15_000 });
}

function herdrJson(args: string): Record<string, unknown> {
  try {
    return JSON.parse(herdr(args));
  } catch (e) {
    console.error(`[picode_tab_create] herdr JSON parse failed: ${String(e)}`);
    return {};
  }
}

/** Label validation — prevents shell injection via herdr tab rename.
 *  Same pattern as validateRole in spawn.ts. */
export function validateLabel(label: string): string | null {
  if (label.length > 32) {
    return `label too long: ${label.length} chars (max 32)`;
  }
  if (!/^[a-zA-Z0-9_-]*$/.test(label)) {
    return `label contains invalid characters: ${label} (only a-z, A-Z, 0-9, hyphen, underscore)`;
  }
  return null;
}

export function registerTabCreateTool(pi: ExtensionAPI, store: PicodeStore) {
  pi.registerTool({
    name: "picode_tab_create",
    label: "Create Tab",
    description:
      "Open a new Herdr tab in the current workspace for spawning workers when the current tab is full. Returns tab_id and root_pane_id. The root pane is empty — spawn workers into it with spawn_worker(tab=<tab_id>).",
    promptSnippet: "Open a new Herdr tab for worker spawning when the current tab is full.",
    parameters: Type.Object({
      label: Type.Optional(
        Type.String({
          description: "Tab label (e.g. 'frontend', 'workers-2'). Default: herdr assigns.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory for the new tab's root pane. Default: current cwd.",
        }),
      ),
      focus: Type.Optional(
        Type.Boolean({
          description: "Focus the new tab. Default: false (keep coordinator focused).",
        }),
      ),
    }),
    async execute(_id, params) {
      if (store.role !== "coordinator") {
        return err(
          "picode_tab_create is coordinator-only — request a new tab from your coordinator.",
        );
      }

      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      if (!workspaceId) {
        return err("HERDR_WORKSPACE_ID not set — picode_tab_create only works inside Herdr panes.");
      }

      const label = (params.label || "").trim();
      if (label) {
        const labelErr = validateLabel(label);
        if (labelErr) {
          return err(`invalid label: ${labelErr}`);
        }
      }

      // Build command — --no-focus keeps coordinator's tab focused by default
      // Build command
      const focusFlag = params.focus ? "--focus" : "--no-focus";
      const args = [`tab create --workspace ${workspaceId} ${focusFlag}`];
      if (label) args.push(`--label ${shellQuote(label)}`);
      if (params.cwd) {
        if (!existsSync(params.cwd)) {
          return err(`cwd does not exist: ${params.cwd}`);
        }
        args.push(`--cwd ${shellQuote(params.cwd)}`);
      }

      try {
        const result = herdrJson(args.join(" "));
        const res = (result.result as Record<string, unknown> | undefined) || {};
        const tab = (res.tab as Record<string, unknown> | undefined) || {};
        const rootPane = (res.root_pane as Record<string, unknown> | undefined) || {};
        const tabId = tab.tab_id as string;
        const rootPaneId = rootPane.pane_id as string;

        if (!tabId || !rootPaneId) {
          return err(
            `herdr tab create succeeded but no tab_id/root_pane_id in response: ${JSON.stringify(result)}`,
          );
        }

        const out = {
          ok: true,
          tab_id: tabId,
          root_pane_id: rootPaneId,
          label: (tab.label as string) || "",
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(out),
            },
          ],
          details: out,
        };
      } catch (e) {
        return err(`herdr tab create failed: ${String(e)}`);
      }
    },
  });
}
