import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import {
  belongsToWorkspace,
  err,
  extractRole,
  effectiveAgentStatus,
  isProtectedTabLabel,
  isValidPaneId,
} from "./shared";
import type { PicodeStore } from "../core/types";

function herdr(args: string): string {
  return execSync(`herdr ${args}`, { encoding: "utf-8", timeout: 15_000 });
}

function herdrJson(args: string): Record<string, unknown> {
  try {
    return JSON.parse(herdr(args));
  } catch (e) {
    console.error(`[picode_tab_close] herdr JSON parse failed: ${String(e)}`);
    return {};
  }
}

export function registerTabCloseTool(pi: ExtensionAPI, store: PicodeStore) {
  pi.registerTool({
    name: "picode_tab_close",
    label: "Close Tab",
    description:
      "Close an empty or stale Herdr tab in the current workspace. Refuses to close the coordinator's own tab or tabs with working/blocked panes. Use after cleanup_panes() when a tab is empty. Pass force=true to close tabs with idle/done panes too.",
    promptSnippet: "Close an empty Herdr tab after workers are cleaned up.",
    parameters: Type.Object({
      tab_id: Type.String({
        description: "Tab ID to close (e.g. w1:t3). Get from picode_panes() or picode_tab_create.",
      }),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Close even if idle/done panes remain. Default: false. Working/blocked panes are always protected.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (store.role !== "coordinator") {
        return err(
          "picode_tab_close is coordinator-only — request tab closure from your coordinator.",
        );
      }

      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      if (!workspaceId) {
        return err("HERDR_WORKSPACE_ID not set — picode_tab_close only works inside Herdr panes.");
      }

      const tabId = (params.tab_id || "").trim();
      if (!tabId) {
        return err("tab_id is required — get it from picode_panes() or picode_tab_create.");
      }

      // Tab IDs use the same workspace:tab format as pane IDs (workspace:pane)
      if (!isValidPaneId(tabId)) {
        return err(`Invalid tab_id "${tabId}" — expected Herdr format like w1:t3.`);
      }
      if (!belongsToWorkspace(tabId, workspaceId)) {
        return err(
          `tab_id ${tabId} is outside current Herdr workspace ${workspaceId}. Use an exact tab ID from picode_panes().`,
        );
      }

      // Safety: never close the coordinator's own tab
      const currentTabId = process.env.HERDR_TAB_ID || "";
      if (tabId === currentTabId) {
        return err(
          `tab_id ${tabId} is this coordinator's own tab — refusing to close. Pass a worker tab ID.`,
        );
      }

      // Never close user-owned tabs (e.g. "don't close — frontend").
      // Those tabs are off-limits even when empty.
      try {
        const tabInfo = herdrJson(`tab get ${tabId}`);
        const tabPayload = (tabInfo.result as Record<string, unknown> | undefined) || {};
        const tab =
          (tabPayload.tab as Record<string, unknown> | undefined) ||
          (typeof tabPayload.tab_id === "string" ? tabPayload : undefined);
        const tabLabel = (tab?.label as string) || "";
        if (isProtectedTabLabel(tabLabel)) {
          return err(
            `Tab ${tabId} ("${tabLabel}") is user-owned ("don't close") — refusing to close. That tab is off-limits.`,
          );
        }
      } catch {
        // Can't verify tab label — fall through to the snapshot check below,
        // which refuses to close blindly if herdr is unreachable.
      }

      // Check panes in this tab for active workers
      try {
        const snapshot = herdrJson("api snapshot");
        const snap =
          ((snapshot.result as Record<string, unknown> | undefined)?.snapshot as
            Record<string, unknown> | undefined) || {};

        const panes = ((snap.panes as Record<string, unknown>[] | undefined) || []) as Array<
          Record<string, unknown>
        >;

        const tabPanes = panes.filter(p => p.workspace_id === workspaceId && p.tab_id === tabId);

        let hasWorking = false;
        let hasIdle = false;
        for (const p of tabPanes) {
          const label = (p.label as string) || "";
          const herdrStatus = (p.agent_status as string) || "unknown";
          // Cross-check picode heartbeat — don't protect zombie workers
          const status = effectiveAgentStatus(herdrStatus, extractRole(label));
          if (status === "working" || status === "blocked") hasWorking = true;
          if (status === "idle" || status === "done") hasIdle = true;
        }

        if (hasWorking) {
          return err(
            `Tab ${tabId} has working/blocked panes — close those first with cleanup_panes(pane_id=...) or wait for them to finish.`,
          );
        }
        if (hasIdle && !params.force) {
          return err(
            `Tab ${tabId} has idle/done panes — pass force=true to close them along with the tab, or run cleanup_panes(force=true) first.`,
          );
        }
      } catch {
        // Can't fetch snapshot — refuse to close blindly. Working panes
        // could be silently killed. Coordinator should retry or inspect
        // manually with picode_panes().
        return err(
          `Failed to fetch herdr snapshot — cannot verify tab ${tabId} is safe to close. Run picode_panes() to check manually.`,
        );
      }

      try {
        herdr(`tab close ${tabId}`);
        const out = { ok: true, tab_id: tabId, closed: true };
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
        return err(`herdr tab close failed: ${String(e)}`);
      }
    },
  });
}
