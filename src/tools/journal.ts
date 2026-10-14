import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PicodeStore } from "../core/types";
import { compactEntry, splitJournalEntries } from "../journal";
import {
  formatIssues,
  issueJournalPath,
  readIssues,
  reportIssue,
} from "../../bin/issue-journal.mjs";
import { err, quietCallRenderer, quietToolResult } from "./shared";

export function registerJournalTool(pi: ExtensionAPI, store: PicodeStore) {
  pi.registerTool({
    name: "picode_journal",
    label: "Picode Papercuts",
    description:
      "Report or list tool, harness, and setup friction in the shared .picode/issues.md papercut journal. Default: list open issues. Report observed problems, impact, workarounds, and help needed, not task progress or ordinary application bugs. Agents cannot mark issues solved; the operator uses /picode-journal solve. action=archive with a picode id reads an old work journal (read-only compatibility).",
    promptSnippet:
      "Report actionable tool/harness/setup papercuts or list open issues. No work summaries; never log secrets. Escalate blockers separately to your coordinator/operator.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("list"), Type.Literal("report"), Type.Literal("archive")]),
      ),
      id: Type.Optional(
        Type.String({
          description:
            "Issue id (PC-001) for list, or old picode id for archive. Legacy id-only calls read archives.",
        }),
      ),
      status: Type.Optional(
        Type.Union([Type.Literal("open"), Type.Literal("solved"), Type.Literal("all")]),
      ),
      title: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 200,
          description:
            "Report: short stable title. Reuse the title/area of an existing open issue to record a repeat.",
        }),
      ),
      area: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 100,
          description: "Report: affected tool, harness, or setup component.",
        }),
      ),
      problem: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 2000,
          description:
            "Report: observed failure, with concise evidence. No credentials or secrets.",
        }),
      ),
      impact: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 2000,
          description: "Report: why it mattered or what it blocked.",
        }),
      ),
      workaround: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
      help: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 2000,
          description: "Report: specific operator help needed, if any.",
        }),
      ),
      tail: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Latest N matching issues/archive entries. Default 15; 0 for all (output is bounded).",
        }),
      ),
      lookbackMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      compact: Type.Optional(
        Type.Boolean({ description: "One-line summaries by default; false for issue details." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const action =
          params.action ?? (params.id && !/^PC-\d+$/.test(params.id) ? "archive" : "list");
        if (action === "report") {
          const { title, area, problem, impact, workaround, help } = params;
          if (!title || !area || !problem || !impact)
            throw new Error("Reporting requires title, area, problem, and impact.");
          const result = await reportIssue(
            ctx.cwd,
            { title, area, problem, impact, workaround, help },
            `${store.role} · ${store.picodeId}`,
            signal,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `${result.repeated ? "Recorded repeat of" : "Reported"} ${result.id} in ${issueJournalPath(ctx.cwd)}. If blocking, also request the specific help needed from your coordinator/operator.`,
              },
            ],
            details: { ok: true, ...result },
          };
        }
        if (action === "archive") {
          if (!params.id) throw new Error("archive requires a picode id.");
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(params.id))
            throw new Error("Invalid picode id.");
          if (!store.adapter.readJournal)
            throw new Error("This storage backend has no journal channel (legacy archive).");
          if (!(await store.threadExists(params.id)))
            throw new Error(`No picode "${params.id}" found. Call picode_list to see known ids.`);
          let entries = splitJournalEntries((await store.readJournal(params.id)) ?? "");
          if (params.lookbackMinutes) {
            const cutoff = Date.now() - params.lookbackMinutes * 60_000;
            entries = entries.filter(entry => {
              const stamp = /^<!--\s*(.+?)\s*-->/.exec(entry)?.[1];
              const ts = stamp ? Date.parse(stamp.replace(" ", "T") + ":00Z") : NaN;
              return !Number.isFinite(ts) || ts >= cutoff;
            });
          }
          const tail = params.tail ?? 15;
          if (tail > 0) entries = entries.slice(-tail);
          const journal =
            entries
              .map(entry => (params.compact === false ? entry : compactEntry(entry)))
              .join("\n") || "(no journal entries yet)";
          return {
            content: [
              {
                type: "text" as const,
                text: `Archived journal for ${params.id}:\n\n${journal.slice(0, 24_000)}`,
              },
            ],
            details: { ok: true, id: params.id, journal },
          };
        }
        if (action !== "list")
          throw new Error(
            "action must be list, report, or archive; only the operator can solve issues.",
          );
        const issues = readIssues(ctx.cwd);
        const journal = formatIssues(issues, {
          ...params,
          status: params.status ?? (params.id ? "all" : "open"),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Papercut journal (${issueJournalPath(ctx.cwd)}):\n\n${journal}`,
            },
          ],
          details: { ok: true, journal },
        };
      } catch (error) {
        return { ...err(error instanceof Error ? error.message : String(error)), isError: true };
      }
    },
    renderCall: quietCallRenderer("picode_journal"),
    renderResult: quietToolResult,
  });
}
