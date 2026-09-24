import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHandoff, writeHandoff, type HandoffNote } from "../src/core/handoff";
import {
  clearAreaCache,
  clearHeadCache,
  deriveArea,
  formatWorkerDigest,
  headMovedSince,
  recentWorkers,
  type LedgerRow,
} from "../src/core/worker-ledger";
import { threadModelPrompt } from "../src/core/system-prompt";
import type { PicodeData, PicodeStore, OwedReply, StateFile } from "../src/core/types";
import type { Inbox } from "../src/inbox";
import { registerFinishTool } from "../src/tools/finish";
import { registerReviveTool } from "../src/tools/revive";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  clearAreaCache();
  clearHeadCache();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "picode-revive-"));
  dirs.push(dir);
  return dir;
}

/** Minimal PicodeData for prompt-assembly assertions. */
function picodeData(role: string): PicodeData {
  return {
    picodeId: role,
    picodeDir: "/tmp/does-not-matter",
    picodesRootDir: "/tmp/does-not-matter",
    parent: null,
    role,
    sessionFile: null,
    startedAt: "2026-01-01T00:00:00.000Z",
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
  };
}

/** Write a session JSONL whose assistant tool calls name the given paths. */
function writeSession(dir: string, paths: string[]): string {
  const file = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd: dir }),
    ...paths.map(p =>
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: p } }],
        },
      }),
    ),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function writeState(cwd: string, id: string, overrides: Record<string, unknown> = {}): void {
  const dir = join(cwd, ".picode", "picodes", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      id,
      pid: 999_999_999,
      cwd,
      parent: "coordinator",
      role: "builder",
      sessionFile: null,
      state: "stopped",
      status: "stopped",
      lastSeen: new Date(Date.now() - 3_600_000).toISOString(),
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
      startedAt: new Date(Date.now() - 7_200_000).toISOString(),
      obligations: [],
      owed: [],
      barriers: [],
      ...overrides,
    }),
  );
}

describe("handoff notes", () => {
  it("round-trips a note and treats corruption as absent", () => {
    const dir = tempDir();
    const note: HandoffNote = {
      id: "builder-1",
      role: "builder",
      outcome: "completed",
      changed: "webhook terminal release is atomic",
      leftUnverified: "redis outage path",
      at: "2026-09-16T14:40:16.511Z",
    };
    writeHandoff(dir, note);
    assert.deepStrictEqual(readHandoff(dir), note);

    // A payload missing required fields is not a note.
    writeFileSync(join(dir, "handoff.json"), JSON.stringify({ id: "builder-1" }));
    assert.strictEqual(readHandoff(dir), null);

    writeFileSync(join(dir, "handoff.json"), "not json");
    assert.strictEqual(readHandoff(dir), null);

    rmSync(join(dir, "handoff.json"));
    assert.strictEqual(readHandoff(dir), null);
  });
});

describe("worker ledger: area derivation", () => {
  it("ranks the directories a worker touched, ignoring noise", () => {
    const cwd = tempDir();
    const session = writeSession(cwd, [
      "src/core/handoff.ts",
      "src/core/worker-ledger.ts",
      "src/tools/finish.ts",
      "test/revive.test.ts",
      "/etc/passwd", // outside the workspace — not this worker's territory
    ]);
    assert.deepStrictEqual(deriveArea(session, cwd), ["src/core", "src/tools", "test"]);
  });

  it("reads file_path as well as path, and survives a malformed line", () => {
    const cwd = tempDir();
    const file = join(cwd, "s.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session" }),
        "not json at all",
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "edit", arguments: { file_path: "src/inbox.ts" } }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "toolResult", toolName: "read", content: [] },
        }),
      ].join("\n"),
    );
    assert.deepStrictEqual(deriveArea(file, cwd), ["src"]);
  });

  it("returns nothing for a missing session rather than throwing", () => {
    assert.deepStrictEqual(deriveArea(join(tempDir(), "absent.jsonl"), tempDir()), []);
  });
});

describe("worker ledger: freshness", () => {
  it("reports whether a commit landed after the worker last ran", () => {
    const cwd = tempDir();
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "landed"], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-09-16T12:00:00Z",
        GIT_COMMITTER_DATE: "2026-09-16T12:00:00Z",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    clearHeadCache();

    // Worker stopped an hour before the commit → the tree moved.
    assert.strictEqual(headMovedSince(cwd, "2026-09-16T11:00:00Z"), true);
    // Worker stopped an hour after the commit → its view still holds.
    assert.strictEqual(headMovedSince(cwd, "2026-09-16T13:00:00Z"), false);
  });

  it("reports unknown when git cannot answer", () => {
    assert.strictEqual(headMovedSince(tempDir(), "2026-09-16T12:00:00Z"), null);
  });
});

describe("worker ledger: rows", () => {
  it("lists recent workers newest first, excluding the coordinator", () => {
    const cwd = tempDir();
    const now = Date.now();
    writeState(cwd, "builder", { lastSeen: new Date(now - 7_200_000).toISOString() });
    writeState(cwd, "reviewer", { lastSeen: new Date(now - 600_000).toISOString() });
    writeState(cwd, "coordinator", { role: "coordinator" });

    const rows = recentWorkers(cwd);
    assert.deepStrictEqual(
      rows.map(r => r.id),
      ["reviewer", "builder"],
    );
  });

  it("treats a stale-heartbeat process as stopped even when status says running", () => {
    const cwd = tempDir();
    // Killed pane: state.json still claims running, heartbeat is old, PID is gone.
    writeState(cwd, "builder", {
      status: "running",
      state: "working",
      lastSeen: new Date(Date.now() - 600_000).toISOString(),
    });
    const [row] = recentWorkers(cwd);
    assert.strictEqual(row?.live, false);
    assert.strictEqual(row?.lastState, "working");
  });

  it("marks a fresh, live process as reachable", () => {
    const cwd = tempDir();
    writeState(cwd, "builder", {
      status: "running",
      state: "idle",
      pid: process.pid,
      lastSeen: new Date().toISOString(),
    });
    const [row] = recentWorkers(cwd);
    assert.strictEqual(row?.live, true);
  });

  it("carries the worker's own handoff and derived area", () => {
    const cwd = tempDir();
    const session = writeSession(cwd, ["src/adapter/local-fs.ts"]);
    writeState(cwd, "builder", { sessionFile: session });
    writeHandoff(join(cwd, ".picode", "picodes", "builder"), {
      id: "builder",
      role: "builder",
      outcome: "blocked",
      changed: "partial",
      leftUnverified: "redis outage path",
      at: "2026-09-16T14:40:16.511Z",
    });

    const [row] = recentWorkers(cwd);
    assert.deepStrictEqual(row?.area, ["src/adapter"]);
    assert.strictEqual(row?.handoff?.leftUnverified, "redis outage path");
  });

  it("keeps a killed worker's row even though it wrote no handoff", () => {
    const cwd = tempDir();
    writeState(cwd, "scout");
    const [row] = recentWorkers(cwd);
    assert.strictEqual(row?.id, "scout");
    assert.strictEqual(row?.handoff, null);
  });
});

describe("worker ledger: digest", () => {
  function row(overrides: Partial<LedgerRow>): LedgerRow {
    return {
      id: "builder",
      role: "builder",
      live: false,
      area: ["src/core"],
      lastState: "stopped",
      closedAt: new Date().toISOString(),
      contextAgeMinutes: 42,
      headMovedSinceExit: false,
      handoff: null,
      ...overrides,
    };
  }

  it("renders nothing when there are no rows", () => {
    assert.strictEqual(formatWorkerDigest([]), "");
  });

  it("distinguishes live from stopped and surfaces the stale-context warning", () => {
    const digest = formatWorkerDigest([
      row({ id: "reviewer", live: true, contextAgeMinutes: 0 }),
      row({ id: "builder", headMovedSinceExit: true }),
    ]);
    assert.match(digest, /▶ reviewer/);
    assert.match(digest, /· builder/);
    assert.match(digest, /stopped <1h/);
    assert.match(digest, /HEAD moved since/);
    // The warning must not appear for the live worker.
    assert.doesNotMatch(digest.split("\n").find(l => l.includes("reviewer")) ?? "", /HEAD moved/);
  });

  const ageBuckets = [
    [0, "<1m"],
    [1, "<5m"],
    [5, "<15m"],
    [15, "<1h"],
    [60, "<6h"],
    [360, "<1d"],
    [1440, "1d+"],
  ] as const;

  for (const [minutes, label] of ageBuckets) {
    it(`uses the ${label} age bucket at ${minutes} minutes`, () => {
      const digest = formatWorkerDigest([row({ contextAgeMinutes: minutes })]);
      assert.ok(digest.includes(`stopped ${label}`));
    });
  }

  it("keeps the digest stable across one-minute snapshots with no other changes", () => {
    const atSixMinutes = formatWorkerDigest([row({ contextAgeMinutes: 6 })]);
    const oneMinuteLater = formatWorkerDigest([row({ contextAgeMinutes: 7 })]);
    assert.strictEqual(oneMinuteLater, atSixMinutes);
  });

  it("includes what the worker left unverified", () => {
    const digest = formatWorkerDigest([
      row({
        handoff: {
          id: "builder",
          role: "builder",
          outcome: "completed",
          changed: "x",
          leftUnverified: "redis outage path",
          at: "2026-09-16T14:40:16.511Z",
        },
      }),
    ]);
    assert.match(digest, /left unverified: redis outage path/);
  });
});

describe("worker ledger: prompt wiring", () => {
  const digest =
    "### Recent workers (▶ live, · stopped)\n\n- · builder (builder) — src/test-only-area";

  it("appends the roster digest to a coordinator prompt only when supplied", () => {
    const withRoster = threadModelPrompt(picodeData("coordinator"), { workers: digest });
    assert.match(withRoster, /src\/test-only-area/);
    assert.doesNotMatch(threadModelPrompt(picodeData("coordinator")), /src\/test-only-area/);
    // A worker never receives a roster.
    assert.doesNotMatch(threadModelPrompt(picodeData("builder"), {}), /src\/test-only-area/);
  });

  it("tells a revived worker its context predates the gap", () => {
    const prompt = threadModelPrompt(picodeData("builder"), {
      revived: { since: new Date(Date.now() - 7_200_000).toISOString() },
    });
    assert.match(prompt, /You were revived/);
    assert.match(prompt, /2 hours ago/);
    assert.match(prompt, /current fact/);
  });

  it("keeps a Round Table consultation free of both blocks", () => {
    const prompt = threadModelPrompt(picodeData("builder"), {
      roundTable: true,
      workers: digest,
      revived: { since: new Date().toISOString() },
    });
    assert.doesNotMatch(prompt, /src\/test-only-area/);
    assert.doesNotMatch(prompt, /You were revived/);
  });
});

describe("picode_finish", () => {
  interface Sent {
    to: string;
    body: string;
    opts: { re?: string } | undefined;
  }

  function finishHarness(opts: { role?: string; owed?: OwedReply[]; failSend?: boolean }) {
    const tools = new Map<
      string,
      { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
    >();
    const sent: Sent[] = [];
    const dir = tempDir();

    const pi = {
      registerTool: (tool: { name: string; execute: unknown }) => {
        tools.set(
          tool.name,
          tool as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> },
        );
      },
    } as never;

    const store = {
      picodeId: "builder-1",
      picodeDir: dir,
      role: opts.role ?? "builder",
      parent: "coordinator",
      owed: opts.owed ?? [],
    } as unknown as PicodeStore;

    const inbox = {
      sendEnvelope: async (to: string, body: string, sendOpts?: { re?: string }) => {
        if (opts.failSend) throw new Error("mailbox unavailable");
        sent.push({ to, body, opts: sendOpts });
        return { id: "builder-1/01ABC" };
      },
    } as unknown as Inbox;

    registerFinishTool(pi, store, inbox);
    return { tools, sent, dir };
  }

  const owed = (id: string): OwedReply => ({
    id,
    from: "coordinator",
    summary: "do the thing",
    receivedAt: "2026-09-16T12:00:00.000Z",
  });

  /** Success returns a JSON payload with `details.ok`; a refusal returns
   *  `err()` — plain text with `details.ok === false`. Read `details`, not
   *  the prose, so the assertion doesn't depend on error wording. */
  function result(out: unknown): { ok?: boolean; re?: string | null; warnings?: string[] } {
    const o = out as { content: { text: string }[]; details?: { ok?: boolean } };
    const text = o.content[0].text;
    try {
      return { ...(JSON.parse(text) as object), ok: o.details?.ok };
    } catch {
      return { ok: o.details?.ok };
    }
  }

  it("records the handoff and closes the single outstanding request", async () => {
    const { tools, sent, dir } = finishHarness({ owed: [owed("coordinator/01REQ")] });
    const out = await tools.get("picode_finish")!.execute("t", {
      outcome: "completed",
      changed: "webhook release is atomic",
      leftUnverified: "redis outage path",
    });

    assert.deepStrictEqual(readHandoff(dir), {
      id: "builder-1",
      role: "builder",
      outcome: "completed",
      changed: "webhook release is atomic",
      leftUnverified: "redis outage path",
      at: (readHandoff(dir) as HandoffNote).at,
    });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, "coordinator");
    assert.strictEqual(sent[0].opts?.re, "coordinator/01REQ");
    assert.match(sent[0].body, /left unverified: redis outage path/);
    assert.strictEqual(result(out).ok, true);
  });

  it("keeps the note when the report cannot be sent", async () => {
    const { tools, dir } = finishHarness({ failSend: true });
    const out = await tools.get("picode_finish")!.execute("t", {
      outcome: "abandoned",
      changed: "nothing",
      leftUnverified: "everything",
    });
    assert.strictEqual(result(out).ok, false);
    assert.strictEqual(readHandoff(dir)?.outcome, "abandoned");
  });

  it("refuses to guess which debt a finish closes when several are owed", async () => {
    const { tools, sent } = finishHarness({ owed: [owed("c/01A"), owed("c/01B")] });
    const out = await tools.get("picode_finish")!.execute("t", {
      outcome: "completed",
      changed: "x",
      leftUnverified: "nothing",
    });
    assert.strictEqual(sent[0].opts?.re, undefined);
    assert.strictEqual(result(out).re, null);
    assert.match(result(out).warnings?.[0] ?? "", /2 owed replies/);
  });

  it("lets the worker write its own report", async () => {
    const { tools, sent } = finishHarness({});
    await tools.get("picode_finish")!.execute("t", {
      outcome: "blocked",
      changed: "half of it",
      leftUnverified: "the rest",
      report: "Blocked on the staging API key.",
    });
    assert.strictEqual(sent[0].body, "Blocked on the staging API key.");
  });

  it("is worker-only", async () => {
    const { tools, sent } = finishHarness({ role: "coordinator" });
    const out = await tools.get("picode_finish")!.execute("t", {
      outcome: "completed",
      changed: "x",
      leftUnverified: "nothing",
    });
    assert.strictEqual(result(out).ok, false);
    assert.strictEqual(sent.length, 0);
  });
});

describe("revive_closed_session guards", () => {
  interface ToolResult {
    ok?: boolean;
    dry_run?: boolean;
    context_age_minutes?: number;
    warnings?: string[];
    text: string;
  }

  /** Every refusal here happens before any Herdr call, so a `details.ok`
   *  true can only mean the tool never reached the pane logic — which is
   *  itself the assertion that dry_run and the guards terminate early. */
  function outcome(out: unknown): ToolResult {
    const o = out as { content: { text: string }[]; details?: { ok?: boolean } };
    const text = o.content[0].text;
    try {
      return { text, ...(JSON.parse(text) as object), ok: o.details?.ok };
    } catch {
      return { text, ok: o.details?.ok };
    }
  }

  function stateFile(cwd: string, overrides: Partial<StateFile> = {}): StateFile {
    return {
      id: "builder-1",
      pid: 999_999_999,
      cwd,
      parent: "coordinator",
      role: "builder",
      sessionFile: join(cwd, "session.jsonl"),
      state: "done",
      status: "stopped",
      holdReason: null,
      obligations: [],
      owed: [],
      barriers: [],
      startedAt: "2026-09-16T10:00:00.000Z",
      lastSeen: new Date(Date.now() - 5_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 5_400_000).toISOString(),
      ...overrides,
    };
  }

  function reviveHarness(opts: {
    coordinator?: boolean;
    state?: StateFile | null;
    running?: boolean;
    queued?: number;
    withSession?: boolean;
  }) {
    const tools = new Map<
      string,
      { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
    >();
    const root = tempDir();
    const sessionDir = tempDir();
    // The workspace must match process.cwd() — a resumed session's relative
    // paths resolve from there, so a mismatch is a refusal, not a warning.
    const state =
      opts.state === undefined
        ? stateFile(process.cwd(), { sessionFile: join(sessionDir, "session.jsonl") })
        : opts.state;
    if (opts.withSession !== false && state?.sessionFile) {
      writeFileSync(state.sessionFile, '{"type":"session"}\n');
    }

    const pi = {
      registerTool: (tool: { name: string; execute: unknown }) => {
        tools.set(
          tool.name,
          tool as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> },
        );
      },
    } as never;

    const store = {
      role: opts.coordinator === false ? "builder" : "coordinator",
      picodesRootDir: root,
      adapter: {
        loadPicodeState: async () => state ?? undefined,
        countQueued: async () => opts.queued ?? 0,
      },
      listPcodes: async () =>
        opts.running
          ? [
              {
                id: "builder-1",
                pid: process.pid,
                status: "running",
                role: "builder",
                state: "idle",
              },
            ]
          : [],
    } as unknown as PicodeStore;

    const inbox = {
      sendEnvelope: async () => ({ id: "coordinator/01TASK" }),
    } as unknown as Inbox;

    registerReviveTool(pi, store, inbox);
    return { tools, root, sessionDir };
  }

  function revive(
    h: ReturnType<typeof reviveHarness>,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return h.tools.get("revive_closed_session")!.execute("t", params);
  }

  it("is coordinator-only", async () => {
    const h = reviveHarness({ coordinator: false });
    const res = outcome(await revive(h, { picode_id: "builder-1", task: "x" }));
    assert.strictEqual(res.ok, false);
    assert.match(res.text, /coordinator-only/);
  });

  it("rejects ids that could reach a shell or a path join", async () => {
    const h = reviveHarness({});
    for (const bad of ["../escape", "a b", "", "x;rm -rf /", "a".repeat(65)]) {
      const res = outcome(await revive(h, { picode_id: bad, task: "x" }));
      assert.strictEqual(res.ok, false, `should have refused ${JSON.stringify(bad)}`);
    }
  });

  it("refuses the coordinator as a target", async () => {
    const h = reviveHarness({});
    const res = outcome(await revive(h, { picode_id: "coordinator", task: "x" }));
    assert.strictEqual(res.ok, false);
  });

  it("refuses a picode that was never here", async () => {
    const h = reviveHarness({ state: null });
    const res = outcome(await revive(h, { picode_id: "builder-1", task: "x" }));
    assert.strictEqual(res.ok, false);
    assert.match(res.text, /No picode/);
  });

  it("refuses a session that no longer exists on disk", async () => {
    const h = reviveHarness({ withSession: false });
    const res = outcome(await revive(h, { picode_id: "builder-1", task: "x" }));
    assert.strictEqual(res.ok, false);
    assert.match(res.text, /no longer exists/);
  });

  it("refuses to resume a session a live process holds", async () => {
    const h = reviveHarness({ running: true });
    const res = outcome(await revive(h, { picode_id: "builder-1", task: "x" }));
    assert.strictEqual(res.ok, false);
    assert.match(res.text, /already running/);
  });

  it("refuses a picode that was last running somewhere else", async () => {
    const h = reviveHarness({
      state: stateFile("/definitely/another/workspace", {
        sessionFile: join(tempDir(), "session.jsonl"),
      }),
    });
    const res = outcome(await revive(h, { picode_id: "builder-1", task: "x" }));
    assert.strictEqual(res.ok, false);
    assert.match(res.text, /not this workspace/);
  });

  it("refuses a revival with no task and no queued mail", async () => {
    const h = reviveHarness({ queued: 0 });
    const res = outcome(await revive(h, { picode_id: "builder-1" }));
    assert.strictEqual(res.ok, false);
    assert.match(res.text, /needs a task/);
  });

  it("dry_run reports the risk picture without opening a pane", async () => {
    const h = reviveHarness({ queued: 0 });
    // An abandoned handoff must surface on its own — it is the strongest
    // signal that reviving this worker again is a mistake.
    writeHandoff(join(h.root, "builder-1"), {
      id: "builder-1",
      role: "builder",
      outcome: "abandoned",
      changed: "nothing",
      leftUnverified: "the redis outage path",
      at: "2026-09-16T10:00:00.000Z",
    });

    const res = outcome(await revive(h, { picode_id: "builder-1", dry_run: true }));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.dry_run, true);
    assert.strictEqual(typeof res.context_age_minutes, "number");
    assert.match(res.warnings?.join(" ") ?? "", /abandoned its task/);
    assert.match(res.warnings?.join(" ") ?? "", /redis outage path/);
  });
});
