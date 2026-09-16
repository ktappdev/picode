import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PicodeStore } from "../core/types";
import { readHandoff } from "../core/handoff";
import { deriveAreaCached, headMovedSince } from "../core/worker-ledger";
import { resolveModelForRole } from "../core/model-config";
import { deadlineFromSeconds } from "../core/time";
import type { Inbox } from "../inbox";
import {
  belongsToWorkspace,
  err,
  extractRole,
  isProtectedTabLabel,
  isValidPaneId,
  quietToolResult,
  shellQuote,
  tabLabelMap,
} from "./shared";
import { buildWorkerLaunchCommand, fetchSnapshot, getSplitTarget, resolveTheme } from "./spawn";

function herdr(args: string): string {
  return execSync(`herdr ${args}`, { encoding: "utf-8", timeout: 15_000 });
}

function herdrJson(args: string): Record<string, unknown> {
  try {
    return JSON.parse(herdr(args)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true; // EPERM or other — the process exists
  }
}

/** picode ids are user-controlled, so validate before they reach a shell
 *  argument or a path join. */
function validatePicodeId(id: string): string | null {
  if (!id) return "picode_id is required";
  if (id.length > 64) return `picode_id too long: ${id.length} chars (max 64)`;
  if (!/^[a-zA-Z0-9-]+$/.test(id)) {
    return `picode_id contains invalid characters: ${id} (only a-z, A-Z, 0-9, hyphen)`;
  }
  return null;
}

/** Find a pane still sitting there labeled for this picode with no live agent
 *  on it — the residue of a closed pane whose worker process already exited.
 *  Reclaiming it keeps the layout compact instead of splitting a fresh one. */
function findDeadPane(
  panes: Array<Record<string, unknown>>,
  workspaceId: string,
  currentPaneId: string,
  picodeId: string,
  protectedTabIds: Set<string>,
): string | null {
  for (const pane of panes) {
    const paneId = (pane.pane_id as string) || "";
    if (!paneId || paneId === currentPaneId) continue;
    if (pane.workspace_id !== workspaceId) continue;
    if (protectedTabIds.has((pane.tab_id as string) || "")) continue;

    const label = (pane.label as string) || "";
    if (extractRole(label).toLowerCase() !== picodeId.toLowerCase()) continue;

    // The id is interpolated into shell commands below, so it must be
    // shape-checked rather than trusted (mirrors the split-result check).
    if (!isValidPaneId(paneId)) continue;

    // Same rule as spawn.ts's empty-pane reclaim: no agent attached at all.
    // A pane whose agent is merely idle/done still has a live process, and
    // launching over it would clobber a running worker.
    const agent = pane.agent as string | null;
    if (agent) continue;

    const terminalId = (pane.terminal_id as string) || "";
    if (!terminalId) continue;

    // A stale script left in the pane would intercept the launch text, so
    // only claim a pane with nothing running in the foreground.
    try {
      const info = (
        herdrJson(`pane process-info --pane ${paneId}`).result as
          Record<string, unknown> | undefined
      )?.process_info as Record<string, unknown> | undefined;
      const foreground = (info?.foreground_processes as Array<Record<string, unknown>>) || [];
      if (foreground.length > 0) continue;
    } catch {
      continue; // can't verify — don't claim it
    }
    return paneId;
  }
  return null;
}

/** Revive a stopped worker: split (or reclaim) a pane, resume its own Pi
 *  session, and hand it the continuation.
 *
 *  This is not `picode_round_table` — that resumes a session read-only for one
 *  question and shuts down. This puts the same agent back on duty with full
 *  tools, its mailbox, its journal, and whatever replies it still owed.
 *
 *  It is also not the Restate `deliverDue` wake (`restate/wake-launch.ts`),
 *  which boots a *blank* agent that only has the due envelope. Reviving a
 *  session is strictly riskier than both: the resumed context is a snapshot
 *  of the tree at the moment the worker stopped, and a confident edit against
 *  a world that has moved on is worse than a fresh worker. Hence the freshness
 *  numbers in the result — the caller is expected to read them. */
export function registerReviveTool(pi: ExtensionAPI, store: PicodeStore, inbox: Inbox) {
  pi.registerTool({
    name: "revive_closed_session",
    label: "Revive Closed Session",
    description:
      "Bring a stopped worker back on duty in its own resumed Pi session — full tools, its journal, and its mailbox — and hand it the continuation. Use when new work lands in territory a specific stopped worker already mapped and its knowledge still holds. Prefer spawn_worker for anything a fresh worker could do from a brief, and picode_round_table when you only need its knowledge without it acting. Pass dry_run=true to inspect a candidate first.",
    promptSnippet:
      "Revive a stopped worker with its session intact and give it the continuation (coordinator only).",
    parameters: Type.Object({
      picode_id: Type.String({
        description:
          "Exact id of the stopped worker to revive (e.g. 'builder-1'). Take it from the Recent workers list — never guess or construct one.",
      }),
      task: Type.Optional(
        Type.String({
          description:
            "The continuation: what this worker should now do with the context it already has. Required unless it already has queued mail waiting. Be specific — this is the whole point of reviving it rather than spawning fresh.",
        }),
      ),
      model: Type.Optional(
        Type.String({ description: "Optional model override for the revived worker." }),
      ),
      tab: Type.Optional(
        Type.String({
          description:
            "Tab to revive into (e.g. w1:t3). Default: current tab. Returns tab_full=true when the tab has no room — call picode_tab_create then retry.",
        }),
      ),
      direction: Type.Optional(
        Type.Union([Type.Literal("right"), Type.Literal("down")], {
          description: "Override split direction. Omit to auto-detect from pane geometry.",
        }),
      ),
      dry_run: Type.Optional(
        Type.Boolean({
          description:
            "Report what would be revived (session, context age, freshness, handoff) without opening a pane.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (store.role !== "coordinator") {
        return err(
          "revive_closed_session is coordinator-only — report the need to your coordinator.",
        );
      }

      const idError = validatePicodeId(params.picode_id);
      if (idError) return err(idError);

      const picodeId = params.picode_id;
      if (picodeId === "coordinator") {
        return err("The coordinator is not a revive target — revive a worker instead.");
      }

      // Durable state first: it holds the session handle and the ground truth
      // about whether this picode is actually stopped.
      const state = await store.adapter.loadPicodeState(picodeId);
      if (!state) {
        return err(
          `No picode "${picodeId}" exists in this workspace. Use the Recent workers list for exact ids.`,
        );
      }
      if (!state.sessionFile) {
        return err(
          `Picode "${picodeId}" has no saved session file — there is no conversation to resume. Spawn a fresh worker instead.`,
        );
      }
      if (!existsSync(state.sessionFile)) {
        return err(
          `The saved session for "${picodeId}" no longer exists on disk (${state.sessionFile}). Spawn a fresh worker instead.`,
        );
      }

      const role = state.role || "worker";
      if (role === "coordinator") {
        return err(`Picode "${picodeId}" is a coordinator — only workers can be revived.`);
      }
      if (state.cwd && state.cwd !== process.cwd()) {
        return err(
          `"${picodeId}" was last running in ${state.cwd}, not this workspace — its session cannot be resumed here.`,
        );
      }

      // Already running? Resuming a session that a live process is appending
      // to would corrupt it, so this is a hard refusal, not a warning.
      const live = (await store.listPcodes()).find(
        t => t.id === picodeId && t.status === "running",
      );
      if (live && (typeof live.pid !== "number" || isPidAlive(live.pid))) {
        return err(
          `"${picodeId}" is already running (pid ${live.pid}). Send it work with picode_send instead of reviving it.`,
        );
      }

      // The risk picture the caller must see before deciding.
      const picodeDir = join(store.picodesRootDir, picodeId);
      const handoff = readHandoff(picodeDir);
      const risk = {
        picode_id: picodeId,
        role,
        session_file: state.sessionFile,
        last_state: state.state,
        context_age_minutes: Math.max(
          0,
          Math.round((Date.now() - new Date(state.lastSeen).getTime()) / 60_000),
        ),
        head_moved_since_exit: headMovedSince(process.cwd(), state.lastSeen),
        area: deriveAreaCached(state.sessionFile, process.cwd()),
        handoff,
      };

      const warnings: string[] = [];
      if (risk.head_moved_since_exit === true) {
        warnings.push(
          "Commits landed after this worker stopped — its recalled state may be stale. Say so in the task.",
        );
      }
      if (handoff?.outcome === "abandoned") {
        warnings.push(
          "This worker last abandoned its task. Revive it only for a different, better-scoped job.",
        );
      }
      if (handoff?.outcome === "blocked") {
        warnings.push(
          `This worker last stopped blocked. Unblock it in the task or expect it to stall.`,
        );
      }
      if (handoff?.leftUnverified) {
        warnings.push(`Its last handoff left unverified: ${handoff.leftUnverified}`);
      }

      if (params.dry_run) {
        const result = {
          ok: true,
          dry_run: true,
          ...risk,
          ...(warnings.length ? { warnings } : {}),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      }

      const queued = await store.adapter.countQueued(picodeId);
      const task = params.task?.trim();
      if (!task && queued === 0) {
        return err(
          `revive_closed_session needs a task — nothing is waiting in "${picodeId}"'s mailbox. Name the continuation so the revived worker knows what to do.`,
        );
      }

      const paneId = process.env.HERDR_PANE_ID;
      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      if (!paneId || !workspaceId) {
        return err("revive_closed_session requires a coordinator running in a Herdr pane.");
      }

      const targetTabId = params.tab || process.env.HERDR_TAB_ID || "";
      if (!targetTabId) {
        return err("No tab id — HERDR_TAB_ID not set and no tab param given.");
      }
      if (!isValidPaneId(targetTabId)) {
        return err(`Invalid tab_id "${targetTabId}" — expected Herdr format like w1:t3.`);
      }
      if (!belongsToWorkspace(targetTabId, workspaceId)) {
        return err(
          `tab_id ${targetTabId} is outside current herdr workspace ${workspaceId}. Use an exact tab id from picode_panes().`,
        );
      }

      const snapshot = fetchSnapshot();
      if (!snapshot) return err("Failed to fetch herdr snapshot — is herdr running?");

      const protectedTabIds = new Set<string>();
      const tabLabels = tabLabelMap(snapshot.tabs);
      for (const [tabId, label] of tabLabels) {
        if (isProtectedTabLabel(label)) protectedTabIds.add(tabId);
      }
      if (
        protectedTabIds.has(targetTabId) ||
        isProtectedTabLabel(tabLabels.get(targetTabId) || "")
      ) {
        return err(
          `Tab ${targetTabId} is user-owned ("don't close") — refusing to revive into it.`,
        );
      }

      let newPaneId: string;
      let reclaimed = false;
      try {
        const dead = findDeadPane(snapshot.panes, workspaceId, paneId, picodeId, protectedTabIds);
        if (dead) {
          newPaneId = dead;
          reclaimed = true;
        } else {
          const target = getSplitTarget(paneId, workspaceId, role, targetTabId, snapshot);
          if (!target) {
            const paneCount = snapshot.panes.filter(
              p => p.workspace_id === workspaceId && p.tab_id === targetTabId && p.agent_status,
            ).length;
            const full = {
              ok: false,
              tab_full: true,
              tab_id: targetTabId,
              pane_count: paneCount,
              message: `Tab ${targetTabId} is full (${paneCount} panes, none with room to split). Call picode_tab_create() then retry with the new tab_id.`,
            };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(full) }],
              details: full,
            };
          }
          if (params.direction) target.direction = params.direction;
          const split = herdrJson(
            `pane split ${target.paneId} --direction ${target.direction} --no-focus`,
          );
          const splitPane = (split.result as Record<string, unknown>)?.pane as
            Record<string, unknown> | undefined;
          newPaneId = splitPane?.pane_id as string;
          // Same validation round-table.ts does: the id goes straight into
          // `herdr pane rename`/`run` args, so a malformed value must not be
          // interpolated just because herdr returned it.
          if (!newPaneId || !isValidPaneId(newPaneId)) {
            return err(`herdr pane split returned no usable pane_id: ${JSON.stringify(split)}`);
          }
        }

        // Label it for this picode so the worker is findable even if it dies
        // again before its own startup renames the pane.
        herdr(`pane rename ${newPaneId} "${picodeId}"`);

        // Claiming a pane that still has a stale process in it would swallow
        // the launch text — findDeadPane checks for that, but a race is
        // possible, so send a harmless Ctrl-C first.
        if (reclaimed) {
          try {
            herdr(`pane send-keys ${newPaneId} C-c`);
          } catch {
            // Non-fatal — there may be nothing to interrupt.
          }
        }

        const launch = buildWorkerLaunchCommand({
          picodeId,
          role,
          model: params.model ?? resolveModelForRole(role),
          theme: resolveTheme(),
          sessionFile: state.sessionFile,
          revivedAt: state.lastSeen,
        });
        herdr(`pane run ${newPaneId} ${shellQuote(launch)}`);
      } catch (e) {
        return err(`revive_closed_session failed while starting the pane: ${String(e)}`);
      }

      let launchWarning: string | undefined;
      try {
        herdr(`wait agent-status ${newPaneId} --status idle --timeout 30000`);
      } catch {
        launchWarning =
          "The revived worker did not report idle within 30s — it may still be starting.";
      }

      // The mailbox is durable, so the envelope is safe to send even before
      // the process is fully up: a cold-start drain delivers it at boot.
      let requestId: string | null = null;
      if (task) {
        try {
          const sent = await inbox.sendEnvelope(picodeId, task, {
            expects: true,
            deadline: deadlineFromSeconds(undefined),
          });
          requestId = sent.id;
        } catch (e) {
          return err(
            `Pane ${newPaneId} is running, but handing over the task failed: ${String(e)}. Send it with picode_send.`,
          );
        }
      }

      const result = {
        ok: true,
        pane_id: newPaneId,
        reused_pane: reclaimed,
        ...risk,
        task_sent: Boolean(task),
        queued_mail_waiting: queued,
        request_id: requestId,
        ...(launchWarning ? { launch_warning: launchWarning } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };

      ctx?.ui?.notify(
        `Revived ${picodeId} (${role}) — context ${risk.context_age_minutes}m old${
          risk.head_moved_since_exit ? ", commits landed since" : ""
        }.`,
        "info",
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
    renderResult: quietToolResult,
  });
}
