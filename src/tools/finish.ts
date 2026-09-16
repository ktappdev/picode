import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PicodeStore } from "../core/types";
import { writeHandoff, type HandoffNote, type HandoffOutcome } from "../core/handoff";
import { nowIso } from "../core/time";
import type { Inbox } from "../inbox";
import { err, quietToolResult } from "./shared";

/** The report body used when the worker doesn't write its own. Mirrors the
 *  handoff note so the coordinator and the ledger say the same thing. */
function defaultReport(outcome: HandoffOutcome, changed: string, leftUnverified: string): string {
  return [`Handoff (${outcome})`, `changed: ${changed}`, `left unverified: ${leftUnverified}`].join(
    "\n",
  );
}

/** Close out an assigned task: record a durable handoff note and deliver the
 *  final report in one call.
 *
 *  The note is written *before* the send, so a failed report never loses the
 *  record of what happened — which is the whole reason the worker, not the
 *  coordinator, authors it. Note that this tool deliberately does not touch
 *  picode state: `lifecycle.ts` already settles every run into `done` at
 *  agent_end, so `state` says "a run ended", never "the contract succeeded".
 *  Only `outcome` carries that meaning, and only because the worker said so. */
export function registerFinishTool(pi: ExtensionAPI, store: PicodeStore, inbox: Inbox) {
  pi.registerTool({
    name: "picode_finish",
    label: "Finish Work",
    description:
      "Close out your assigned task: record a handoff note (what landed, what you left unverified) and send your final report to the coordinator in one call. Use this for your end-of-task report instead of picode_send — it is what a future revival of this thread reads to see what was actually left open.",
    promptSnippet:
      "Finish your task: record a handoff note and send your final report (workers only).",
    parameters: Type.Object({
      outcome: Type.Union(
        [Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("abandoned")],
        {
          description:
            "How the task ended. completed = you believe the work landed and works; blocked = you need something to proceed; abandoned = you stopped without finishing.",
        },
      ),
      changed: Type.String({
        description:
          "What actually landed — concrete, one or two sentences. Name files or behaviours, not intentions.",
      }),
      leftUnverified: Type.String({
        description:
          "What you did not check, ran out of scope on, or are unsure of. Write 'nothing' if you verified everything. This is the most useful line for whoever picks the work up next — do not pad it with false confidence.",
      }),
      report: Type.Optional(
        Type.String({
          description:
            "Your final report to the coordinator. Omit to send a summary built from outcome/changed/leftUnverified.",
        }),
      ),
      re: Type.Optional(
        Type.String({
          description:
            "The envelope id this finish closes (from picode_status). Only needed when you are holding more than one owed reply — with exactly one, it is inferred.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (store.role === "coordinator") {
        return err(
          "picode_finish is worker-only — the coordinator has no assigned contract to close.",
        );
      }
      if (!store.picodeId || !store.picodeDir) {
        return err(
          "No picode identity in this session — picode_finish only works inside a picode.",
        );
      }

      const note: HandoffNote = {
        id: store.picodeId,
        role: store.role,
        outcome: params.outcome,
        changed: params.changed,
        leftUnverified: params.leftUnverified,
        at: nowIso(),
      };

      // Record first. A send failure must not lose the only account of what
      // this thread actually did.
      try {
        writeHandoff(store.picodeDir, note);
      } catch (e) {
        return err(`picode_finish could not record the handoff note: ${String(e)}`);
      }

      // Close an outstanding request when it is unambiguous. With several
      // owed replies, refuse to guess which one this closes — misdirecting a
      // reply is worse than leaving the correlation to the next send.
      const owed = params.re
        ? store.owed.find(o => o.id === params.re)
        : store.owed.length === 1
          ? store.owed[0]
          : undefined;
      const to = owed?.from ?? store.parent ?? "coordinator";
      const body =
        params.report?.trim() || defaultReport(note.outcome, note.changed, note.leftUnverified);

      let requestId: string;
      try {
        const sent = await inbox.sendEnvelope(to, body, owed ? { re: owed.id } : {});
        requestId = sent.id;
      } catch (e) {
        return err(
          `Handoff note recorded, but the report to ${to} failed: ${String(e)}. The note is durable; re-send with picode_send.`,
        );
      }

      const warnings: string[] = [];
      if (!owed && store.owed.length > 1) {
        warnings.push(
          `${store.owed.length} owed replies outstanding and no re given — sent as a plain note, so those debts remain. Reply to them with picode_send.`,
        );
      }
      if (params.re && !owed) {
        warnings.push(`No owed reply matches re "${params.re}" — sent without correlation.`);
      }

      const result = {
        ok: true,
        handoff: note,
        to,
        re: owed?.id ?? null,
        request_id: requestId,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
    renderResult: quietToolResult,
  });
}
