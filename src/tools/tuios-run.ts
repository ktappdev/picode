import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TuiosRuntime } from "../runtime/tuios";
import { err, shellQuote } from "./shared";

/** Run a command in a disposable TUIOS window without requiring shell marks.
 * The command itself is user-provided shell code (as with the Herdr tool); its
 * argv boundary and completion marker are never interpolated into that code. */
export function registerTuiosRunTool(pi: ExtensionAPI, runtime: TuiosRuntime) {
  pi.registerTool({
    name: "picode_run",
    label: "Run Command",
    description:
      "Run a shell command in a disposable TUIOS window. Blocking by default; leave timed-out windows open for inspection.",
    promptSnippet: "Run a shell command in a disposable pane (build, test, typecheck).",
    parameters: Type.Object({
      command: Type.String(),
      wait: Type.Optional(Type.Boolean()),
      timeout_ms: Type.Optional(Type.Integer()),
      close_on_done: Type.Optional(Type.Boolean()),
      focus: Type.Optional(Type.Boolean()),
      cwd: Type.Optional(Type.String()),
      tail_lines: Type.Optional(Type.Integer()),
    }),
    async execute(_id, params) {
      if (!params.command?.trim()) return err("command is required and must not be empty");
      const timeout = params.timeout_ms ?? 60_000;
      const lines = params.tail_lines ?? 50;
      if (
        !Number.isInteger(timeout) ||
        timeout < 1 ||
        timeout > 600_000 ||
        !Number.isInteger(lines) ||
        lines < 1 ||
        lines > 500
      ) {
        return err("timeout_ms must be 1..600000 and tail_lines must be 1..500");
      }
      const cwd = params.cwd || process.cwd();
      const dir = mkdtempSync(join(tmpdir(), "picode-run-"));
      const script = join(dir, "run.sh");
      const marker = `PICODE_RUN_DONE_${randomUUID().replace(/-/g, "")}`;
      writeFileSync(
        script,
        `#!/bin/bash\ntrap 'rm -f -- "$0"; rmdir -- "$(dirname "$0")" 2>/dev/null' EXIT\ncd ${shellQuote(cwd)} || exit 1\n(\n${params.command}\n)\nstatus=$?\nprintf '\\n${marker}_%d\\n' "$status"\n`,
        { mode: 0o700 },
      );
      let paneId: string | null = null;
      try {
        await runtime.refresh();
        const opened = await runtime.call("new-window", {
          name: "picode-run",
          workspace: runtime.tabNumber(runtime.tabId),
          cwd,
          focus: params.focus === true,
        });
        if (typeof opened.window_id !== "string")
          throw new Error("TUIOS new-window returned no ID");
        paneId = opened.window_id;
        await runtime.refresh();
        runtime.pane(paneId);
        await runtime.call("send-text", {
          window: paneId,
          text: `bash ${JSON.stringify(script)}\r`,
        });
        if (params.wait === false) {
          const result = {
            ok: true,
            pane_id: paneId,
            status: "running",
            command: params.command,
            cwd,
            focused: params.focus === true,
            message: `Check output with picode_pane_read(pane_id=${paneId}).`,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        }
        let timedOut = false;
        try {
          await runtime.call(
            "wait-for",
            { condition: "window-output", window: paneId, pattern: `${marker}_[0-9]+`, timeout },
            timeout + 5_000,
          );
        } catch (error) {
          if (!String(error).includes("timeout")) throw error;
          timedOut = true;
        }
        const captured = await runtime.call("capture-pane", {
          window: paneId,
          source: "recent",
          lines: Math.min(lines + 30, 500),
        });
        const text = typeof captured.content === "string" ? captured.content : "";
        const match = text.match(new RegExp(`${marker}_(\\d+)`));
        const output = text
          .split("\n")
          .filter(line => !line.includes(marker) && !line.includes(script))
          .slice(-lines)
          .join("\n")
          .trim();
        let closed = false;
        if (!timedOut && params.close_on_done !== false) {
          await runtime.close(paneId);
          closed = true;
        }
        const result = {
          ok: !timedOut,
          pane_id: paneId,
          command: params.command,
          cwd,
          output,
          exit_code: match ? Number(match[1]) : null,
          ...(timedOut ? { timed_out: true } : {}),
          closed,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      } catch (error) {
        return err(
          `picode_run failed${paneId ? ` (window ${paneId} left open)` : ""}: ${String(error)}`,
        );
      } finally {
        // Non-blocking commands still need their script until completion;
        // an asynchronous job cleans up its own file after it exits.
        if (params.wait !== false) rmSync(dir, { recursive: true, force: true });
      }
    },
  });
}
