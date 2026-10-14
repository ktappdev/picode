import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PicodeStore } from "../core/types";
import { formatWorkerDigest, recentWorkers } from "../core/worker-ledger";
import { barrierLines, formatThreadLine, obligationLines, owedLines } from "../core/format";
import { issueSummary } from "../../bin/issue-journal.mjs";
import { registerJournalTool } from "./journal";
import { quietCallRenderer, quietToolResult } from "./shared";
/** Read-only tools: this picode's status, the workspace roster, journals. */
export function registerIntrospectionTools(pi: ExtensionAPI, store: PicodeStore) {
  pi.registerTool({
    name: "picode_status",
    label: "Picode Status",
    description:
      "Read this picode's coordination state, owed-reply ids, and open papercut count. Recover coordination context after compaction; the journal is not a work diary.",
    promptSnippet:
      "Read this picode's coordination state, owed-reply ids, and open papercut count.",
    parameters: Type.Object({
      // Accept old callers without making archival work summaries live again.
      tail: Type.Optional(Type.Number({ description: "Deprecated; use picode_journal." })),
      lookbackMinutes: Type.Optional(
        Type.Number({ description: "Deprecated; use picode_journal." }),
      ),
      compact: Type.Optional(Type.Boolean({ description: "Deprecated; use picode_journal." })),
    }),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const papercuts = issueSummary(ctx.cwd);
      // Build status header — only include sections that have content, so
      // an idle picode doesn't get six "none" lines of noise.
      const sections: string[] = [
        `Id: ${store.picodeId}`,
        `Role: ${store.role ?? "-"}`,
        `State: ${store.state}${store.holdReason ? ` (${store.holdReason})` : ""}`,
        `Status: ${store.status}`,
      ];
      if (store.barriers.length) sections.push(`Barriers:${barrierLines(store.barriers)}`);
      if (store.obligations.length)
        sections.push(`Obligations:${obligationLines(store.obligations)}`);
      if (store.owed.length) sections.push(`Owed replies:${owedLines(store.owed)}`);
      return {
        content: [
          {
            type: "text" as const,
            text: `${sections.join("\n")}\n\n${papercuts} (picode_journal to view).`,
          },
        ],
        details: {
          id: store.picodeId,
          role: store.role,
          state: store.state,
          status: store.status,
          holdReason: store.holdReason,
          obligations: store.obligations,
          owed: store.owed,
          barriers: store.barriers,
        },
      };
    },
    renderCall: quietCallRenderer("picode_status"),
    renderResult: quietToolResult,
  });

  pi.registerTool({
    name: "picode_list",
    label: "Picode List",
    description:
      "List all known threads sharing this workspace and their last known state. Use this to find a valid `to` id before calling picode_send. Pass recent=true for the recent-workers digest — the exact ids, roles, and derived areas of workers that stopped or are still live, which is what `revive_closed_session` needs.",
    promptSnippet:
      "List picodes in the workspace and their last known state (valid `to` ids). Pass recent=true for revivable/stopped workers and what they left unverified.",
    parameters: Type.Object({
      recent: Type.Optional(
        Type.Boolean({
          description:
            "Also return the recent-workers digest: exact id, role, derived area (directories that worker touched), live/stopped, context age, whether HEAD moved since it exited, and what its handoff left unverified. Use this before calling revive_closed_session.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const threads = await store.listPcodes();
      const lines = threads.map(formatThreadLine);
      const parts = [lines.length ? lines.join("\n") : "(no other threads found)"];
      const rows = params.recent ? recentWorkers(ctx?.cwd || process.cwd()) : [];
      if (params.recent) {
        parts.push(
          formatWorkerDigest(rows) ||
            "### Recent workers\n\nNone on record — no worker has written a state file in this workspace yet.",
        );
      }
      return {
        content: [
          {
            type: "text" as const,
            text: parts.join("\n\n"),
          },
        ],
        details: { threads, ...(params.recent ? { recentWorkers: rows } : {}) },
      };
    },
    renderCall: quietCallRenderer("picode_list"),
    renderResult: quietToolResult,
  });

  registerJournalTool(pi, store);
}
