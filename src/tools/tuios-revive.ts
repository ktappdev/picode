import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PicodeStore } from "../core/types";
import { readHandoff } from "../core/handoff";
import { deriveAreaCached, headMovedSince } from "../core/worker-ledger";
import { resolveModelForRole } from "../core/model-config";
import { deadlineFromSeconds } from "../core/time";
import type { Inbox } from "../inbox";
import type { TuiosRuntime } from "../runtime/tuios";
import { trackTuiosPane } from "../runtime/tuios-listener";
import { err, quietCallRenderer, quietToolResult } from "./shared";
import { resolveTheme, resolveThinking } from "./spawn";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Revive an exact Pi session, never TUIOS resume-agent (Pi has no resume
 * template there). A fresh command-bearing window avoids typing into a live
 * process and preserves argument boundaries for session filenames. */
export function registerTuiosReviveTool(
  pi: ExtensionAPI,
  store: PicodeStore,
  inbox: Inbox,
  runtime: TuiosRuntime,
) {
  pi.registerTool({
    name: "revive_closed_session",
    label: "Revive Closed Session",
    description:
      "Resume a stopped Picode worker's own Pi session in a new TUIOS window and deliver a durable continuation. Use dry_run to inspect freshness first.",
    promptSnippet:
      "Revive a stopped worker's exact Pi session and deliver its task (coordinator only).",
    parameters: Type.Object({
      picode_id: Type.String(),
      task: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      tab: Type.Optional(Type.String()),
      direction: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("down")])),
      dry_run: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (store.role !== "coordinator") return err("revive_closed_session is coordinator-only.");
      const id = params.picode_id;
      if (!id || id.length > 64 || !/^[a-zA-Z0-9-]+$/.test(id) || id === "coordinator") {
        return err("Invalid worker picode_id — use the exact Recent workers ID.");
      }
      const state = await store.adapter.loadPicodeState(id);
      if (!state || !state.sessionFile || !existsSync(state.sessionFile)) {
        return err(`No saved Pi session for ${id}; spawn a fresh worker instead.`);
      }
      if (state.role === "coordinator" || (state.cwd && state.cwd !== process.cwd())) {
        return err(`${id} is not a worker in this project workspace.`);
      }
      const live = (await store.listPcodes()).find(p => p.id === id && p.status === "running");
      if (live && (typeof live.pid !== "number" || pidAlive(live.pid))) {
        return err(`${id} is already running; send it work instead of reviving.`);
      }
      const handoff = readHandoff(join(store.picodesRootDir, id));
      const risk = {
        picode_id: id,
        role: state.role || "worker",
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
      if (risk.head_moved_since_exit)
        warnings.push("Commits landed since this worker stopped; its context may be stale.");
      if (handoff?.outcome === "blocked")
        warnings.push("This worker stopped blocked; unblock it in the task.");
      if (handoff?.outcome === "abandoned") warnings.push("This worker abandoned its prior task.");
      if (handoff?.leftUnverified) warnings.push(`Left unverified: ${handoff.leftUnverified}`);
      const result = (extra: Record<string, unknown>) => {
        const out = { ok: true, ...risk, ...(warnings.length ? { warnings } : {}), ...extra };
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }], details: out };
      };
      if (params.dry_run) return result({ dry_run: true });
      const queued = await store.adapter.countQueued(id);
      const task = params.task?.trim();
      if (!task && !queued) return err(`revive_closed_session needs a task; no mail awaits ${id}.`);
      let paneId: string;
      try {
        await runtime.refresh();
        const tabId = params.tab || runtime.tabId;
        const tab = runtime.assertWritableTab(tabId);
        const options = ["env", "PICODE_RUNTIME=tuios", "pi"];
        const model = params.model || resolveModelForRole(risk.role);
        if (model) options.push("--model", model);
        const theme = resolveTheme();
        if (theme) options.push("--theme", theme);
        const thinking = resolveThinking(risk.role);
        if (thinking) options.push("--thinking", thinking);
        options.push(
          "--session",
          state.sessionFile,
          "--picode-revived",
          state.lastSeen,
          "--picode-id",
          id,
        );
        const opened = await runtime.call("new-window", {
          workspace: tab.number,
          name: id,
          cwd: process.cwd(),
          focus: false,
          command: options,
        });
        if (typeof opened.window_id !== "string")
          return err("TUIOS did not return the revived window ID.");
        paneId = opened.window_id;
        await runtime.refresh();
        runtime.pane(paneId);
        trackTuiosPane(paneId);
      } catch (error) {
        return err(`revive_closed_session failed to launch: ${String(error)}`);
      }
      let launchWarning: string | undefined;
      try {
        await runtime.call(
          "wait-for",
          { condition: "agent-state", window: paneId, until: "idle", timeout: 30_000 },
          35_000,
        );
      } catch {
        launchWarning = "The worker did not report idle within 30s; it may still be starting.";
      }
      let requestId: string | null = null;
      if (task) {
        try {
          const sent = await inbox.sendEnvelope(id, task, {
            expects: true,
            deadline: deadlineFromSeconds(undefined),
          });
          requestId = sent.id;
        } catch (error) {
          return err(
            `Window ${paneId} is running but task delivery failed: ${String(error)}. Use picode_send.`,
          );
        }
      }
      ctx?.ui?.notify(`Revived ${id} — context ${risk.context_age_minutes}m old.`, "info");
      return result({
        pane_id: paneId,
        reused_pane: false,
        task_sent: !!task,
        queued_mail_waiting: queued,
        request_id: requestId,
        ...(launchWarning ? { launch_warning: launchWarning } : {}),
      });
    },
    renderCall: quietCallRenderer("revive_closed_session"),
    renderResult: quietToolResult,
  });
}
