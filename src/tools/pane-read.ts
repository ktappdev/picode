import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import {
  belongsToWorkspace,
  err,
  isValidPaneId,
  quietCallRenderer,
  quietToolResult,
} from "./shared";

/** Valid herdr pane read sources. */
const VALID_SOURCES = new Set(["visible", "recent", "recent-unwrapped", "detection"]);

function herdr(args: string): string {
  return execSync(`herdr ${args}`, { encoding: "utf-8", timeout: 15_000 });
}

/** Read a worker pane's terminal output. Used for silent worker recovery —
 *  when a worker owes a reply but hasn't sent one via picode_send, the
 *  coordinator can read the pane's scrollback to find a plain-text answer
 *  the worker wrote instead of sending through the protocol.
 *
 *  Also useful for inspecting blocked workers, checking error output, or
 *  diagnosing a worker that seems stuck. */
export function registerPaneReadTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "picode_pane_read",
    label: "Read Pane Output",
    description:
      "Read a worker pane's terminal output (scrollback). Use for silent worker recovery — when a worker owes a reply but hasn't sent one via picode_send, read its pane to find a plain-text answer. Also for inspecting blocked workers or error output.",
    promptSnippet:
      "Read a worker pane's terminal output — silent worker recovery, inspect blocked/stuck workers.",
    parameters: Type.Object({
      pane_id: Type.String({
        description:
          "Pane ID to read (e.g. w1:p2). Get from picode_panes(), spawn_worker return, or worker's last picode_send reply.",
      }),
      lines: Type.Optional(
        Type.Number({
          description: "Number of lines to read from scrollback. Default: 80.",
        }),
      ),
      source: Type.Optional(
        Type.String({
          description:
            "Read source: 'recent-unwrapped' (default, best for logs/transcripts), 'recent' (with soft wraps), 'visible' (current viewport), 'detection' (bottom buffer used by agent detection).",
        }),
      ),
      format: Type.Optional(
        Type.String({
          description:
            "Output format: 'text' (default) or 'ansi' (preserves colors/styling — use when terminal styling is evidence).",
        }),
      ),
    }),
    async execute(_id, params) {
      if (!process.env.HERDR_ENV) {
        return err("HERDR_ENV not set — picode_pane_read only works inside Herdr panes.");
      }

      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      const paneId = (params.pane_id || "").trim();
      if (!paneId) {
        return err(
          "pane_id is required — get it from picode_panes(), spawn_worker return, or worker's picode_send reply.",
        );
      }

      if (!isValidPaneId(paneId)) {
        return err(`Invalid pane_id "${paneId}" — expected Herdr format like w1:p2.`);
      }
      // Safety: never read our own pane — the coordinator's output is not
      // useful to itself and reading it wastes a tool call.
      const currentPaneId = process.env.HERDR_PANE_ID || "";
      if (paneId === currentPaneId) {
        return err(
          `pane_id ${paneId} is this coordinator's own pane — reading it is not useful. Pass a worker pane ID instead.`,
        );
      }

      const lines = params.lines ?? 80;
      if (lines < 1 || lines > 500) {
        return err(`lines must be between 1 and 500, got ${lines}.`);
      }

      const source = params.source ?? "recent-unwrapped";
      if (!VALID_SOURCES.has(source)) {
        return err(`source must be one of: ${[...VALID_SOURCES].join(", ")}. Got: ${source}.`);
      }

      const format = params.format ?? "text";
      if (format !== "text" && format !== "ansi") {
        return err(`format must be 'text' or 'ansi'. Got: ${format}.`);
      }

      if (!workspaceId) {
        return err("HERDR_WORKSPACE_ID not set — picode_pane_read requires a current workspace.");
      }
      if (!belongsToWorkspace(paneId, workspaceId)) {
        return err(
          `pane_id ${paneId} is outside current Herdr workspace ${workspaceId}. Use an exact pane ID from picode_panes().`,
        );
      }

      try {
        const raw = herdr(
          `pane read ${paneId} --source ${source} --lines ${lines} --format ${format}`,
        );

        // herdr pane read returns plain text (not JSON) for text/ansi format.
        // Return it directly — the model needs the raw terminal output.
        return {
          content: [
            {
              type: "text" as const,
              text: raw || `(no output from pane ${paneId})`,
            },
          ],
          details: {
            ok: true,
            pane_id: paneId,
            lines,
            source,
            format,
            bytes: raw.length,
          },
        };
      } catch (e) {
        const msg = String(e);
        if (msg.includes("not found") || msg.includes("no such")) {
          return err(
            `Pane ${paneId} not found — it may have been closed. Run picode_panes() to see current panes.`,
          );
        }
        return err(`picode_pane_read failed: ${msg}`);
      }
    },
    renderCall: quietCallRenderer("picode_pane_read"),
    renderResult: quietToolResult,
  });
}
