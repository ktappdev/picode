import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import {
  belongsToWorkspace,
  err,
  extractPaneInfo,
  extractRole,
  isProtectedTabLabel,
  isValidPaneId,
  effectiveAgentStatus,
  quietCallRenderer,
  quietToolResult,
} from "./shared";
import type { PicodeStore } from "../core/types";

/** Worker role labels to clean up (case-insensitive, emoji prefix stripped).
 *  Matches base role and suffixed variants (worker, worker-1, builder-2, etc.). */
const WORKER_ROLE_PATTERN =
  /^(builder|reviewer|tester|worker|scout|bug-hunter|designer|planner|runner|visionary|gauntlet|explorer)(-[0-9]+)?$/i;

function herdr(args: string): string {
  return execSync(`herdr ${args}`, { encoding: "utf-8", timeout: 15_000 });
}

function herdrJson(args: string): Record<string, unknown> {
  const raw = herdr(args);
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    console.error(`[cleanup_panes] herdr JSON parse failed for: ${args} — ${String(e)}`);
    return {};
  }
}

// extractRole imported from shared.ts

export function registerCleanupPanesTool(pi: ExtensionAPI, store: PicodeStore) {
  pi.registerTool({
    name: "cleanup_panes",
    label: "Cleanup Panes",
    description:
      "Close stale herdr worker panes spawned by the coordinator. Removes panes with role labels (builder, reviewer, tester, worker, scout, bug-hunter, designer, planner, runner, visionary, gauntlet, explorer) that are not working. Use when the picode list is cluttered with dead workers. Pass pane_id to close a specific pane. Pass force=true to close idle/done workers too (e.g. when user says 'close all').",
    promptSnippet:
      "Close stale herdr worker panes (use when workspace is cluttered with dead workers).",
    parameters: Type.Object({
      dry_run: Type.Optional(
        Type.Boolean({
          description: "If true, list what would be closed without actually closing them.",
        }),
      ),
      pane_id: Type.Optional(
        Type.String({
          description:
            "Close a specific pane by ID (e.g. w1:p2). When provided, only that pane is targeted — no bulk scan. Get the ID from picode_panes() or spawn_worker return.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "If true, close idle/done workers too — not just stale ones. Use when user says 'close all' or 'close everything'. Default: false (only close stale/non-active panes).",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (store.role !== "coordinator") {
        return err("cleanup_panes is coordinator-only — report pane problems to your coordinator.");
      }

      const workspaceId = process.env.HERDR_WORKSPACE_ID;

      if (!workspaceId) {
        return err("HERDR_WORKSPACE_ID not set — cleanup_panes only works inside Herdr panes.");
      }

      const currentPaneId = process.env.HERDR_PANE_ID || "";

      try {
        // --- Targeted mode: close a specific pane ---
        if (params.pane_id) {
          const targetId = params.pane_id.trim();
          if (!isValidPaneId(targetId)) {
            return err(`Invalid pane_id "${targetId}" — expected Herdr format like w1:p2.`);
          }
          if (!belongsToWorkspace(targetId, workspaceId)) {
            return err(
              `pane_id ${targetId} is outside current Herdr workspace ${workspaceId}. Use an exact pane ID from picode_panes().`,
            );
          }

          // Safety: never close our own pane
          if (targetId === currentPaneId) {
            return err(
              `pane_id ${targetId} is this coordinator's own pane — refusing to close. Pass a worker pane ID.`,
            );
          }

          // Fetch the pane to verify it exists and is a worker
          let paneInfo: Record<string, unknown> | null = null;
          try {
            const result = herdrJson(`pane get ${targetId}`);
            paneInfo = extractPaneInfo(result);
          } catch {
            // pane get may fail if pane doesn't exist
          }

          if (!paneInfo) {
            return err(
              `Pane ${targetId} not found — it may already be closed. Run picode_panes() to see current panes.`,
            );
          }

          if (paneInfo.workspace_id !== workspaceId) {
            return err(
              `Pane ${targetId} is outside current Herdr workspace ${workspaceId} — refusing to close it.`,
            );
          }

          const label = (paneInfo.label as string) || "";
          const herdrStatus = (paneInfo.agent_status as string) || "unknown";
          // Never touch panes inside user-owned tabs (e.g. "don't close —
          // frontend"). Those tabs are off-limits even for targeted closes.
          const paneTabId = (paneInfo.tab_id as string) || "";
          if (paneTabId) {
            try {
              const tabResult = herdrJson(`tab get ${paneTabId}`);
              const tabPayload = (tabResult.result as Record<string, unknown> | undefined) || {};
              const tab =
                (tabPayload.tab as Record<string, unknown> | undefined) ||
                (typeof tabPayload.tab_id === "string" ? tabPayload : undefined);
              const tabLabel = (tab?.label as string) || "";
              if (isProtectedTabLabel(tabLabel)) {
                return err(
                  `Pane ${targetId} is in user-owned tab "${tabLabel}" ("don't close") — refusing to close. That tab is off-limits.`,
                );
              }
            } catch {
              // Can't verify tab label — fail open so an explicit targeted
              // close isn't blocked by a herdr hiccup.
            }
          }
          // Cross-check picode heartbeat: a zombie worker (process dead,
          // herdr still says working/blocked) should be cleanupable, not
          // protected by a stale status lie.
          const agentStatus = effectiveAgentStatus(herdrStatus, extractRole(label));

          // When pane_id is explicitly provided, skip the worker-role label check.
          // Dead panes often lose their labels — the coordinator knows what it's
          // targeting and we only need to protect working panes and our own pane.
          if (agentStatus === "working" || agentStatus === "blocked") {
            return err(
              `Pane ${targetId} is ${agentStatus} — cleanup_panes protects active/blocked workers. Inspect or unblock it first.`,
            );
          }

          if (agentStatus === "idle" && !params.force) {
            return err(`Pane ${targetId} is idle — pass force=true to close idle workers.`);
          }

          if (params.dry_run) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    ok: true,
                    action: "would close",
                    closed: [targetId],
                    skipped: [],
                    count: 1,
                  }),
                },
              ],
              details: {
                ok: true,
                action: "would close",
                closed: [targetId],
                skipped: [],
                count: 1,
              },
            };
          }

          try {
            herdr(`pane close ${targetId}`);
          } catch (e) {
            return err(`Pane ${targetId} close failed: ${String(e)}`);
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  action: "closed",
                  closed: [targetId],
                  skipped: [],
                  count: 1,
                }),
              },
            ],
            details: {
              ok: true,
              action: "closed",
              closed: [targetId],
              skipped: [],
              count: 1,
            },
          };
        }

        // --- Bulk mode: scan and close all stale worker panes ---
        const result = herdrJson(`pane list --workspace ${workspaceId}`);
        const panes =
          ((result.result as Record<string, unknown> | undefined)?.panes as
            Record<string, unknown>[] | undefined) || [];

        // User-owned tabs (e.g. "don't close — frontend") are off-limits:
        // never bulk-close panes inside them. Labels come from tab list.
        const protectedTabIds = new Set<string>();
        try {
          const tabResult = herdrJson(`tab list --workspace ${workspaceId}`);
          const tabPayload = (tabResult.result as Record<string, unknown> | undefined) || {};
          const tabs = (tabPayload.tabs as Record<string, unknown>[] | undefined) || [];
          for (const t of tabs) {
            const id = t.tab_id as string;
            if (!id) continue;
            if (isProtectedTabLabel((t.label as string) || "")) protectedTabIds.add(id);
          }
        } catch {
          // Can't verify tab labels — fail open so bulk cleanup isn't
          // blocked by a herdr hiccup; targeted + spawn guards still hold.
        }

        // Current pane ID — never close ourselves, even if labeled as a worker.
        // (Already set above before the targeted-mode branch.)

        // 2. Filter to stale worker panes
        const toClose: string[] = [];
        const skipped: string[] = [];

        for (const pane of panes) {
          const label = (pane.label as string) || "";
          const herdrStatus = (pane.agent_status as string) || "unknown";
          const paneId = (pane.pane_id as string) || "";
          // Cross-check picode heartbeat: herdr may report working/blocked
          // for a dead process. A stale heartbeat → treat as unknown so
          // zombies get cleaned up, not protected.
          const agentStatus = effectiveAgentStatus(herdrStatus, extractRole(label));

          // Safety: never close the pane running this tool (the coordinator).
          if (paneId === currentPaneId) {
            skipped.push(paneId);
            continue;
          }

          // Never bulk-close panes inside user-owned tabs.
          const paneTabId = (pane.tab_id as string) || "";
          if (paneTabId && protectedTabIds.has(paneTabId)) continue;

          const role = extractRole(label);
          if (!WORKER_ROLE_PATTERN.test(role)) {
            continue; // Not a worker role
          }

          // Working and blocked panes are always protected. Blocked workers
          // need inspection/input, not automatic cleanup.
          if (agentStatus === "working" || agentStatus === "blocked") {
            skipped.push(paneId);
            continue;
          }

          // Idle panes are protected unless force=true
          if (agentStatus === "idle" && !params.force) {
            skipped.push(paneId);
            continue;
          }

          toClose.push(paneId);
        }

        // 3. Close stale panes (or just list if dry_run)
        const closed: string[] = [];
        if (!params.dry_run) {
          for (const paneId of toClose) {
            try {
              herdr(`pane close ${paneId}`);
              closed.push(paneId);
            } catch {
              // Do not claim a failed close succeeded.
            }
          }
        }

        const count = params.dry_run ? toClose.length : closed.length;
        const action = params.dry_run ? "would close" : "closed";

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                action,
                closed: params.dry_run ? toClose : closed,
                skipped,
                count,
              }),
            },
          ],
          details: {
            ok: true,
            action,
            closed: params.dry_run ? toClose : closed,
            skipped,
            count,
          },
        };
      } catch (e) {
        return err(`cleanup_panes unexpected error: ${String(e)}`);
      }
    },
    renderCall: quietCallRenderer("cleanup_panes"),
    renderResult: quietToolResult,
  });
}
