import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import { err, extractRole, effectiveAgentStatus } from "./shared";

/** Statuses that mean the pane is still useful — don't close these. */
const ACTIVE_STATUSES = new Set(["working", "idle", "done"]);

function herdr(args: string): string {
  return execSync(`herdr ${args}`, { encoding: "utf-8", timeout: 15_000 });
}

function herdrJson(args: string): Record<string, unknown> {
  const raw = herdr(args);
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    console.error(`[picode_panes] herdr JSON parse failed for: ${args} — ${String(e)}`);
    return {};
  }
}

interface PaneSummary {
  pane_id: string;
  label: string;
  agent_status: string;
  workspace_id: string;
  tab_id: string;
  cwd: string;
  rect?: { x: number; y: number; width: number; height: number };
  suggestion?: string;
}

export function registerPanesTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "picode_panes",
    label: "Picode Panes",
    description:
      "Survey all Herdr panes in the workspace. Shows agent status, position, and role for each pane. Use this to check which workers are idle (reuse them), working (leave alone), or stopped (clean them up). Prefer reusing idle workers over spawning new ones.",
    promptSnippet: "Survey all Herdr panes: status, position, role (find idle workers to reuse).",
    parameters: Type.Object({
      workspace: Type.Optional(
        Type.String({
          description: "Filter to a specific workspace id (e.g. w7). Default: all workspaces.",
        }),
      ),
      status: Type.Optional(
        Type.String({
          description:
            "Filter by agent_status: idle, working, blocked, done, unknown. Default: all.",
        }),
      ),
      includeLayout: Type.Optional(
        Type.Boolean({
          description: "Include position/size rect for each pane. Default: false.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (!process.env.HERDR_ENV) {
        return err("HERDR_ENV not set — picode_panes only works inside Herdr panes.");
      }

      try {
        // One call gets everything: panes, layouts, agents, workspaces
        const snapshot = herdrJson("api snapshot");
        const snap =
          ((snapshot.result as Record<string, unknown> | undefined)?.snapshot as
            Record<string, unknown> | undefined) || {};

        const panes =
          ((snap.panes as Record<string, unknown>[] | undefined) || []).filter(
            p => (p.agent as string | undefined) !== undefined,
          ) || [];

        const layouts = (snap.layouts as Record<string, unknown>[]) || [];

        // Build a map of pane_id → rect from layouts
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

        // Filter
        let filtered = panes;
        if (params.workspace) {
          filtered = filtered.filter(p => p.workspace_id === params.workspace);
        }
        if (params.status) {
          filtered = filtered.filter(p => p.agent_status === params.status);
        }

        // Build summaries with suggestions
        const summaries: PaneSummary[] = filtered.map(p => {
          const label = (p.label as string) || "";
          const herdrStatus = (p.agent_status as string) || "unknown";
          const paneId = (p.pane_id as string) || "";
          // Cross-check picode heartbeat: herdr's working/blocked can be a
          // lie when the worker process died without a clean shutdown.
          // A stale heartbeat → override to unknown so the coordinator
          // doesn't protect a zombie or skip reusing a dead pane.
          const picodeId = extractRole(label);
          const status = effectiveAgentStatus(herdrStatus, picodeId);

          // Suggestion for coordinator
          let suggestion: string | undefined;
          if (ACTIVE_STATUSES.has(status)) {
            if (status === "idle" || status === "done") {
              suggestion = "REUSE: idle and available for new work";
            } else {
              suggestion = "LEAVE: currently working";
            }
          } else if (status === "blocked") {
            suggestion = "CHECK: blocked — may need input";
          } else {
            suggestion = "CLEANUP: not active, candidate for removal";
          }

          return {
            pane_id: paneId,
            label,
            agent_status: status,
            workspace_id: (p.workspace_id as string) || "",
            tab_id: (p.tab_id as string) || "",
            cwd: (p.cwd as string) || "",
            ...(params.includeLayout && rectMap.has(paneId) ? { rect: rectMap.get(paneId) } : {}),
            suggestion,
          };
        });

        // Format text output
        const lines: string[] = [];
        const workspaces = new Map<string, PaneSummary[]>();
        for (const s of summaries) {
          const ws = workspaces.get(s.workspace_id) || [];
          ws.push(s);
          workspaces.set(s.workspace_id, ws);
        }

        // Summary counts
        const idleCount = summaries.filter(
          s => s.agent_status === "idle" || s.agent_status === "done",
        ).length;
        const workingCount = summaries.filter(s => s.agent_status === "working").length;
        const blockedCount = summaries.filter(s => s.agent_status === "blocked").length;
        const unknownCount = summaries.filter(s => s.agent_status === "unknown").length;

        lines.push(
          `Panes: ${summaries.length} total (${workingCount} working, ${idleCount} idle, ${blockedCount} blocked, ${unknownCount} unknown)`,
        );
        lines.push("");

        for (const [wsId, wsPanes] of workspaces) {
          const wsInfo = ((snap.workspaces as Record<string, unknown>[] | undefined) || []).find(
            w => w.workspace_id === wsId,
          );
          const wsLabel = (wsInfo?.label as string) || wsId;
          const wsStatus = (wsInfo?.agent_status as string) || "";

          lines.push(`Workspace: ${wsLabel} (${wsId}) — ${wsStatus}`);

          // Group by tab
          const tabs = new Map<string, PaneSummary[]>();
          for (const p of wsPanes) {
            const t = tabs.get(p.tab_id) || [];
            t.push(p);
            tabs.set(p.tab_id, t);
          }

          for (const [tabId, tabPanes] of tabs) {
            lines.push(`  Tab ${tabId}`);
            for (const p of tabPanes) {
              const rectStr = p.rect
                ? ` [${p.rect.x}x${p.rect.y}, ${p.rect.width}x${p.rect.height}]`
                : "";
              lines.push(
                `    ${p.pane_id}  ${p.label.padEnd(20)} ${p.agent_status.padEnd(10)} ${p.cwd}${rectStr}`,
              );
              lines.push(`      → ${p.suggestion}`);
            }
          }
          lines.push("");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n") || "(no agent panes found)",
            },
          ],
          details: {
            ok: true,
            total: summaries.length,
            byStatus: {
              working: workingCount,
              idle: idleCount,
              blocked: blockedCount,
              unknown: unknownCount,
            },
            panes: summaries,
          },
        };
      } catch (e) {
        return err(`picode_panes unexpected error: ${String(e)}`);
      }
    },
  });
}
