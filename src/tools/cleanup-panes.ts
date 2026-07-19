import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import { err, extractRole } from "./shared";

/** Worker role labels to clean up (case-insensitive, emoji prefix stripped). */
const WORKER_ROLE_PATTERN = /^(builder|reviewer|tester|worker|scout|bug-hunter|designer)$/i;

/** Statuses that mean the pane is still useful — don't close these. */
const ACTIVE_STATUSES = new Set(["working", "idle"]);

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
      "Close stale herdr worker panes spawned by the coordinator. Removes panes with role labels (builder, reviewer, tester, worker, scout, bug-hunter, designer) that are not working or idle. Use when the picode list is cluttered with dead workers.",
    promptSnippet:
      "Close stale herdr worker panes (use when workspace is cluttered with dead workers).",
    parameters: Type.Object({
      dry_run: Type.Optional(
        Type.Boolean({
          description: "If true, list what would be closed without actually closing them.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const workspaceId = process.env.HERDR_WORKSPACE_ID;

      if (!workspaceId) {
        return err("HERDR_WORKSPACE_ID not set — cleanup_panes only works inside Herdr panes.");
      }

      try {
        // 1. List all panes in the workspace
        const result = herdrJson(`pane list --workspace ${workspaceId}`);
        const panes =
          ((result.result as Record<string, unknown> | undefined)?.panes as
            Record<string, unknown>[] | undefined) || [];

        // Current pane ID — never close ourselves, even if labeled as a worker.
        const currentPaneId = process.env.HERDR_PANE_ID || "";

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

          if (ACTIVE_STATUSES.has(agentStatus)) {
            skipped.push(paneId);
            continue; // Still active
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
