import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TuiosRuntime } from "../src/runtime/tuios";
import { registerTuiosRunTool } from "../src/tools/tuios-run";

interface RunResult {
  details: { ok: boolean; exit_code?: number | null; timed_out?: boolean; closed?: boolean };
}

describe("TUIOS picode_run", () => {
  it("reports the exit status even when the user's command exits the shell", async () => {
    let tool: { execute: (...args: unknown[]) => Promise<RunResult> } | undefined;
    let output = "";
    let closed = false;
    const runtime = {
      tabId: "session:t1",
      tabNumber: () => 1,
      refresh: async () => runtime,
      pane: () => ({ id: "worker" }),
      close: async () => {
        closed = true;
      },
      call: async (verb: string, params: Record<string, unknown>) => {
        if (verb === "new-window") return { window_id: "worker" };
        if (verb === "send-text") {
          const script = JSON.parse(String(params.text).slice(5).trim()) as string;
          const run = spawnSync("bash", [script], { encoding: "utf8" });
          output = run.stdout;
          return {};
        }
        if (verb === "wait-for") return { matched: true };
        if (verb === "capture-pane") return { content: output };
        throw new Error(`Unexpected verb ${verb}`);
      },
    } as unknown as TuiosRuntime;
    registerTuiosRunTool(
      { registerTool: candidate => (tool = candidate as typeof tool) } as ExtensionAPI,
      runtime,
    );
    assert.ok(tool);
    const result = await tool.execute("test", { command: "echo done; exit 3" });
    assert.equal(result.details.exit_code, 3);
    assert.equal(result.details.closed, true);
    assert.equal(closed, true);
  });
});
