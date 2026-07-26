import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import { err, extractRole } from "./shared";

/** Worker role labels to clean up (case-insensitive, emoji prefix stripped).
 *  Matches base role and suffixed variants (worker, worker-1, builder-2, etc.). */
const WORKER_ROLE_PATTERN =
  /^(builder|reviewer|tester|worker|scout|bug-hunter|designer|planner|runner|explorer)(-[0-9]+)?$/i;

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

export function registerCleanupPanesTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cleanup_panes",
    label: "Cleanup Panes",
    description:
      "Close stale herdr worker panes spawned by the coordinator. Removes panes with role labels (builder, reviewer, tester, worker, scout, bug-hunter, designer, planner, runner, explorer) that are not working. Use when the picode list is cluttered with dead workers. Pass pane_id to close a specific pane. Pass force=true to close idle/done workers too (e.g. when user says 'close all').",
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
      const workspaceId = process.env.HERDR_WORKSPACE_ID;

      if (!workspaceId) {
        return err("HERDR_WORKSPACE_ID not set — cleanup_panes only works inside Herdr panes.");
      }

      const currentPaneId = process.env.HERDR_PANE_ID || "";

      try {
        // --- Targeted mode: close a specific pane ---
        if (params.pane_id) {
          const targetId = params.pane_id.trim();

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
            paneInfo = (result.result as Record<string, unknown> | undefined) || null;
          } catch {
            // pane get may fail if pane doesn't exist
          }

          if (!paneInfo) {
            return err(
              `Pane ${targetId} not found — it may already be closed. Run picode_panes() to see current panes.`,
            );
          }

          const agentStatus = (paneInfo.agent_status as string) || "unknown";

          // When pane_id is explicitly provided, skip the worker-role label check.
          // Dead panes often lose their labels — the coordinator knows what it's
          // targeting and we only need to protect working panes and our own pane.
          if (agentStatus === "working") {
            return err(
              `Pane ${targetId} is working — cleanup_panes does not close working panes. Wait for it to finish.`,
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
          } catch {
            // Non-fatal — pane may already be closed
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

        // Current pane ID — never close ourselves, even if labeled as a worker.
        // (Already set above before the targeted-mode branch.)

        // 2. Filter to stale worker panes
        const toClose: string[] = [];
        const skipped: string[] = [];

        for (const pane of panes) {
          const label = (pane.label as string) || "";
          const agentStatus = (pane.agent_status as string) || "unknown";
          const paneId = (pane.pane_id as string) || "";

          // Safety: never close the pane running this tool (the coordinator).
          if (paneId === currentPaneId) {
            skipped.push(paneId);
            continue;
          }

          const role = extractRole(label);
          if (!WORKER_ROLE_PATTERN.test(role)) {
            continue; // Not a worker role
          }

          // Working panes are always protected (even with force)
          if (agentStatus === "working") {
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
              // Non-fatal — pane may already be closed
              closed.push(paneId);
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
  });
}
