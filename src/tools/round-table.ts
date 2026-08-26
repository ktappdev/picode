import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PicodeStore } from "../core/types";
import { deadlineFromSeconds } from "../core/time";
import { resolveModelForRole } from "../core/model-config";
import { loadRecallParticipant } from "../core/recall-registry";
import type { Inbox } from "../inbox";
import { buildWorkerLaunchCommand, fetchSnapshot, getSplitTarget, resolveTheme } from "./spawn";
import { err, isValidPaneId, quietToolResult } from "./shared";

function herdr(args: string): string {
  return execSync(`herdr ${args}`, { encoding: "utf-8", timeout: 15_000 });
}

function herdrJson(args: string): Record<string, unknown> {
  return JSON.parse(herdr(args)) as Record<string, unknown>;
}

function validParticipantId(id: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(id) && id.length <= 32;
}

export function registerRoundTableTools(pi: ExtensionAPI, store: PicodeStore, inbox: Inbox) {
  pi.registerTool({
    name: "picode_round_table",
    label: "Recall Round Table",
    description:
      "Resume one stopped worker as a read-only consultation participant. It receives one question, replies from retained context or passes, then shuts down.",
    promptSnippet:
      "Resume one exact prior worker for a read-only Recall Round Table consultation (coordinator only).",
    parameters: Type.Object({
      participant: Type.String({
        description: "Exact prior picode id recorded for recall (for example, builder-1).",
      }),
      question: Type.String({ description: "Narrow, self-contained consultation question." }),
      model: Type.Optional(
        Type.String({ description: "Optional model override for this consultation." }),
      ),
      deadlineSeconds: Type.Optional(Type.Number({ description: "Reply deadline in seconds." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (store.role !== "coordinator") return err("picode_round_table is coordinator-only.");
      if (!validParticipantId(params.participant))
        return err("participant must be a valid exact picode id.");

      const participant = loadRecallParticipant(process.cwd(), params.participant);
      if (!participant) return err(`No recalled session exists for "${params.participant}".`);
      if (participant.cwd !== process.cwd()) {
        return err(`Recall session "${params.participant}" belongs to another workspace.`);
      }
      if (!existsSync(participant.sessionFile)) {
        return err(`Saved Pi session for "${params.participant}" no longer exists.`);
      }
      const live = (await store.listPcodes()).find(
        thread => thread.id === participant.id && thread.status === "running",
      );
      if (live)
        return err(`"${params.participant}" is already running; do not resume it for Round Table.`);

      const coordinatorPane = process.env.HERDR_PANE_ID;
      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      const tabId = process.env.HERDR_TAB_ID;
      if (!coordinatorPane || !workspaceId || !tabId) {
        return err("Recall Round Table requires a coordinator running in a Herdr pane and tab.");
      }

      const snapshot = fetchSnapshot();
      if (!snapshot) return err("Failed to fetch Herdr snapshot.");
      const target = getSplitTarget(coordinatorPane, workspaceId, participant.id, tabId, snapshot);
      if (!target)
        return err("Current tab is full; create a tab before starting a Round Table participant.");

      let paneId = "";
      try {
        const split = herdrJson(
          `pane split ${target.paneId} --direction ${target.direction} --no-focus`,
        );
        paneId = ((split.result as Record<string, unknown>)?.pane as Record<string, unknown>)
          ?.pane_id as string;
        if (!paneId || !isValidPaneId(paneId)) throw new Error("split returned no valid pane id");
        herdr(`pane rename ${paneId} "${participant.id}"`);
        const launch = buildWorkerLaunchCommand({
          picodeId: participant.id,
          role: participant.role,
          model: params.model ?? resolveModelForRole(participant.role),
          theme: resolveTheme(),
          sessionFile: participant.sessionFile,
          roundTable: true,
        });
        herdr(`pane run ${paneId} "${launch}"`);
        herdr(`wait agent-status ${paneId} --status idle --timeout 30000`);
        const sent = await inbox.sendEnvelope(participant.id, params.question, {
          expects: true,
          deadline: deadlineFromSeconds(params.deadlineSeconds),
        });
        ctx.ui.notify(
          `Round Table: ${participant.id} (${participant.role}) recalled; awaiting one reply.`,
          "info",
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                participant: participant.id,
                role: participant.role,
                pane_id: paneId,
                request_id: sent.id,
              }),
            },
          ],
          details: {
            ok: true,
            participant: participant.id,
            role: participant.role,
            pane_id: paneId,
            request_id: sent.id,
          },
        };
      } catch (error) {
        if (paneId) {
          try {
            herdr(`pane close ${paneId}`);
          } catch {
            // Best effort: do not hide the launch failure.
          }
        }
        return err(`Recall Round Table launch failed: ${String(error)}`);
      }
    },
    renderResult: quietToolResult,
  });

  pi.registerTool({
    name: "picode_round_table_reply",
    label: "Round Table Reply",
    description: "Send the sole Round Table contribution or PASS, then exit the consultation.",
    parameters: Type.Object({
      outcome: Type.Union([Type.Literal("contribution"), Type.Literal("pass")]),
      body: Type.String({
        description: "Concise contribution, risks, and stale-context caveat; blank when passing.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      if (pi.getFlag("picode-round-table") !== true) {
        return err("picode_round_table_reply is only available in Recall Round Table mode.");
      }
      if (store.owed.length !== 1) {
        return err("Round Table reply requires exactly one pending coordinator request.");
      }
      const owed = store.owed[0];
      const reply = [params.outcome.toUpperCase(), params.body.trim()].filter(Boolean).join("\n\n");
      try {
        await inbox.sendEnvelope(owed.from, reply, { re: owed.id });
        ctx.shutdown();
        return {
          content: [{ type: "text" as const, text: "Round Table reply sent; shutting down." }],
          details: { ok: true },
        };
      } catch (error) {
        return err(`Round Table reply failed: ${String(error)}`);
      }
    },
    renderResult: quietToolResult,
  });
}
