import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { err } from "./shared";

/**
 * picode_run — run a shell command in a disposable herdr pane.
 *
 * Two modes:
 *  - Blocking (wait=true, default): blocks until command exits, returns output + exit code.
 *    Pane auto-closed unless close_on_done=false.
 *  - Non-blocking (wait=false): returns pane_id immediately. User or coordinator can
 *    watch the pane. Check output later via `herdr pane read <pane_id>`.
 *
 * Completion detection: command is wrapped in a temp script that prints a unique
 * sentinel + exit code on completion. `herdr wait output --match <sentinel>` blocks
 * until the sentinel appears. The script filename contains no sentinel, so the
 * sentinel only appears in output — not in the echoed command line.
 */

/** Default timeout for blocking mode (60s). */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Max lines of output to return in blocking mode. */
const DEFAULT_TAIL_LINES = 50;
/** execSync hard cap — must exceed the herdr wait timeout to avoid killing the wait early. */
const EXEC_BUFFER_MS = 5_000;

function herdr(args: string, timeoutMs = 15_000): string {
  return execSync(`herdr ${args}`, { encoding: "utf-8", timeout: timeoutMs });
}

function herdrJson(args: string, timeoutMs = 15_000): Record<string, unknown> {
  const raw = herdr(args, timeoutMs);
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    console.error(`[picode_run] herdr JSON parse failed for: ${args} — ${String(e)}`);
    return {};
  }
}

/** Generate a unique sentinel that won't collide with command echo or other runs. */
function makeSentinel(): string {
  return `PICODE_RUN_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Write the wrapped command to a temp script file. Returns script path.
 *  IMPORTANT: script filename must NOT contain the sentinel — otherwise
 *  `herdr wait output --match <sentinel>` matches the echoed command line
 *  (`bash /tmp/picode_run_<sentinel>.sh`) before the actual sentinel output. */
function writeCommandScript(command: string, cwd: string, sentinel: string): string {
  // Filename uses a separate random suffix — no sentinel.
  const suffix = Math.random().toString(36).slice(2, 10);
  const scriptPath = join("/tmp", `picode_run_${suffix}.sh`);
  // Script: cd to cwd, run command, capture exit, print sentinel + exit code.
  // The sentinel only appears in script output — never in the `bash <script>` command echo.
  const script = `#!/bin/bash
trap 'rm -f -- "$0"' EXIT
cd ${JSON.stringify(cwd)} 2>/dev/null || cd /tmp
${command}
__EXIT_CODE=$?
printf '\\n${sentinel}_%d\\n' "$__EXIT_CODE"
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

/** Parse exit code from the matched sentinel line. */
function parseExitCode(matchedLine: string, sentinel: string): number | null {
  // matchedLine looks like: "PICODE_RUN_DONE_1234_abc_0"
  const suffix = matchedLine.replace(sentinel, "").trim();
  const match = suffix.match(/^_?(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** Extract text output from a wait output response's read field, trimmed to tail_lines.
 *  The read.text includes command echo, shell prompts, and the sentinel line —
 *  we strip those for clean output. */
function extractOutputFromWait(
  waitResult: Record<string, unknown>,
  sentinel: string,
  tailLines: number,
): string {
  const read = (waitResult.result as Record<string, unknown> | undefined)?.read as
    Record<string, unknown> | undefined;
  const text = (read?.text as string) || "";
  return cleanOutput(text, sentinel, tailLines);
}

/** Clean pane output: remove sentinel line, strip shell prompt/command echo lines, trim to tail_lines.
 *  Pane output includes shell prompt lines like "picode on  main [!?] is 📦 v0.5.19" and
 *  "❯ bash /tmp/picode_run_*.sh" — we strip those for clean command output. */
function cleanOutput(text: string, sentinel: string, tailLines: number): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip the sentinel output line
    if (trimmed.startsWith(sentinel)) continue;
    // Skip the command echo line (❯ bash /tmp/picode_run_*.sh)
    if (/^❯\s*bash \/tmp\/picode_run_.*\.sh/.test(trimmed)) continue;
    // Skip bare command echo without prompt (bash /tmp/picode_run_*.sh)
    if (/^bash \/tmp\/picode_run_.*\.sh/.test(trimmed)) continue;
    // Skip shell prompt lines — lines containing ❯ or looking like a prompt
    // (e.g. "picode on  main [!?] is 📦 v0.5.19 via 🐍 v3.14.6")
    if (trimmed.includes("❯")) continue;
    // Skip lines that look like shell prompt status (directory + git + version info)
    if (/^\w+\s+on\s+.*is\s+📦/.test(trimmed)) continue;
    cleaned.push(line);
  }
  // Trim to last tailLines and remove leading/trailing blank lines
  const tail = cleaned.slice(-tailLines).join("\n").trim();
  return tail;
}

export function registerRunTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "picode_run",
    label: "Run Command",
    description:
      "Run a shell command in a disposable terminal pane. Blocking mode (default): waits for completion, returns output + exit code, auto-closes pane. Non-blocking mode (wait=false): returns pane_id immediately for user/coordinator to watch. Use for builds, tests, type checks, scripts — anything that doesn't need a full worker agent.",
    promptSnippet:
      "Run a shell command in a disposable pane (build, test, typecheck). Returns output + exit code.",
    parameters: Type.Object({
      command: Type.String({
        description: "Shell command to run (e.g. 'npm run build', 'npx tsc --noEmit', 'npm test').",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description:
            "If true (default), block until command exits and return output + exit code. If false, return pane_id immediately — user or coordinator watches the pane.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Integer({
          description:
            "Max milliseconds to wait in blocking mode. Default 60000 (60s). On timeout, returns partial output and leaves pane open.",
        }),
      ),
      close_on_done: Type.Optional(
        Type.Boolean({
          description:
            "If true (default in blocking mode), close the pane after command exits. Set false to keep pane open for inspection. Ignored in non-blocking mode (pane always stays open).",
        }),
      ),
      focus: Type.Optional(
        Type.Boolean({
          description:
            "If true, bring the pane to foreground (for user to watch). Default false — pane runs in background.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory for the command. Default: current project root (git rev-parse --show-toplevel).",
        }),
      ),
      tail_lines: Type.Optional(
        Type.Integer({
          description:
            "Number of output lines to return in blocking mode (from the end). Default 50.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const paneId = process.env.HERDR_PANE_ID;
      const workspaceId = process.env.HERDR_WORKSPACE_ID;

      if (!paneId || !workspaceId) {
        return err(
          "HERDR_PANE_ID / HERDR_WORKSPACE_ID not set — picode_run only works inside Herdr panes.",
        );
      }

      if (!params.command || !params.command.trim()) {
        return err("command is required and must not be empty");
      }

      const wait = params.wait !== false; // default true
      const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const closeOnDone = wait ? params.close_on_done !== false : false; // default true in blocking, always false in non-blocking
      const focus = params.focus === true;
      const tailLines = params.tail_lines ?? DEFAULT_TAIL_LINES;

      // Resolve cwd — default to project root
      let cwd = params.cwd;
      if (!cwd) {
        try {
          cwd = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
        } catch {
          cwd = process.cwd();
        }
      }

      const sentinel = makeSentinel();
      let scriptPath = "";

      try {
        // 1. Write command to temp script (keeps sentinel out of command echo)
        scriptPath = writeCommandScript(params.command, cwd, sentinel);

        // 2. Split pane — no focus unless requested
        const splitArgs = `pane split ${paneId} --direction down --no-focus --cwd ${JSON.stringify(cwd)}`;
        let splitResult: Record<string, unknown>;
        try {
          splitResult = herdrJson(splitArgs);
        } catch (e) {
          return err(`herdr pane split failed: ${String(e)}`);
        }
        const splitPane = (splitResult.result as Record<string, unknown> | undefined)?.pane as
          Record<string, unknown> | undefined;
        const newPaneId = splitPane?.pane_id as string;
        if (!newPaneId) {
          return err(
            `herdr pane split succeeded but no pane_id in response: ${JSON.stringify(splitResult)}`,
          );
        }

        // 3. Focus if requested (after split so the new pane is focused)
        if (focus) {
          try {
            herdr(`pane zoom ${newPaneId} --on`);
          } catch {
            // Non-fatal — focus is a convenience
          }
        }

        // 4. Run the script in the new pane
        try {
          herdr(`pane run ${newPaneId} ${JSON.stringify(`bash ${scriptPath}`)}`);
        } catch (e) {
          // Clean up the pane we created
          try {
            herdr(`pane close ${newPaneId}`);
          } catch {
            // Ignore
          }
          return err(`herdr pane run failed: ${String(e)}`);
        }

        // 5. Non-blocking mode — return immediately
        if (!wait) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  pane_id: newPaneId,
                  status: "running",
                  command: params.command,
                  cwd,
                  message: `Command running in pane ${newPaneId}. ${
                    focus ? "Pane is focused for user to watch." : "Pane is in background."
                  } Check output with: herdr pane read ${newPaneId} --lines ${tailLines}`,
                }),
              },
            ],
            details: {
              ok: true,
              pane_id: newPaneId,
              status: "running",
              command: params.command,
              cwd,
              focused: focus,
            },
          };
        }

        // 6. Blocking mode — wait for sentinel
        const waitTimeout = timeoutMs;
        const execTimeout = waitTimeout + EXEC_BUFFER_MS;
        let waitResult: Record<string, unknown>;
        let timedOut = false;
        try {
          waitResult = herdrJson(
            `wait output ${newPaneId} --match ${sentinel} --timeout ${waitTimeout} --lines ${tailLines + 20}`,
            execTimeout,
          );
        } catch (e) {
          // execSync throws on timeout — check if it was the herdr wait timeout or exec crash
          const msg = String(e);
          if (msg.includes("timed out") || msg.includes("ETIMEDOUT")) {
            timedOut = true;
            waitResult = { error: { message: "timed out waiting for output match" } };
          } else {
            // Unexpected error — try to clean up
            try {
              herdr(`pane close ${newPaneId}`);
            } catch {
              // Ignore
            }
            return err(`herdr wait output failed: ${msg}`);
          }
        }

        // 7. Extract output from wait response (read.text field) + fallback to pane read
        let output = "";
        if (!timedOut) {
          output = extractOutputFromWait(waitResult, sentinel, tailLines);
        }
        // Fallback: if output empty, try pane read (returns plain text, not JSON)
        if (!output) {
          try {
            const raw = herdr(
              `pane read ${newPaneId} --source recent-unwrapped --lines ${tailLines + 20}`,
            );
            output = cleanOutput(raw, sentinel, tailLines);
          } catch {
            // Non-fatal — return what we have
          }
        }

        // 8. Parse exit code (if not timed out)
        let exitCode: number | null = null;
        if (!timedOut) {
          const matchedLine = (waitResult.result as Record<string, unknown> | undefined)
            ?.matched_line;
          if (typeof matchedLine === "string") {
            exitCode = parseExitCode(matchedLine, sentinel);
          }
        }

        // 9. Close pane if requested (and not timed out — leave open on timeout for inspection)
        let closed = false;
        if (closeOnDone && !timedOut) {
          try {
            herdr(`pane close ${newPaneId}`);
            closed = true;
          } catch {
            // Non-fatal — pane may already be closed
            closed = true;
          }
        }

        // 10. Build result
        if (timedOut) {
          const result = {
            ok: false,
            timed_out: true,
            pane_id: newPaneId,
            command: params.command,
            cwd,
            output,
            message: `Command timed out after ${timeoutMs}ms. Pane ${newPaneId} left open. Check output with: herdr pane read ${newPaneId}`,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result),
              },
            ],
            details: result,
          };
        }

        const result = {
          ok: true,
          pane_id: newPaneId,
          command: params.command,
          cwd,
          exit_code: exitCode,
          output,
          closed,
          duration_ms: null as number | null, // not tracked — herdr wait doesn't report duration
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
          details: result,
        };
      } finally {
        // Clean up temp script
        // Non-blocking scripts clean themselves via the EXIT trap after the
        // shell opens them. Deleting here would race pane run startup.
        if (wait && scriptPath && existsSync(scriptPath)) {
          try {
            unlinkSync(scriptPath);
          } catch {
            // Ignore — temp file, OS will clean up
          }
        }
      }
    },
  });
}
