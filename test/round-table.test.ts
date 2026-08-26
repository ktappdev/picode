import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRecallParticipant, saveRecallParticipant } from "../src/core/recall-registry";
import { buildWorkerLaunchCommand } from "../src/tools/spawn";
import { threadModelPrompt } from "../src/core/system-prompt";
import { createPicodeStore } from "../src/state";
import { createInbox } from "../src/inbox";
import { registerRoundTableTools } from "../src/tools/round-table";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "picode-round-table-"));
  dirs.push(dir);
  return dir;
}

describe("Recall Round Table", () => {
  it("atomically stores and loads an exact participant", () => {
    const cwd = tempDir();
    const participant = {
      id: "reviewer-1",
      role: "reviewer",
      sessionFile: "/tmp/reviewer.jsonl",
      cwd,
      updatedAt: "2026-03-01T00:00:00.000Z",
    };
    saveRecallParticipant(cwd, participant);
    assert.deepStrictEqual(loadRecallParticipant(cwd, "reviewer-1"), participant);
    assert.strictEqual(loadRecallParticipant(cwd, "reviewer"), undefined);
  });

  it("treats a corrupt catalog as unavailable", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".picode"));
    writeFileSync(join(cwd, ".picode", "recall-sessions.json"), "not json");
    assert.strictEqual(loadRecallParticipant(cwd, "reviewer-1"), undefined);
  });

  it("builds a resumed consultation with only the reply tool", () => {
    const command = buildWorkerLaunchCommand({
      picodeId: "reviewer-1",
      role: "reviewer",
      model: "test/model",
      theme: null,
      sessionFile: "/tmp/reviewer session.jsonl",
      roundTable: true,
    });
    assert.match(command, /--session '\/tmp\/reviewer session\.jsonl'/);
    assert.match(command, /--picode-round-table --tools picode_round_table_reply/);
    assert.match(command, /--picode-id 'reviewer-1'/);
  });

  it("sends the sole correlated reply and shuts down", async () => {
    const cwd = tempDir();
    const tools: Record<string, { execute: (...args: unknown[]) => Promise<unknown> }> = {};
    const pi = {
      getFlag: (name: string) => name === "picode-round-table",
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
        tools[tool.name] = tool;
      },
    };
    const store = createPicodeStore(pi as never);
    await store.adapter.configure(cwd);
    store.picodeId = "reviewer";
    store.picodesRootDir = join(cwd, ".picode", "picodes");
    store.picodeDir = join(store.picodesRootDir, "reviewer");
    store.role = "reviewer";
    store.owed = [
      {
        id: "coordinator/request",
        from: "coordinator",
        summary: "consult",
        receivedAt: new Date().toISOString(),
      },
    ];
    const inbox = createInbox(store, pi as never);
    registerRoundTableTools(pi as never, store, inbox);

    let shutdown = false;
    await tools.picode_round_table_reply.execute(
      "test",
      { outcome: "pass", body: "" },
      undefined,
      undefined,
      { shutdown: () => (shutdown = true) },
    );

    assert.strictEqual(shutdown, true);
    assert.deepStrictEqual(store.owed, []);
    const messages = await store.adapter.drainInbox("coordinator");
    assert.strictEqual(messages[0]?.re, "coordinator/request");
    assert.strictEqual(messages[0]?.body, "PASS");
  });

  it("uses the bounded consultation prompt instead of a role prompt", () => {
    const prompt = threadModelPrompt(
      {
        picodeId: "builder",
        picodeDir: "",
        picodesRootDir: "",
        parent: "coordinator",
        role: "builder",
        sessionFile: null,
        startedAt: "",
        state: "idle",
        status: "running",
        holdReason: null,
        obligations: [],
        owed: [],
        barriers: [],
        owedNudgePending: false,
        owedSilentStreak: 0,
        lastJournalSignature: null,
        lastJournalAt: 0,
        journalDebt: false,
        promptDrivenTurnSeen: false,
      },
      { roundTable: true },
    );
    assert.match(prompt, /Recall Round Table Consultation/);
    assert.match(prompt, /picode_round_table_reply/);
    assert.doesNotMatch(prompt, /You are sole coordinator/);
  });
});
