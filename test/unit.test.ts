/**
 * Fast, deterministic tests — no subprocess, no model call. Every tool and
 * slash command is reachable directly via a capture harness that stubs
 * `pi.registerTool`/`pi.registerCommand`, so their deterministic logic
 * (targeting, correlation, dedup, error handling) is tested here rather than
 * through a live model call. See TESTING.md before adding a test — the short
 * version: if the test's outcome doesn't depend on what a model decides, it
 * belongs in this file, not test/e2e.test.ts.
 *
 * Run: npm run test:unit (milliseconds, no API cost)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createPicodeStore } from "../src/state";
import { createInbox } from "../src/inbox";
import type { Injection } from "../src/inbox";
import { registerLifecycle, extractFirstLine } from "../src/lifecycle";
import { deadlineFromSeconds } from "../src/core/time";
import { checkBodySize, MAX_BODY_BYTES } from "../src/tools/messaging";
import { registerTools } from "../src/tools/index";
import { registerCommands } from "../src/commands";
import {
  journalFingerprint,
  isDuplicateOfLastEntry,
  journalForkArgs,
  journalSignature,
  piSelfCommand,
  shouldJournal,
  JOURNAL_MIN_INTERVAL_MS,
  isCompactionEntry,
  decideCompaction,
  JOURNAL_COMPACT_THRESHOLD,
  JOURNAL_COMPACT_KEEP_RECENT,
  JOURNAL_COMPACT_COOLDOWN_MS,
} from "../src/journal";
import { buildWakeLaunch } from "../src/restate/wake-launch";
import { createLocalFsAdapter } from "../src/adapter/local-fs";
import type { StorageAdapter } from "../src/adapter/types";
import type { StateFile, Envelope, PicodeSummary } from "../src/core/types";
import { STALE_MS, PROCESSED_TTL_MS, CLIENT_CAPABILITIES, toSummary } from "../src/core/types";
import { ulid, mintEnvelopeId } from "../src/core/ids";

// --- harness -----------------------------------------------------------

type Call = { content: string; options?: { deliverAs?: string } };
type Notify = { text: string; level?: string };
// `details` shape is genuinely per-tool (mirrors the SDK's own TDetails =
// unknown default) — one documented `any` here beats ad-hoc casts at every
// call site below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolResult = { content: { type: string; text: string }[]; details: any };
type AnyTool = {
  execute: (
    toolCallId: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionCommandContext,
  ) => Promise<ToolResult>;
};
type AnyCommand = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };

function makeHarness(dir: string, id = "t1") {
  const calls: Call[] = [];
  const notifications: Notify[] = [];
  const tools: Record<string, AnyTool> = {};
  const commands: Record<string, AnyCommand> = {};

  const stubPi = {
    sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
      calls.push({ content, options });
    },
    registerTool: (tool: AnyTool & { name: string }) => {
      tools[tool.name] = tool;
    },
    registerCommand: (name: string, opts: AnyCommand) => {
      commands[name] = opts;
    },
  } as unknown as ExtensionAPI;

  const store = createPicodeStore(stubPi);
  // No internal `await` in LocalFsAdapter.configure — this synchronously
  // sets its root before the call returns, same reasoning as persist()
  // below, so the harness doesn't need to become async just for this.
  void store.adapter.configure(dir);
  store.picodeId = id;
  store.picodesRootDir = join(dir, ".picode", "picodes");
  store.picodeDir = join(store.picodesRootDir, id);
  mkdirSync(join(store.picodeDir, "inbox", "processed"), { recursive: true });

  const inbox = createInbox(store, stubPi);
  registerTools(stubPi, store, inbox);
  registerCommands(stubPi, store, inbox);
  // Fire-and-forget: LocalFsAdapter's writes have no internal `await`, so the
  // fs side effect (state.json existing, matching real session_start) has
  // already happened synchronously by the time this call returns, even
  // though the returned promise itself settles a microtask later.
  void store.persist();

  // Mutable so gate tests can flip between "agent idle" (injections start a
  // run) and "agent streaming" (injections queue). Default mirrors mid-run.
  const agent = { idle: false };

  const ctx = {
    ui: {
      setStatus: () => {},
      setTitle: () => {},
      setFooter: () => {},
      notify: (text: string, level?: string) => notifications.push({ text, level }),
    },
    isIdle: () => agent.idle,
    waitForIdle: async () => {},
    cwd: dir,
  } as unknown as ExtensionCommandContext;

  return {
    store,
    inbox,
    tools,
    commands,
    ctx,
    calls,
    notifications,
    dir,
    get idle() {
      return agent.idle;
    },
    set idle(v: boolean) {
      agent.idle = v;
    },
  };
}

type Harness = ReturnType<typeof makeHarness>;

function callTool(h: Harness, name: string, params: unknown = {}) {
  return h.tools[name].execute("test", params, undefined, undefined, h.ctx);
}

function callCommand(h: Harness, name: string, args = "") {
  return h.commands[name].handler(args, h.ctx);
}

function seedRemoteThread(h: Harness, id: string, opts: { role?: string; stale?: boolean } = {}) {
  const dir = join(h.store.picodesRootDir, id);
  mkdirSync(join(dir, "inbox", "processed"), { recursive: true });
  const lastSeen = opts.stale
    ? new Date(Date.now() - 5 * 60_000).toISOString()
    : new Date().toISOString();
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      id,
      pid: 999999,
      cwd: h.dir,
      parent: null,
      role: opts.role ?? null,
      sessionFile: null,
      state: "open",
      status: "running",
      holdReason: null,
      obligations: [],
      owed: [],
      barriers: [],
      startedAt: lastSeen,
      lastSeen,
      updatedAt: lastSeen,
    }),
  );
}

/** Write an envelope file directly into a picode's inbox, the way an
 *  external C1 actor would (Appendix B). `name` controls FIFO order. */
function seedEnvelope(
  h: Harness,
  ownId: string,
  msg: Partial<Envelope> & { from: string; body: string },
  name = `${ulid()}.json`,
) {
  const dir = join(h.store.picodesRootDir, ownId, "inbox");
  mkdirSync(dir, { recursive: true });
  const envelope: Envelope = {
    id: msg.id ?? mintEnvelopeId(msg.from),
    to: ownId,
    sentAt: new Date().toISOString(),
    ...msg,
  } as Envelope;
  writeFileSync(join(dir, name), JSON.stringify(envelope));
  return envelope;
}

function inboxFileCount(h: Harness, id: string): number {
  const dir = join(h.store.picodesRootDir, id, "inbox");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(f => f.endsWith(".json")).length;
}

function readInboxFile(h: Harness, id: string, index = 0): Envelope {
  const dir = join(h.store.picodesRootDir, id, "inbox");
  const files = readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .sort();
  return JSON.parse(readFileSync(join(dir, files[index]), "utf8"));
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}
function nowStamp(): string {
  return stamp(new Date());
}
function journalEntry(ts: string, workingOn: string, done = "did stuff"): string {
  return `\n<!-- ${ts} -->\nWorking on: ${workingOn}\nDone: ${done}\nDoing: more\nNext: ship\nBlockers: none\n`;
}
function writeJournal(h: Harness, id: string, content: string) {
  const dir = join(h.store.picodesRootDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.md"), content.trim() + "\n");
}

function owedRecord(from: string, id: string, summary = "?") {
  return { id, from, summary, receivedAt: new Date().toISOString() };
}

// A second harness, separate from makeHarness above: that one sets
// store.picodeId directly and never touches lifecycle.ts, so it can't
// exercise the opt-in gate that lives in registerLifecycle's session_start
// handler. This one goes through the real pi.on(...) wiring instead.
type CustomEntry = { type: "custom"; customType: string; data?: unknown };

type SentMessage = { customType: string; content: string };

function makeLifecycleHarness(dir: string) {
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  const setActiveToolsCalls: string[][] = [];
  const sentMessages: SentMessage[] = [];
  const registeredThreadTools = [
    "picode_status",
    "picode_list",
    "picode_journal",
    "picode_send",
    "picode_wait",
    "picode_suspend",
    "picode_resume",
  ];
  let activeTools = [...registeredThreadTools, "bash", "read_file"]; // some unrelated tool too

  const flags: Record<string, string | boolean | undefined> = {};

  const stubPi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers[event] = handler;
    },
    getFlag: (name: string) => flags[name],
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      setActiveToolsCalls.push(names);
      activeTools = names;
    },
    sendMessage: (msg: SentMessage) => {
      sentMessages.push({ customType: msg.customType, content: msg.content });
    },
    sendUserMessage: () => {},
    appendEntry: () => {},
  } as unknown as ExtensionAPI;

  const store = createPicodeStore(stubPi);
  const inbox = createInbox(store, stubPi);
  registerLifecycle(stubPi, store, inbox);

  function makeCtx(entries: CustomEntry[] = []) {
    return {
      cwd: dir,
      ui: { setStatus: () => {}, setTitle: () => {}, setFooter: () => {}, notify: () => {} },
      sessionManager: {
        getEntries: () => entries,
        getSessionFile: () => undefined,
      },
      isIdle: () => true,
    } as unknown as ExtensionContext;
  }

  return {
    store,
    inbox,
    dir,
    setFlag(name: string, value: string) {
      flags[name] = value;
    },
    fire(event: string, ctx: unknown, payload: unknown = {}) {
      return handlers[event]?.(payload, ctx);
    },
    makeCtx,
    setActiveToolsCalls,
    sentMessages,
    get activeTools() {
      return activeTools;
    },
    registeredThreadTools,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-picode-unit-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- tests ---------------------------------------------------------------

describe("tools: picode_send", () => {
  it("targets a single explicit id", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "picode_send", { to: "alice", body: "hi" });
    assert.strictEqual(r.details.ok, true);
    assert.strictEqual(r.details.sent.length, 1);
    assert.strictEqual(r.details.sent[0].to, "alice");
  });

  it('to="*" fans out to every known picode except self', async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    seedRemoteThread(h, "bob");
    const r = await callTool(h, "picode_send", { to: "*", body: "standup" });
    assert.strictEqual(r.details.sent.length, 2);
    assert.deepStrictEqual(r.details.sent.map((s: { to: string }) => s.to).sort(), [
      "alice",
      "bob",
    ]);
  });

  it('to="role:x" targets only threads with that role', async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice", { role: "dev" });
    seedRemoteThread(h, "bob", { role: "qa" });
    const r = await callTool(h, "picode_send", { to: "role:dev", body: "hi" });
    assert.strictEqual(r.details.sent.length, 1);
    assert.strictEqual(r.details.sent[0].to, "alice");
  });

  it("comma-separated targets exclude self", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "picode_send", { to: "alice,t1,bob", body: "hi" });
    assert.deepStrictEqual(r.details.sent.map((s: { to: string }) => s.to).sort(), [
      "alice",
      "bob",
    ]);
  });

  it("a reply (re) with no matching owed record gets a soft warning, not a failure", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const r = await callTool(h, "picode_send", { to: "alice", body: "ok", re: "alice/999" });
    assert.strictEqual(r.details.ok, true);
    assert.match(r.content[0].text, /no owed reply matches re "alice\/999"/);
  });

  it("a reply to the wrong picode for a real owed id warns with the correct target", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    seedRemoteThread(h, "bob");
    h.store.owed.push(owedRecord("alice", "alice/q1"));
    const r = await callTool(h, "picode_send", { to: "bob", body: "ok", re: "alice/q1" });
    assert.strictEqual(r.details.ok, true);
    assert.match(r.content[0].text, /owed to alice, not "bob"/);
  });

  it("a correctly targeted reply carries no warning", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    h.store.owed.push(owedRecord("alice", "alice/q1"));
    const r = await callTool(h, "picode_send", { to: "alice", body: "ok", re: "alice/q1" });
    assert.strictEqual(r.details.ok, true);
    assert.doesNotMatch(r.content[0].text, /Warning/);
  });

  it("expects=true records an obligation with the default deadline (§9.2)", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callTool(h, "picode_send", { to: "alice", body: "do it", expects: true });
    assert.strictEqual(h.store.obligations.length, 1);
    assert.ok(h.store.obligations[0].deadline, "default deadline must be applied");
  });

  it("an explicit deadlineSeconds overrides the default", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callTool(h, "picode_send", {
      to: "alice",
      body: "do it",
      expects: true,
      deadlineSeconds: 60,
    });
    const d = new Date(h.store.obligations[0].deadline!).getTime() - Date.now();
    assert.ok(d > 50_000 && d < 70_000, `deadline ~60s out, got ${d}ms`);
  });

  it("a plain note creates no obligation and no owed record", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callTool(h, "picode_send", { to: "alice", body: "fyi" });
    assert.strictEqual(h.store.obligations.length, 0);
    const written = readInboxFile(h, "alice");
    assert.strictEqual(written.expects, undefined);
    assert.strictEqual(written.re, undefined);
  });

  it("re + expects together (reply+request) discharges the old debt and opens a new one", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    h.store.owed.push(owedRecord("alice", "alice/q1", "what's the ETA?"));
    const r = await callTool(h, "picode_send", {
      to: "alice",
      body: "need the deploy env first — which one?",
      re: "alice/q1",
      expects: true,
    });
    assert.strictEqual(r.details.ok, true);
    // Old debt discharged (ball passed)...
    assert.strictEqual(h.store.owed.length, 0);
    // ...new debt opened the other way.
    assert.strictEqual(h.store.obligations.length, 1);
    const written = readInboxFile(h, "alice");
    assert.strictEqual(written.re, "alice/q1");
    assert.strictEqual(written.expects, true);
  });

  it("wait=true with expects arms a barrier carrying the given deadline", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const r = await callTool(h, "picode_send", {
      to: "alice",
      body: "do it",
      expects: true,
      deadlineSeconds: 120,
      wait: true,
    });
    assert.match(r.content[0].text, /Waiting \(barrier/);
    assert.strictEqual(h.store.barriers.length, 1);
    assert.ok(h.store.barriers[0].deadline);
    assert.deepStrictEqual(h.store.barriers[0].pending, [r.details.sent[0].id]);
  });

  it("wait=true without expects is ignored with a note", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const r = await callTool(h, "picode_send", { to: "alice", body: "fyi", wait: true });
    assert.match(r.content[0].text, /wait=true ignored/);
    assert.strictEqual(h.store.barriers.length, 0);
  });

  it("a send to a never-seen id queues durably but carries a typo warning", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "picode_send", { to: "ghost", body: "hello?", expects: true });
    assert.strictEqual(r.details.ok, true);
    assert.match(r.content[0].text, /never been seen in this workspace/);
    assert.strictEqual(inboxFileCount(h, "ghost"), 1);
  });

  it("a send to a known picode carries no typo warning", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const r = await callTool(h, "picode_send", { to: "alice", body: "hi" });
    assert.doesNotMatch(r.content[0].text, /never been seen/);
  });

  it("an immediate self-send is refused", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "picode_send", { to: "t1", body: "note to self" });
    assert.strictEqual(r.details.ok, false);
    assert.match(r.content[0].text, /deliverAfterSeconds/);
  });

  it("a self-send with deliverAfterSeconds is a scheduled wake (§12.2)", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "picode_send", {
      to: "t1",
      body: "check CI",
      deliverAfterSeconds: 120,
    });
    assert.strictEqual(r.details.ok, true);
    const written = readInboxFile(h, "t1");
    assert.strictEqual(written.to, "t1");
    assert.strictEqual(written.from, "t1");
    assert.ok(written.deliverAfter, "deliverAfter must be set");
    const holdMs = new Date(written.deliverAfter!).getTime() - Date.now();
    assert.ok(holdMs > 110_000 && holdMs < 130_000, `~120s hold, got ${holdMs}ms`);
  });

  it("urgency=high is written on the wire; low is absence (§6)", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callTool(h, "picode_send", { to: "alice", body: "now!", urgency: "high" });
    await callTool(h, "picode_send", { to: "alice", body: "later" });
    const first = readInboxFile(h, "alice", 0);
    const second = readInboxFile(h, "alice", 1);
    assert.strictEqual(first.urgency, "high");
    assert.strictEqual(second.urgency, undefined);
  });
});

describe("Errata 1: misdirected replies do not discharge the owed ledger (§9.1)", () => {
  it("a reply sent to the wrong picode leaves the owed record intact", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    seedRemoteThread(h, "bob");
    h.store.owed.push(owedRecord("alice", "alice/q1"));
    await callTool(h, "picode_send", { to: "bob", body: "ok", re: "alice/q1" });
    assert.strictEqual(h.store.owed.length, 1, "misdirected reply must not discharge");
  });

  it("a reply reaching the correct owed picode discharges it, on disk too", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    h.store.owed.push(owedRecord("alice", "alice/q1"));
    await h.store.persist();
    await callTool(h, "picode_send", { to: "alice", body: "ok", re: "alice/q1" });
    assert.strictEqual(h.store.owed.length, 0);
    const onDisk = JSON.parse(
      readFileSync(join(h.store.picodeDir, "state.json"), "utf8"),
    ) as StateFile;
    assert.strictEqual(onDisk.owed.length, 0);
  });
});

describe("Errata 1, obligation side: misdirected replies do not clear the sender's ledger (§9.3)", () => {
  function seedObligation(h: Harness, id: string, to: string) {
    h.store.obligations.push({
      id,
      to,
      summary: "do the thing",
      sentAt: new Date().toISOString(),
    });
  }

  it("a reply from the wrong picode leaves the obligation and its barrier intact", async () => {
    const h = makeHarness(tmpDir);
    seedObligation(h, "t1/q1", "alice");
    h.store.barriers.push({
      id: "barrier.t1.1",
      pending: ["t1/q1"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    seedEnvelope(h, "t1", { from: "bob", body: "done!", re: "t1/q1" });
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.store.obligations.length, 1, "wrong sender must not discharge");
    assert.strictEqual(h.store.barriers.length, 1, "wrong sender must not resolve the barrier");
    assert.deepStrictEqual(h.store.barriers[0].pending, ["t1/q1"]);
    // The envelope still renders — as an inert reply, not a discharge.
    assert.strictEqual(h.calls.length, 1);
    assert.doesNotMatch(h.calls[0].content, /barrier .* resolved/);
  });

  it("the real reply still discharges and resolves after a misdirected one", async () => {
    const h = makeHarness(tmpDir);
    seedObligation(h, "t1/q1", "alice");
    h.store.barriers.push({
      id: "barrier.t1.1",
      pending: ["t1/q1"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    seedEnvelope(h, "t1", { from: "bob", body: "done!", re: "t1/q1" }, "0-bob.json");
    seedEnvelope(h, "t1", { from: "alice", body: "actually done", re: "t1/q1" }, "1-alice.json");
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.store.obligations.length, 0, "correct sender discharges");
    assert.strictEqual(h.store.barriers.length, 0, "correct sender resolves the barrier");
  });
});

describe("expiresAt: stale mail self-discards at drain (Rev 10 §6)", () => {
  it("an expired envelope is claimed into processed/ but never delivered", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", {
      from: "alice",
      body: "standup in 5 min",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    seedEnvelope(h, "t1", { from: "alice", body: "still relevant" });
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls.length, 1, "only the unexpired envelope delivers");
    assert.match(h.calls[0].content, /still relevant/);
    assert.doesNotMatch(h.calls[0].content, /standup/);
    assert.strictEqual(inboxFileCount(h, "t1"), 0, "expired envelope is not left queued");
  });

  it("a future expiresAt does not block delivery", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", {
      from: "alice",
      body: "hurry",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /hurry/);
  });

  it("picode_send expiresAfterSeconds writes expiresAt on the wire", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callTool(h, "picode_send", { to: "alice", body: "now-ish", expiresAfterSeconds: 30 });
    const written = readInboxFile(h, "alice");
    assert.ok(written.expiresAt, "expiresAt must be set");
    const ttl = new Date(written.expiresAt!).getTime() - Date.now();
    assert.ok(ttl > 20_000 && ttl < 40_000, `~30s ttl, got ${ttl}ms`);
  });
});

describe("presence: capabilities and wake (Rev 10 §8.1)", () => {
  it("persist publishes the client capability tokens", async () => {
    const h = makeHarness(tmpDir);
    await h.store.persist();
    const onDisk = JSON.parse(
      readFileSync(join(h.store.picodeDir, "state.json"), "utf8"),
    ) as StateFile;
    assert.deepStrictEqual(onDisk.capabilities, [...CLIENT_CAPABILITIES]);
    assert.strictEqual(onDisk.wake, undefined, "no wake recipe unless the operator sets one");
  });
});

describe("local-fs: processed/ GC (Appendix B)", () => {
  it("drain prunes processed files older than PROCESSED_TTL_MS", async () => {
    const h = makeHarness(tmpDir, "gc1");
    const processed = join(h.store.picodeDir, "inbox", "processed");
    const oldFile = join(processed, "ancient.json");
    const freshFile = join(processed, "fresh.json");
    writeFileSync(oldFile, "{}");
    writeFileSync(freshFile, "{}");
    const past = new Date(Date.now() - PROCESSED_TTL_MS - 60_000);
    utimesSync(oldFile, past, past);
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(existsSync(oldFile), false, "expired file must be GC'd");
    assert.strictEqual(existsSync(freshFile), true, "fresh file must survive");
  });
});

describe("ids: envelope identity (§6.2)", () => {
  it("ulid() is 26 chars and monotonic within a millisecond", () => {
    const a = ulid(1000);
    const b = ulid(1000);
    assert.strictEqual(a.length, 26);
    assert.strictEqual(b.length, 26);
    assert.ok(b > a, "same-ms ulids must still sort in mint order");
  });

  it("two sends in the same millisecond get distinct ids", async () => {
    const h = makeHarness(tmpDir);
    const a = await h.inbox.sendEnvelope("alice", "one");
    const b = await h.inbox.sendEnvelope("alice", "two");
    assert.notStrictEqual(a.id, b.id);
  });

  it("a fan-out send mints a distinct id per target", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    seedRemoteThread(h, "bob");
    const r = await callTool(h, "picode_send", { to: "*", body: "go", expects: true });
    const ids = r.details.sent.map((s: { id: string }) => s.id);
    assert.strictEqual(new Set(ids).size, 2);
  });

  it("envelope ids carry the sender scope: <from>/<ulid>", async () => {
    const h = makeHarness(tmpDir);
    const { id } = await h.inbox.sendEnvelope("alice", "hi");
    assert.match(id, /^t1\/[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("tools: picode_wait", () => {
  it("arms a barrier with deadlineSeconds converted to an ISO deadline", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "picode_wait", { ids: ["t1/a", "t1/b"], deadlineSeconds: 60 });
    assert.strictEqual(h.store.barriers.length, 1);
    assert.ok(h.store.barriers[0].deadline);
    assert.deepStrictEqual(h.store.barriers[0].pending, ["t1/a", "t1/b"]);
  });

  it("warns when an id has no matching obligation", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "picode_wait", { ids: ["t1/nope"] });
    assert.match(r.content[0].text, /no open obligation matches t1\/nope/);
  });

  it("does not warn when the id matches an open obligation", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const send = await callTool(h, "picode_send", { to: "alice", body: "do", expects: true });
    const r = await callTool(h, "picode_wait", { ids: [send.details.sent[0].id] });
    assert.doesNotMatch(r.content[0].text, /Warning/);
  });

  it("stores an optional message payload on the barrier (§12.1)", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "picode_wait", { ids: ["t1/a"], message: "now merge the results" });
    assert.strictEqual(h.store.barriers[0].message, "now merge the results");
  });
});

describe("tools: picode_suspend / picode_resume", () => {
  it("suspend sets on-hold with the given reason", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "picode_suspend", { reason: "lunch" });
    assert.strictEqual(h.store.state, "on-hold");
    assert.strictEqual(h.store.holdReason, "lunch");
  });

  it("resume clears on-hold and drains the queued inbox", async () => {
    const h = makeHarness(tmpDir);
    await callTool(h, "picode_suspend", { reason: "wait" });
    seedEnvelope(h, "t1", { from: "alice", body: "queued while held" });
    await h.inbox.drainInbox(h.ctx); // on-hold: must NOT deliver
    assert.strictEqual(h.calls.length, 0);
    await callTool(h, "picode_resume", {});
    assert.strictEqual(h.store.state, "open");
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /queued while held/);
  });

  it("resume is a no-op when not on-hold", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "picode_resume", {});
    assert.strictEqual(r.details.ok, false);
  });
});

describe("tools: picode_status", () => {
  it("itemizes obligations and barriers in the text output", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      id: "t1/b1",
      to: "alice",
      summary: "build the lexer",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    h.store.barriers.push({
      id: "barrier.t1.1",
      pending: ["t1/b1"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    const r = await callTool(h, "picode_status");
    const text = r.content[0].text;
    assert.match(text, /request to alice #t1\/b1 "build the lexer" \(deadline /);
    assert.match(text, /barrier\.t1\.1 \(all\) pending: t1\/b1/);
  });

  it("itemizes owed replies with the id to echo", async () => {
    const h = makeHarness(tmpDir);
    h.store.owed.push(owedRecord("boss", "boss/q1", "which parser?"));
    const r = await callTool(h, "picode_status");
    assert.match(
      r.content[0].text,
      /you owe a reply to boss for their request #boss\/q1 "which parser\?" — reply with re="boss\/q1"/,
    );
  });

  it("shows 'none' for empty obligations and barriers", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "picode_status");
    assert.match(r.content[0].text, /Obligations: none/);
    assert.match(r.content[0].text, /Barriers: none/);
  });
});

describe("tools: picode_list", () => {
  it("reports a stale picode as stopped regardless of its stored status", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "ghost", { stale: true });
    const r = await callTool(h, "picode_list");
    const ghost = (r.details.threads as PicodeSummary[]).find(t => t.id === "ghost")!;
    assert.strictEqual(ghost.status, "stopped");
  });
});

describe("tools: picode_journal", () => {
  it("returns the full journal with no filters", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    writeJournal(h, "alice", journalEntry(nowStamp(), "task A") + journalEntry(nowStamp(), "B"));
    const r = await callTool(h, "picode_journal", { id: "alice" });
    assert.match(r.content[0].text, /task A/);
    assert.match(r.content[0].text, /Working on: B/);
  });

  it("tail limits to the last N entries", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    writeJournal(h, "alice", journalEntry(nowStamp(), "old") + journalEntry(nowStamp(), "newest"));
    const r = await callTool(h, "picode_journal", { id: "alice", tail: 1 });
    assert.doesNotMatch(r.content[0].text, /Working on: old/);
    assert.match(r.content[0].text, /Working on: newest/);
  });

  it("lookbackMinutes excludes entries older than the cutoff", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const oldTs = stamp(new Date(Date.now() - 3 * 60 * 60_000));
    writeJournal(h, "alice", journalEntry(oldTs, "ancient") + journalEntry(nowStamp(), "fresh"));
    const r = await callTool(h, "picode_journal", { id: "alice", lookbackMinutes: 60 });
    assert.doesNotMatch(r.content[0].text, /Working on: ancient/);
    assert.match(r.content[0].text, /Working on: fresh/);
  });

  it("errors for an unknown picode id", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "picode_journal", { id: "ghost" });
    assert.strictEqual(r.details.ok, false);
  });
});

describe("inbox: deliver (correlation, §9)", () => {
  function envelope(partial: Partial<Envelope> & { from: string; body: string }): Envelope {
    return {
      id: mintEnvelopeId(partial.from),
      to: "t1",
      sentAt: new Date().toISOString(),
      ...partial,
    } as Envelope;
  }

  it("a reply that resolves a barrier ships as exactly one message", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const send = await h.inbox.sendEnvelope("alice", "do it", { expects: true });
    h.store.barriers.push({
      id: "b1",
      pending: [send.id],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    const parts = await h.inbox.deliver(
      envelope({ from: "alice", body: "done", re: send.id }),
      h.ctx,
    );
    h.inbox.inject(parts, h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /done/);
    assert.match(h.calls[0].content, /barrier "b1" resolved/);
    assert.strictEqual(h.store.barriers.length, 0);
  });

  it("a reply clears only the matching obligation", async () => {
    const h = makeHarness(tmpDir);
    const a = await h.inbox.sendEnvelope("alice", "one", { expects: true });
    const b = await h.inbox.sendEnvelope("bob", "two", { expects: true });
    await h.inbox.deliver(envelope({ from: "alice", body: "ok", re: a.id }), h.ctx);
    assert.deepStrictEqual(
      h.store.obligations.map(o => o.id),
      [b.id],
    );
  });

  it('"any" mode resolves on the first reply, ignoring the rest', async () => {
    const h = makeHarness(tmpDir);
    const a = await h.inbox.sendEnvelope("alice", "one", { expects: true });
    const b = await h.inbox.sendEnvelope("bob", "two", { expects: true });
    h.store.barriers.push({
      id: "race",
      pending: [a.id, b.id],
      mode: "any",
      createdAt: new Date().toISOString(),
    });
    const parts = await h.inbox.deliver(envelope({ from: "bob", body: "first!", re: b.id }), h.ctx);
    assert.strictEqual(h.store.barriers.length, 0);
    assert.match(parts.map(p => p.text).join("\n"), /first reply arrived/);
  });

  it('"all" mode waits for every pending id before resolving', async () => {
    const h = makeHarness(tmpDir);
    const a = await h.inbox.sendEnvelope("alice", "one", { expects: true });
    const b = await h.inbox.sendEnvelope("bob", "two", { expects: true });
    h.store.barriers.push({
      id: "gate",
      pending: [a.id, b.id],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    await h.inbox.deliver(envelope({ from: "alice", body: "ok", re: a.id }), h.ctx);
    assert.strictEqual(h.store.barriers.length, 1);
    assert.deepStrictEqual(h.store.barriers[0].pending, [b.id]);
    const parts = await h.inbox.deliver(envelope({ from: "bob", body: "ok", re: b.id }), h.ctx);
    assert.strictEqual(h.store.barriers.length, 0);
    assert.match(parts.map(p => p.text).join("\n"), /all awaited replies have arrived/);
  });

  it("multiple barriers resolved by one reply fold into one delivery", async () => {
    const h = makeHarness(tmpDir);
    const a = await h.inbox.sendEnvelope("alice", "one", { expects: true });
    h.store.barriers.push(
      { id: "b1", pending: [a.id], mode: "all", createdAt: new Date().toISOString() },
      { id: "b2", pending: [a.id], mode: "any", createdAt: new Date().toISOString() },
    );
    const parts = await h.inbox.deliver(envelope({ from: "alice", body: "ok", re: a.id }), h.ctx);
    h.inbox.inject(parts, h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /barrier "b1" resolved/);
    assert.match(h.calls[0].content, /barrier "b2" resolved/);
  });

  it("a resolved barrier's message payload is injected alongside the reply (§12.1)", async () => {
    const h = makeHarness(tmpDir);
    const a = await h.inbox.sendEnvelope("alice", "one", { expects: true });
    h.store.barriers.push({
      id: "b1",
      pending: [a.id],
      mode: "all",
      createdAt: new Date().toISOString(),
      message: "now merge the branches",
    });
    const parts = await h.inbox.deliver(envelope({ from: "alice", body: "ok", re: a.id }), h.ctx);
    h.inbox.inject(parts, h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /now merge the branches/);
  });

  it("a reply+request discharges the pending wait AND records a new owed reply", async () => {
    const h = makeHarness(tmpDir);
    const a = await h.inbox.sendEnvelope("alice", "do it", { expects: true });
    const counter = envelope({ from: "alice", body: "which env?", re: a.id, expects: true });
    await h.inbox.deliver(counter, h.ctx);
    // Their counter-request discharged our obligation...
    assert.strictEqual(h.store.obligations.length, 0);
    // ...and we now owe them a reply keyed by THEIR envelope id.
    assert.deepStrictEqual(
      h.store.owed.map(o => o.id),
      [counter.id],
    );
  });

  it("renders kind from field presence, with a reply hint on requests (§6.1)", async () => {
    const h = makeHarness(tmpDir);
    const req = envelope({ from: "alice", body: "need this", expects: true });
    const parts = await h.inbox.deliver(req, h.ctx);
    assert.match(
      parts[0].text,
      new RegExp(`\\[request from alice #${req.id.replace("/", "\\/")}\\]`),
    );
    assert.match(parts[0].text, /this expects a reply/);
    const note = envelope({ from: "alice", body: "fyi" });
    const noteParts = await h.inbox.deliver(note, h.ctx);
    assert.match(noteParts[0].text, /\[note from alice/);
    assert.doesNotMatch(noteParts[0].text, /expects a reply/);
  });
});

describe("inbox: owed replies (recipient-side durability)", () => {
  function requestEnvelope(from: string, id: string, body = "do the thing"): Envelope {
    return {
      id,
      from,
      to: "t1",
      body,
      sentAt: new Date().toISOString(),
      expects: true,
    };
  }

  it("delivering a request records a durable owed reply with the id to echo", async () => {
    const h = makeHarness(tmpDir);
    await h.inbox.deliver(requestEnvelope("boss", "boss/b1"), h.ctx);
    assert.strictEqual(h.store.owed.length, 1);
    assert.strictEqual(h.store.owed[0].id, "boss/b1");
    const onDisk = JSON.parse(
      readFileSync(join(h.store.picodeDir, "state.json"), "utf8"),
    ) as StateFile;
    assert.strictEqual(onDisk.owed[0]?.id, "boss/b1");
  });

  it("a note does not record an owed reply", async () => {
    const h = makeHarness(tmpDir);
    await h.inbox.deliver(
      { id: "boss/n1", from: "boss", to: "t1", body: "fyi", sentAt: new Date().toISOString() },
      h.ctx,
    );
    assert.strictEqual(h.store.owed.length, 0);
  });

  it("redelivering the same id does not double-record", async () => {
    const h = makeHarness(tmpDir);
    await h.inbox.deliver(requestEnvelope("boss", "boss/b1"), h.ctx);
    await h.inbox.deliver(requestEnvelope("boss", "boss/b1"), h.ctx);
    assert.strictEqual(h.store.owed.length, 1);
  });

  it("sending the matching reply settles the owed record", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "boss");
    await h.inbox.deliver(requestEnvelope("boss", "boss/b1"), h.ctx);
    await callTool(h, "picode_send", { to: "boss", body: "done", re: "boss/b1" });
    assert.strictEqual(h.store.owed.length, 0);
  });

  it("a reply with a different re leaves the owed record intact", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "boss");
    await h.inbox.deliver(requestEnvelope("boss", "boss/b1"), h.ctx);
    await callTool(h, "picode_send", { to: "boss", body: "unrelated", re: "boss/other" });
    assert.strictEqual(h.store.owed.length, 1);
  });
});

describe("inbox: drainInbox", () => {
  it("skips malformed JSON without crashing or redelivering it", async () => {
    const h = makeHarness(tmpDir);
    const dir = join(h.store.picodesRootDir, "t1", "inbox");
    writeFileSync(join(dir, "0-bad.json"), "{nope");
    seedEnvelope(h, "t1", { from: "alice", body: "good one" });
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /good one/);
    assert.ok(existsSync(join(dir, "0-bad.json")), "malformed file stays put");
  });

  it("coalesces one drain into one message, envelopes in FIFO filename order", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", { from: "alice", body: "FIRST" }, "1-a.json");
    seedEnvelope(h, "t1", { from: "bob", body: "SECOND" }, "2-b.json");
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    const text = h.calls[0].content;
    assert.ok(text.indexOf("FIRST") < text.indexOf("SECOND"), "FIFO order preserved");
  });

  it("a batch with any high-urgency part delivers as steer, all-low as followUp (§7.5)", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", { from: "alice", body: "calm" }, "1-a.json");
    seedEnvelope(h, "t1", { from: "bob", body: "urgent!", urgency: "high" }, "2-b.json");
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls[0].options?.deliverAs, "steer");

    seedEnvelope(h, "t1", { from: "alice", body: "calm again" }, "3-c.json");
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls[1].options?.deliverAs, "followUp");
  });

  it("a deliverAfter envelope stays queued until due (§6)", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", {
      from: "alice",
      body: "future",
      deliverAfter: new Date(Date.now() + 60_000).toISOString(),
    });
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls.length, 0, "not deliverable yet");
    assert.strictEqual(inboxFileCount(h, "t1"), 1, "still durably queued");
  });
});

describe("inbox: injection gate (§7.3/§7.7)", () => {
  it("holds the drain shut during compaction and flushes after it ends", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", { from: "alice", body: "during compaction" });
    h.inbox.noteCompactionStart();
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(inboxFileCount(h, "t1"), 1, "§7.7: not even claimed while gated");
    h.inbox.noteCompactionEnd();
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls.length, 1);
  });

  it("an idle-time injection blocks further drains until a turn starts", async () => {
    const h = makeHarness(tmpDir);
    h.idle = true;
    seedEnvelope(h, "t1", { from: "alice", body: "first" });
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    seedEnvelope(h, "t1", { from: "alice", body: "second" });
    await h.inbox.drainInbox(h.ctx); // gated by the preflight hold
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(inboxFileCount(h, "t1"), 1, "second stays durable");
    h.inbox.noteRunStarted();
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls.length, 2);
  });

  it("mid-run injections never arm the preflight hold", async () => {
    const h = makeHarness(tmpDir);
    h.idle = false;
    seedEnvelope(h, "t1", { from: "alice", body: "one" });
    await h.inbox.drainInbox(h.ctx);
    seedEnvelope(h, "t1", { from: "alice", body: "two" });
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls.length, 2);
  });

  it("deadline nudges wait out the gate instead of being lost", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      id: "t1/late",
      to: "alice",
      summary: "overdue",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    h.inbox.noteCompactionStart();
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(h.store.obligations[0].nudged, undefined, "not consumed while gated");
    h.inbox.noteCompactionEnd();
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(h.store.obligations[0].nudged, true);
  });
});

describe("inbox: checkDeadlines (§9.2)", () => {
  it("an overdue obligation nudges once and not twice", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      id: "t1/late",
      to: "alice",
      summary: "the report",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /obligation overdue #t1\/late/);
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 1, "one-shot nudge");
  });

  it("an overdue barrier nudges once and not twice", async () => {
    const h = makeHarness(tmpDir);
    h.store.barriers.push({
      id: "b.late",
      pending: ["t1/x"],
      mode: "all",
      createdAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /barrier overdue "b\.late"/);
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 1);
  });

  it("no nudge before the deadline passes", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      id: "t1/early",
      to: "alice",
      summary: "x",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 0);
  });
});

describe("Errata 3: heartbeat coalesces its sources into one inject (§7.5)", () => {
  it("the shared-array batch ships drain + deadline nudge in a single user message when idle", async () => {
    const h = makeHarness(tmpDir);
    h.idle = true;
    seedEnvelope(h, "t1", { from: "alice", body: "queued envelope" });
    h.store.obligations.push({
      id: "t1/late",
      to: "bob",
      summary: "overdue thing",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    const parts: Injection[] = [];
    await h.inbox.drainInbox(h.ctx, parts);
    await h.inbox.checkDeadlines(h.ctx, parts);
    h.inbox.inject(parts, h.ctx);
    assert.strictEqual(h.calls.length, 1, "one coalesced message");
    assert.match(h.calls[0].content, /queued envelope/);
    assert.match(h.calls[0].content, /obligation overdue #t1\/late/);
  });

  it("standalone idle calls still self-serialize — the tax the batch avoids", async () => {
    const h = makeHarness(tmpDir);
    h.idle = true;
    seedEnvelope(h, "t1", { from: "alice", body: "queued envelope" });
    h.store.obligations.push({
      id: "t1/late",
      to: "bob",
      summary: "overdue thing",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    await h.inbox.drainInbox(h.ctx); // injects, arms the preflight hold
    await h.inbox.checkDeadlines(h.ctx); // gated by that hold
    assert.strictEqual(h.calls.length, 1);
    assert.doesNotMatch(h.calls[0].content, /obligation overdue/);
  });

  it("standalone (no shared array) still injects its own batch — unchanged callers", async () => {
    const h = makeHarness(tmpDir);
    seedEnvelope(h, "t1", { from: "alice", body: "solo drain" });
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /solo drain/);
  });
});

describe("state: journal gating", () => {
  it("journalFingerprint keeps only Working on / Done lines, case/whitespace-insensitive", () => {
    const a = "Working on: X\nDone: y\nDoing: whatever\nNext: n1\nBlockers: none";
    const b = "working on:  X\ndone: y\nDoing: different\nNext: n2\nBlockers: some";
    assert.strictEqual(journalFingerprint(a), journalFingerprint(b));
  });

  it("isDuplicateOfLastEntry matches when Working on/Done are identical to the last entry", () => {
    const journal = journalEntry(nowStamp(), "task A", "step 1");
    const dupe = "Working on: task A\nDone: step 1\nDoing: x\nNext: y\nBlockers: none";
    assert.strictEqual(isDuplicateOfLastEntry(journal, dupe), true);
  });

  it("isDuplicateOfLastEntry does not match genuinely different content", () => {
    const journal = journalEntry(nowStamp(), "task A", "step 1");
    const fresh = "Working on: task B\nDone: step 2\nDoing: x\nNext: y\nBlockers: none";
    assert.strictEqual(isDuplicateOfLastEntry(journal, fresh), false);
  });

  it("isDuplicateOfLastEntry returns false when no journal content exists yet", () => {
    assert.strictEqual(isDuplicateOfLastEntry(undefined, "Working on: x\nDone: y"), false);
  });
});

describe("lifecycle: journalSignature / shouldJournal", () => {
  function bareStore() {
    const h = makeHarness(tmpDir);
    return h.store;
  }

  it("an unchanged signature with no tool call skips journaling after the first check", () => {
    const store = bareStore();
    assert.strictEqual(shouldJournal(store, true), true); // first: signature unset
    assert.strictEqual(shouldJournal(store, false), false);
  });

  it("a tool-using turn inside the rate-limit window defers to a run-end wrap-up", () => {
    const store = bareStore();
    assert.strictEqual(shouldJournal(store, true), true);
    assert.strictEqual(shouldJournal(store, true), false); // rate-limited, records debt
    assert.strictEqual(store.journalDebt, true);
    assert.strictEqual(shouldJournal(store, false, "run-end"), true); // debt repaid
    assert.strictEqual(store.journalDebt, false);
  });

  it("a tool-using turn past the rate-limit window journals immediately", () => {
    const store = bareStore();
    assert.strictEqual(shouldJournal(store, true), true);
    store.lastJournalAt = Date.now() - JOURNAL_MIN_INTERVAL_MS - 1;
    assert.strictEqual(shouldJournal(store, true), true);
  });

  it("a changed signature journals even without a tool call, ignoring the rate limit", () => {
    const store = bareStore();
    assert.strictEqual(shouldJournal(store, true), true);
    store.obligations.push({
      id: "t1/new",
      to: "alice",
      summary: "x",
      sentAt: new Date().toISOString(),
    });
    assert.strictEqual(shouldJournal(store, false), true);
  });

  it('phase "done" journals a run that used tools, exactly once', () => {
    const store = bareStore();
    assert.strictEqual(shouldJournal(store, true, "done"), true);
    assert.strictEqual(shouldJournal(store, false, "done"), false);
  });

  it("journalSignature changes when an obligation is added", () => {
    const store = bareStore();
    const before = journalSignature(store);
    store.obligations.push({
      id: "t1/x",
      to: "alice",
      summary: "s",
      sentAt: new Date().toISOString(),
    });
    assert.notStrictEqual(journalSignature(store), before);
  });

  it("the journal fork opts out of extensions so it can never become a picode itself", () => {
    const args = journalForkArgs("/ses/file.jsonl", "/tmp/x");
    assert.ok(args.includes("--no-extensions"));
    assert.ok(args.includes("--fork"));
    assert.ok(!args.includes("--model"), "no model pinned unless configured");
  });

  it("piSelfCommand re-invokes pi the way this process was started", () => {
    const nodeLaunch = piSelfCommand(["--print", "x"], "/usr/bin/node", "/opt/pi/cli.js");
    assert.deepStrictEqual(nodeLaunch, {
      cmd: "/usr/bin/node",
      args: ["/opt/pi/cli.js", "--print", "x"],
    });
    const standalone = piSelfCommand(["--print", "x"], "/opt/pi/bin/pi", undefined);
    assert.deepStrictEqual(standalone, { cmd: "/opt/pi/bin/pi", args: ["--print", "x"] });
  });

  it("the journal fork inherits the session's model unless one is pinned", () => {
    assert.ok(!journalForkArgs("/s.jsonl", "/tmp/x").includes("--model"));
    const pinned = journalForkArgs("/s.jsonl", "/tmp/x", "deepseek/deepseek-chat");
    assert.ok(pinned.includes("--model"));
    assert.ok(pinned.includes("deepseek/deepseek-chat"));
  });
});

describe("lifecycle: opt-in gate (§2.3)", () => {
  it("no --picode-id and no prior identity: stays inactive, never touches disk, hides picode_* tools", async () => {
    const h = makeLifecycleHarness(tmpDir);
    await h.fire("session_start", h.makeCtx());
    assert.ok(!existsSync(join(tmpDir, ".picode")), "no .picode/ dir for a non-picode session");
    assert.strictEqual(h.setActiveToolsCalls.length, 1);
    assert.deepStrictEqual(h.activeTools, ["bash", "read_file"]);
  });

  it("--picode-id passed: activates, creates .picode/, leaves the tool list alone", async () => {
    const h = makeLifecycleHarness(tmpDir);
    h.setFlag("picode-id", "t9");
    await h.fire("session_start", h.makeCtx());
    assert.ok(existsSync(join(tmpDir, ".picode", "picodes", "t9", "state.json")));
    assert.strictEqual(h.setActiveToolsCalls.length, 0);
    h.store.stopHeartbeat();
    h.store.stopWatcher();
  });

  it("no flag but a prior picode-identity entry: stays active on a session resume", async () => {
    const h = makeLifecycleHarness(tmpDir);
    const ctx = h.makeCtx([{ type: "custom", customType: "picode-identity", data: { id: "t7" } }]);
    await h.fire("session_start", ctx);
    assert.ok(existsSync(join(tmpDir, ".picode", "picodes", "t7", "state.json")));
    h.store.stopHeartbeat();
    h.store.stopWatcher();
  });

  it("while inactive, every other lifecycle handler no-ops instead of touching an uninitialized store", async () => {
    const h = makeLifecycleHarness(tmpDir);
    const ctx = h.makeCtx();
    await h.fire("session_start", ctx);
    await h.fire("turn_start", ctx);
    await h.fire("tool_execution_start", ctx);
    await h.fire("turn_end", ctx);
    await h.fire("agent_end", ctx);
    await h.fire("session_shutdown", ctx, { reason: "quit" });
    assert.ok(!existsSync(join(tmpDir, ".picode")));
    assert.strictEqual(h.store.picodeId, "");
  });
});

describe("lifecycle: silent-debtor nudge (§9.4)", () => {
  async function activeHarness() {
    const h = makeLifecycleHarness(tmpDir);
    h.setFlag("picode-id", "t9");
    const ctx = h.makeCtx();
    await h.fire("session_start", ctx);
    h.store.stopHeartbeat();
    h.store.stopWatcher();
    return { h, ctx };
  }

  function owe(h: ReturnType<typeof makeLifecycleHarness>, from = "boss", id = "boss/q1") {
    h.store.owed.push({ id, from, summary: "?", receivedAt: new Date().toISOString() });
  }

  it("fires once on the first silent turn with an owed reply outstanding, soliciting the canary", async () => {
    const { h, ctx } = await activeHarness();
    owe(h);
    await h.fire("turn_start", ctx);
    await h.fire("turn_end", ctx);
    assert.strictEqual(h.sentMessages.length, 1);
    assert.strictEqual(h.sentMessages[0].customType, "picode-owed-reminder");
    assert.match(h.sentMessages[0].content, /boss \(re #boss\/q1\)/);
    assert.match(h.sentMessages[0].content, /"Standing by"/);
    assert.match(h.sentMessages[0].content, /Pass the ball/);
  });

  it("does not fire again on a second consecutive silent turn within the same run", async () => {
    const { h, ctx } = await activeHarness();
    owe(h);
    await h.fire("turn_start", ctx);
    await h.fire("turn_end", ctx);
    await h.fire("turn_end", ctx);
    assert.strictEqual(h.sentMessages.length, 1);
  });

  it("a tool-using turn resets streak and gate; the next silent turn fires again", async () => {
    const { h, ctx } = await activeHarness();
    owe(h);
    await h.fire("turn_start", ctx);
    await h.fire("turn_end", ctx);
    assert.strictEqual(h.sentMessages.length, 1);
    await h.fire("tool_execution_start", ctx);
    await h.fire("turn_end", ctx);
    assert.strictEqual(h.store.owedSilentStreak, 0);
    await h.fire("turn_start", ctx);
    await h.fire("turn_end", ctx);
    assert.strictEqual(h.sentMessages.length, 2);
  });

  it("escalates at streak >= 2 once agent_end re-arms the gate across a second silent run", async () => {
    const { h, ctx } = await activeHarness();
    owe(h);
    await h.fire("turn_start", ctx);
    await h.fire("turn_end", ctx); // streak 1, nudge 1
    await h.fire("agent_end", ctx); // re-arms the gate, streak stays
    await h.fire("turn_start", ctx);
    await h.fire("turn_end", ctx); // streak 2, nudge 2 — escalated
    assert.strictEqual(h.sentMessages.length, 2);
    assert.match(h.sentMessages[1].content, /turn 2 with no reply/);
  });

  it("streak caps at 3 across repeated silent runs", async () => {
    const { h, ctx } = await activeHarness();
    owe(h);
    for (let run = 0; run < 5; run++) {
      await h.fire("turn_start", ctx);
      await h.fire("turn_end", ctx);
      await h.fire("agent_end", ctx);
    }
    assert.strictEqual(h.store.owedSilentStreak, 3);
    assert.match(h.sentMessages.at(-1)!.content, /turn 3 with no reply/);
  });

  it("never fires when the picode never activated", async () => {
    const h = makeLifecycleHarness(tmpDir);
    const ctx = h.makeCtx();
    await h.fire("session_start", ctx);
    h.store.owed.push({
      id: "x/1",
      from: "x",
      summary: "?",
      receivedAt: new Date().toISOString(),
    });
    await h.fire("turn_end", ctx);
    assert.strictEqual(h.sentMessages.length, 0);
  });
});

describe("commands: slash commands", () => {
  it("refuses to run when the picode never activated (opt-in gate never ran)", async () => {
    const h = makeHarness(tmpDir);
    h.store.picodeId = ""; // simulate: init() never ran
    await callCommand(h, "/picode-status");
    assert.match(h.notifications[0].text, /hasn't opted into picode/);
  });

  it("/picode-status notification includes the coordination counts", async () => {
    const h = makeHarness(tmpDir);
    h.store.barriers.push({
      id: "b1",
      pending: ["t1/x"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    h.store.owed.push(owedRecord("boss", "boss/q1"));
    await callCommand(h, "/picode-status");
    assert.match(h.notifications[0].text, /Barriers: 1/);
    assert.match(h.notifications[0].text, /Owed: 1/);
  });

  it("/picode-suspend then /picode-resume round-trips on-hold state", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/picode-suspend", "coffee");
    assert.strictEqual(h.store.state, "on-hold");
    assert.strictEqual(h.store.holdReason, "coffee");
    await callCommand(h, "/picode-resume");
    assert.strictEqual(h.store.state, "open");
  });

  it("/picode-send rejects sending to self", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/picode-send", "t1 hello");
    assert.match(h.notifications[0].text, /Cannot send to self/);
  });

  it("/picode-send writes a high-urgency envelope (operator sends interrupt)", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callCommand(h, "/picode-send", "alice please pause");
    const written = readInboxFile(h, "alice");
    assert.strictEqual(written.body, "please pause");
    assert.strictEqual(written.urgency, "high");
    assert.strictEqual(written.from, "t1");
  });

  it("/picode-send rejects oversized bodies (human path matches picode_send tool guard)", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    // Build a body one byte over the 256KB cap. Slash-command args
    // arrive as a single string from the harness — just paste the
    // oversized body after the target.
    const oversized = "x".repeat(MAX_BODY_BYTES + 1);
    await callCommand(h, "/picode-send", `alice ${oversized}`);
    // No envelope should have been persisted.
    assert.equal(
      h.notifications.some(n => n.text.startsWith("Sent to alice")),
      false,
      "oversized body must not produce a 'Sent to ...' notification",
    );
    // Error notification must mention both the actual size and the limit.
    const err = h.notifications.find(n => n.level === "error");
    assert.ok(err, "expected an error notification for oversized body");
    assert.match(err!.text, new RegExp(String(MAX_BODY_BYTES + 1)));
    assert.match(err!.text, /picode_send body too large/);
  });

  it("/picode-list includes current picode and seeded threads", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    await callCommand(h, "/picode-list");
    const text = h.notifications.at(-1)!.text;
    assert.match(text, /t1/);
    assert.match(text, /alice/);
  });

  it("/picode-models shows unconfigured with no file", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/picode-models");
    assert.match(h.notifications.at(-1)!.text, /No models configured/);
  });

  it("/picode-models sets and persists a model", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/picode-models", "builder gemini-2.5-flash");
    assert.match(h.notifications.at(-1)!.text, /Set builder/);
  });
});

// --- adapter layer --------------------------------------------------------

function baseState(id: string, overrides: Partial<StateFile> = {}): StateFile {
  const now = new Date().toISOString();
  return {
    id,
    pid: 1,
    cwd: "/virtual",
    parent: null,
    role: "worker",
    sessionFile: null,
    state: "open",
    status: "running",
    holdReason: null,
    obligations: [],
    owed: [],
    barriers: [],
    startedAt: now,
    lastSeen: now,
    updatedAt: now,
    ...overrides,
  };
}

function wireEnvelope(
  from: string,
  to: string,
  body: string,
  extra: Partial<Envelope> = {},
): Envelope {
  return {
    id: mintEnvelopeId(from),
    from,
    to,
    body,
    sentAt: new Date().toISOString(),
    ...extra,
  };
}

describe("adapter: LocalFsAdapter (Appendix B binding)", () => {
  it("savePicodeState/loadPicodeState round-trips through state.json", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.savePicodeState("a", baseState("a"));
    const loaded = await adapter.loadPicodeState("a");
    assert.strictEqual(loaded?.id, "a");
    assert.ok(existsSync(join(tmpDir, ".picode", "picodes", "a", "state.json")));
  });

  it("loadPicodeState returns undefined for an unknown picode", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    assert.strictEqual(await adapter.loadPicodeState("ghost"), undefined);
  });

  it("threadExists reflects whether state.json is present", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    assert.strictEqual(await adapter.threadExists("a"), false);
    await adapter.savePicodeState("a", baseState("a"));
    assert.strictEqual(await adapter.threadExists("a"), true);
  });

  it("enqueueMessage + drainInbox delivers everything exactly once, in FIFO ulid order", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.enqueueMessage(wireEnvelope("alice", "bob", "first"));
    await adapter.enqueueMessage(wireEnvelope("alice", "bob", "second"));
    const claimed = await adapter.drainInbox("bob");
    // Monotonic ULIDs make FIFO exact even in the same millisecond.
    assert.deepStrictEqual(
      claimed.map(m => m.body),
      ["first", "second"],
    );
    assert.deepStrictEqual(await adapter.drainInbox("bob"), []);
  });

  it("enqueue goes through inbox.tmp staging and leaves nothing behind", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.enqueueMessage(wireEnvelope("alice", "bob", "hi"));
    const staging = join(tmpDir, ".picode", "picodes", "bob", "inbox.tmp");
    assert.ok(existsSync(staging), "staging dir exists");
    assert.strictEqual(readdirSync(staging).length, 0, "no leftover temp files");
    assert.strictEqual(
      readdirSync(join(tmpDir, ".picode", "picodes", "bob", "inbox")).filter(f =>
        f.endsWith(".json"),
      ).length,
      1,
    );
  });

  it("a retry with the same id overwrites its own file — enqueue idempotence (§7.6)", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    const msg = wireEnvelope("alice", "bob", "retry me");
    await adapter.enqueueMessage(msg);
    await adapter.enqueueMessage(msg);
    const claimed = await adapter.drainInbox("bob");
    assert.strictEqual(claimed.length, 1, "no duplicate delivery");
  });

  it("drainInbox holds deliverAfter envelopes until due, then delivers them (§6)", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.enqueueMessage(
      wireEnvelope("alice", "bob", "later", {
        deliverAfter: new Date(Date.now() + 150).toISOString(),
      }),
    );
    assert.deepStrictEqual(await adapter.drainInbox("bob"), [], "not due yet");
    await new Promise(r => setTimeout(r, 200));
    const claimed = await adapter.drainInbox("bob");
    assert.strictEqual(claimed.length, 1);
    assert.strictEqual(claimed[0].body, "later");
  });

  it("drainInbox leaves malformed JSON in place and never returns it", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    const dir = join(tmpDir, ".picode", "picodes", "bob", "inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1-bad.json"), "{not valid json");
    const claimed = await adapter.drainInbox("bob");
    assert.strictEqual(claimed.length, 0);
    assert.ok(existsSync(join(dir, "1-bad.json")));
  });

  it("listPcodes reports a picode stale past STALE_MS as stopped", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.savePicodeState(
      "ghost",
      baseState("ghost", { lastSeen: new Date(Date.now() - STALE_MS - 1000).toISOString() }),
    );
    const threads = await adapter.listPcodes();
    assert.strictEqual(threads[0]?.status, "stopped");
  });

  it("watchInbox doesn't throw for a picode that has never received a message (no inbox/ dir yet)", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.savePicodeState("fresh", baseState("fresh"));
    assert.ok(!existsSync(join(tmpDir, ".picode", "picodes", "fresh", "inbox")));
    let fired = false;
    const dispose = adapter.watchInbox("fresh", () => {
      fired = true;
    });
    // Dispose in finally: a leaked FSWatcher keeps the node:test process
    // alive forever if an assertion throws first (observed as a 5-minute
    // hang when the fixed 50ms wait flaked under load).
    try {
      assert.ok(existsSync(join(tmpDir, ".picode", "picodes", "fresh", "inbox")));
      // A message arriving after the (now-live) watch should still be observed.
      await adapter.enqueueMessage(wireEnvelope("other", "fresh", "hi"));
      for (let i = 0; i < 40 && !fired; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.strictEqual(fired, true);
    } finally {
      dispose();
    }
  });
});

/** Minimal in-memory StorageAdapter — proves state.ts/inbox.ts never reach
 *  into fs directly, only through store.adapter, by running the same
 *  cross-picode send/deliver flow against a backend with no filesystem at
 *  all. Deliberately implements ONLY the core contract, no JournalAdapter —
 *  which also exercises the journal channel's optionality (§5). */
function createFakeAdapter(): StorageAdapter {
  const states = new Map<string, StateFile>();
  const inboxes = new Map<string, Envelope[]>();

  return {
    async configure() {},
    async loadPicodeState(id) {
      return states.get(id);
    },
    async savePicodeState(id, state) {
      states.set(id, structuredClone(state));
    },
    async listPcodes(): Promise<PicodeSummary[]> {
      return [...states.values()].map(toSummary);
    },
    async threadExists(id) {
      return states.has(id);
    },
    async enqueueMessage(message) {
      const arr = inboxes.get(message.to) ?? [];
      arr.push(message);
      inboxes.set(message.to, arr);
    },
    async drainInbox(id) {
      const arr = inboxes.get(id) ?? [];
      const now = Date.now();
      const due = arr.filter(m => !m.deliverAfter || new Date(m.deliverAfter).getTime() <= now);
      inboxes.set(
        id,
        arr.filter(m => m.deliverAfter && new Date(m.deliverAfter).getTime() > now),
      );
      return due;
    },
    async finalizeDrain(_id) {
      // in-memory: no-op — drain already removed from inboxes array
    },
    watchInbox() {
      return () => {};
    },
  };
}

describe("adapter seam: core logic against a fake in-memory adapter", () => {
  const stubPiWith = (calls: Call[]) =>
    ({
      sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
        calls.push({ content, options });
      },
      registerTool: () => {},
      registerCommand: () => {},
    }) as unknown as ExtensionAPI;

  it("a note sent from one picode is drained and delivered on the other, with no fs involved", async () => {
    const fake = createFakeAdapter();
    const calls: Call[] = [];
    const stubPi = stubPiWith(calls);
    const ctx = {
      ui: { setStatus: () => {}, setTitle: () => {} },
    } as unknown as ExtensionCommandContext;

    const sender = createPicodeStore(stubPi, fake);
    sender.picodeId = "sender";
    sender.picodesRootDir = "/virtual";
    sender.picodeDir = "/virtual/sender";
    await sender.persist();
    const senderInbox = createInbox(sender, stubPi);

    const receiver = createPicodeStore(stubPi, fake);
    receiver.picodeId = "receiver";
    receiver.picodesRootDir = "/virtual";
    receiver.picodeDir = "/virtual/receiver";
    await receiver.persist();
    const receiverInbox = createInbox(receiver, stubPi);

    const { delivered } = await senderInbox.sendEnvelope("receiver", "hi from fake adapter");
    assert.strictEqual(delivered, "live"); // receiver's state already exists and is fresh

    await receiverInbox.drainInbox(ctx as unknown as ExtensionContext);
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].content, /hi from fake adapter/);
  });

  it("transition persists through adapter.savePicodeState, not raw fs", async () => {
    const fake = createFakeAdapter();
    const stubPi = stubPiWith([]);
    const store = createPicodeStore(stubPi, fake);
    store.picodeId = "solo";
    store.picodeDir = "/virtual/solo";
    await store.transition("open");
    const loaded = await fake.loadPicodeState("solo");
    assert.strictEqual(loaded?.state, "open");
  });

  it("readJournal degrades to undefined on a backend without the JournalAdapter extension", async () => {
    const fake = createFakeAdapter();
    const stubPi = stubPiWith([]);
    const store = createPicodeStore(stubPi, fake);
    store.picodeId = "solo";
    assert.strictEqual(await store.readJournal("solo"), undefined);
  });

  it("picode_journal errors cleanly on a backend without the journal channel", async () => {
    const fake = createFakeAdapter();
    const tools: Record<string, AnyTool> = {};
    const stubPi = {
      sendUserMessage: () => {},
      registerTool: (tool: AnyTool & { name: string }) => {
        tools[tool.name] = tool;
      },
      registerCommand: () => {},
    } as unknown as ExtensionAPI;
    const store = createPicodeStore(stubPi, fake);
    store.picodeId = "solo";
    await store.persist();
    const inbox = createInbox(store, stubPi);
    registerTools(stubPi, store, inbox);
    const ctx = {
      ui: { setStatus: () => {}, setTitle: () => {} },
    } as unknown as ExtensionCommandContext;
    const r = await tools["picode_journal"].execute("t", { id: "solo" }, undefined, undefined, ctx);
    assert.strictEqual(r.details.ok, false);
    assert.match(r.content[0].text, /no journal channel/);
  });
});

describe("restate: buildWakeLaunch", () => {
  it("spawns pi against the restate backend, in the picode's own cwd", () => {
    const l = buildWakeLaunch(
      "t1",
      "[delayed envelope due #t1/01X] — drain your inbox.",
      "/work/space",
      {},
    );
    assert.strictEqual(l.cmd, "pi");
    assert.strictEqual(l.cwd, "/work/space");
    const args = l.args.join(" ");
    assert.match(args, /--picode-id t1/);
    assert.match(args, /--picode-storage restate/);
    assert.match(args, /--picode-storage-url http:\/\/localhost:8080/);
    assert.match(args, /--print \[delayed envelope due #t1\/01X\]/);
    assert.doesNotMatch(args, /--extension/); // only when PI_THREAD_EXTENSION is set
  });

  it("honors RESTATE_INGRESS_URL, PI_THREAD_EXTENSION, and PI_BIN from the service environment", () => {
    const l = buildWakeLaunch("t1", "wake up", "/w", {
      RESTATE_INGRESS_URL: "http://restate.internal:8080",
      PI_THREAD_EXTENSION: "/opt/picode/src/index.ts",
      PI_BIN: "/opt/pi/bin/pi",
    });
    assert.strictEqual(l.cmd, "/opt/pi/bin/pi");
    const args = l.args.join(" ");
    assert.match(args, /--picode-storage-url http:\/\/restate\.internal:8080/);
    assert.match(args, /--extension \/opt\/picode\/src\/index\.ts/);
  });
});

describe("bin/picode-cli.mjs: external C1 actor", () => {
  const cli = join(import.meta.dirname, "..", "bin", "picode-cli.mjs");
  const runCli = (dir: string, ...cliArgs: string[]) =>
    execFileSync(process.execPath, [cli, ...cliArgs, "--dir", dir], { encoding: "utf8" });

  async function seedCoordination(h: Harness) {
    h.store.obligations.push({
      id: "t1/b1",
      to: "alice",
      summary: "build the lexer",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    h.store.owed.push(owedRecord("boss", "boss/q1", "which parser?"));
    h.store.barriers.push({
      id: "barrier.t1.1",
      pending: ["t1/b1"],
      mode: "all",
      createdAt: new Date().toISOString(),
    });
    await h.store.persist();
  }

  it("status itemizes obligations, owed, barriers, and pending inbox", async () => {
    const h = makeHarness(tmpDir);
    await seedCoordination(h);
    seedEnvelope(h, "t1", { from: "alice", body: "queued while away", id: "alice/n1" });
    const out = runCli(h.dir, "status", "t1");
    assert.match(out, /request to alice #t1\/b1 "build the lexer" .*due in/);
    assert.match(out, /reply to boss for #boss\/q1 "which parser\?"/);
    assert.match(out, /barrier\.t1\.1 \(all\) pending: t1\/b1/);
    assert.match(out, /Inbox pending \(1\):/);
    assert.match(out, /\[note alice→t1 #alice\/n1\]/);
  });

  it("status --json dumps the raw state plus pending inbox", async () => {
    const h = makeHarness(tmpDir);
    await seedCoordination(h);
    const parsed = JSON.parse(runCli(h.dir, "status", "t1", "--json"));
    assert.strictEqual(parsed.id, "t1");
    assert.strictEqual(parsed.barriers.length, 1);
    assert.strictEqual(parsed.owed.length, 1);
    assert.deepStrictEqual(parsed.inboxPending, []);
  });

  it("status errors for an unknown picode", () => {
    makeHarness(tmpDir); // materializes .picode/threads so only the id is missing
    assert.throws(() => runCli(tmpDir, "status", "ghost"));
  });

  it("list table carries coordination-count columns", async () => {
    const h = makeHarness(tmpDir);
    await seedCoordination(h);
    const out = runCli(h.dir, "list");
    assert.match(out, /OBLG\s+OWED\s+BARR\s+INBOX/);
    const row = out.split("\n").find(l => l.startsWith("t1"))!;
    assert.match(row, /1\s+1\s+1\s+0/); // oblg owed barr inbox
  });

  it("send writes a conforming envelope the extension's drain understands end-to-end", async () => {
    const h = makeHarness(tmpDir);
    runCli(h.dir, "send", "t1", "what", "is", "the", "plan?", "--from", "user", "--expects");
    const written = readInboxFile(h, "t1");
    assert.match(written.id, /^user\//);
    assert.strictEqual(written.expects, true);
    assert.strictEqual(written.body, "what is the plan?");
    // The extension side delivers it and records the owed reply — the full
    // C1-to-C3 interop loop, files only.
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.store.owed.length, 1);
    assert.strictEqual(h.store.owed[0].id, written.id);
    assert.strictEqual(h.store.owed[0].from, "user");
  });

  it("send --re settles the loop back: a human reply discharges the picode's obligation shape", async () => {
    const h = makeHarness(tmpDir);
    const send = await h.inbox.sendEnvelope("user", "please review", { expects: true });
    runCli(h.dir, "send", "t1", "looks", "good", "--from", "user", "--re", send.id);
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.store.obligations.length, 0, "obligation discharged by CLI reply");
  });
});

describe("core: toSummary / formatThreadLine coordination counts", () => {
  it("picode_list lines show non-zero coordination counts only", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    h.store.obligations.push({
      id: "t1/b1",
      to: "alice",
      summary: "x",
      sentAt: new Date().toISOString(),
    });
    await h.store.persist();
    const r = await callTool(h, "picode_list");
    const own = (r.details.threads as PicodeSummary[]).find(t => t.id === "t1")!;
    assert.strictEqual(own.obligations, 1);
    assert.strictEqual(own.owed, 0);
    const text = r.content[0].text;
    const ownLine = text.split("\n").find((l: string) => l.startsWith("t1"))!;
    assert.match(ownLine, /obligations=1/);
    assert.doesNotMatch(ownLine, /owed=/);
  });
});

describe("state: restore rules (§11.2)", () => {
  it("done/stopped restore to idle; unknown legacy states settle to open", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.savePicodeState("a", baseState("a", { state: "done", status: "stopped" }));
    // A state.json from a pre-Rev-8 file may carry a state this revision
    // no longer knows (e.g. "listening") — it must settle to open.
    await adapter.savePicodeState("b", {
      ...baseState("b"),
      state: "listening" as unknown as StateFile["state"],
      status: "stopped",
    });

    const stubPi = {
      sendUserMessage: () => {},
      registerTool: () => {},
      registerCommand: () => {},
      getFlag: (name: string) => (name === "picode-id" ? "a" : undefined),
      appendEntry: () => {},
    } as unknown as ExtensionAPI;
    const mkCtx = () =>
      ({
        cwd: tmpDir,
        ui: { setStatus: () => {}, setTitle: () => {} },
        sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
      }) as unknown as ExtensionContext;

    const storeA = createPicodeStore(stubPi);
    await storeA.init(tmpDir, mkCtx());
    assert.strictEqual(storeA.state, "idle");

    const stubPiB = {
      ...stubPi,
      getFlag: (name: string) => (name === "picode-id" ? "b" : undefined),
    } as unknown as ExtensionAPI;
    const storeB = createPicodeStore(stubPiB);
    await storeB.init(tmpDir, mkCtx());
    assert.strictEqual(storeB.state, "open");
  });

  it("debts and barriers survive a restart unconditionally (§13.2)", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.savePicodeState(
      "a",
      baseState("a", {
        state: "open",
        status: "stopped",
        obligations: [{ id: "a/x", to: "bob", summary: "s", sentAt: new Date().toISOString() }],
        owed: [{ id: "boss/q", from: "boss", summary: "?", receivedAt: new Date().toISOString() }],
        barriers: [
          { id: "b1", pending: ["a/x"], mode: "all", createdAt: new Date().toISOString() },
        ],
      }),
    );
    const stubPi = {
      sendUserMessage: () => {},
      registerTool: () => {},
      registerCommand: () => {},
      getFlag: (name: string) => (name === "picode-id" ? "a" : undefined),
      appendEntry: () => {},
    } as unknown as ExtensionAPI;
    const store = createPicodeStore(stubPi);
    await store.init(tmpDir, {
      cwd: tmpDir,
      ui: { setStatus: () => {}, setTitle: () => {} },
      sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    } as unknown as ExtensionContext);
    assert.strictEqual(store.obligations.length, 1);
    assert.strictEqual(store.owed.length, 1);
    assert.strictEqual(store.barriers.length, 1);
  });
});

describe("state: init() enforcement", () => {
  function mkPi(id?: string, role?: string) {
    return {
      sendUserMessage: () => {},
      registerTool: () => {},
      registerCommand: () => {},
      getFlag: (name: string) => {
        if (name === "picode-id" && id) return id;
        if (name === "picode-role" && role) return role;
        return undefined;
      },
      appendEntry: () => {},
    } as unknown as ExtensionAPI;
  }

  function mkCtx(dir: string): ExtensionContext {
    return {
      cwd: dir,
      ui: { setStatus: () => {}, setTitle: () => {} },
      sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
    } as unknown as ExtensionContext;
  }

  it("role defaults to 'worker' when no --picode-role flag is given", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    const store = createPicodeStore(mkPi("new-picode"), adapter);
    await store.init(tmpDir, mkCtx(tmpDir));
    assert.strictEqual(store.role, "worker");
  });

  it("duplicate picode ID: init() throws when another running picode has the same ID", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.savePicodeState(
      "dup",
      baseState("dup", { status: "running", lastSeen: new Date().toISOString() }),
    );
    const store = createPicodeStore(mkPi("dup"), adapter);
    await assert.rejects(() => store.init(tmpDir, mkCtx(tmpDir)), /already exists and is running/);
  });

  it("duplicate picode ID: init() succeeds when existing same-ID picode is stale/stopped", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.savePicodeState(
      "old",
      baseState("old", {
        status: "stopped",
        lastSeen: new Date(Date.now() - STALE_MS - 1000).toISOString(),
      }),
    );
    const store = createPicodeStore(mkPi("old"), adapter);
    await store.init(tmpDir, mkCtx(tmpDir));
    assert.strictEqual(store.picodeId, "old");
  });

  it("singleton coordinator: init() throws when a running coordinator exists", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.savePicodeState(
      "coord1",
      baseState("coord1", {
        role: "coordinator",
        status: "running",
        lastSeen: new Date().toISOString(),
      }),
    );
    const store = createPicodeStore(mkPi("coord2", "coordinator"), adapter);
    await assert.rejects(
      () => store.init(tmpDir, mkCtx(tmpDir)),
      /Coordinator "coord1" already exists/,
    );
  });

  it("singleton coordinator: init() succeeds when existing coordinator is stale/stopped", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.savePicodeState(
      "coord1",
      baseState("coord1", {
        role: "coordinator",
        status: "stopped",
        lastSeen: new Date(Date.now() - STALE_MS - 1000).toISOString(),
      }),
    );
    const store = createPicodeStore(mkPi("coord2", "coordinator"), adapter);
    await store.init(tmpDir, mkCtx(tmpDir));
    assert.strictEqual(store.role, "coordinator");
  });

  it("singleton coordinator: init() succeeds when no other coordinator exists", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    const store = createPicodeStore(mkPi("coord1", "coordinator"), adapter);
    await store.init(tmpDir, mkCtx(tmpDir));
    assert.strictEqual(store.role, "coordinator");
    assert.strictEqual(store.picodeId, "coord1");
  });

  it("shutdown preserves done/on-hold; interrupted states become stopped", async () => {
    // done survives shutdown
    const a1 = createLocalFsAdapter();
    await a1.configure(tmpDir);
    const s1 = createPicodeStore(mkPi("done-picode"), a1);
    await s1.init(tmpDir, mkCtx(tmpDir));
    s1.state = "done";
    await s1.persist();
    await s1.shutdown("quit");
    assert.strictEqual(s1.state, "done");
    assert.strictEqual(s1.status, "stopped");

    // on-hold survives shutdown
    const a2 = createLocalFsAdapter();
    const dir2 = mkdtempSync(join(tmpdir(), "pi-picode-unit-"));
    try {
      await a2.configure(dir2);
      const s2 = createPicodeStore(mkPi("held-picode"), a2);
      await s2.init(dir2, mkCtx(dir2));
      s2.state = "on-hold";
      await s2.persist();
      await s2.shutdown("quit");
      assert.strictEqual(s2.state, "on-hold");
      assert.strictEqual(s2.status, "stopped");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }

    // open (interrupted) → stopped
    const a3 = createLocalFsAdapter();
    const dir3 = mkdtempSync(join(tmpdir(), "pi-picode-unit-"));
    try {
      await a3.configure(dir3);
      const s3 = createPicodeStore(mkPi("open-picode"), a3);
      await s3.init(dir3, mkCtx(dir3));
      s3.state = "open";
      await s3.persist();
      await s3.shutdown("quit");
      assert.strictEqual(s3.state, "stopped");
      assert.strictEqual(s3.status, "stopped");
    } finally {
      rmSync(dir3, { recursive: true, force: true });
    }
  });

  it("init() restores obligations, owed, and barriers from previous state file", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.savePicodeState(
      "t1",
      baseState("t1", {
        status: "stopped",
        obligations: [
          { id: "t1/o1", to: "alice", summary: "task", sentAt: new Date().toISOString() },
        ],
        owed: [
          { id: "boss/q1", from: "boss", summary: "review", receivedAt: new Date().toISOString() },
        ],
        barriers: [
          { id: "b1", pending: ["t1/o1"], mode: "all", createdAt: new Date().toISOString() },
        ],
      }),
    );
    const store = createPicodeStore(mkPi("t1"), adapter);
    await store.init(tmpDir, mkCtx(tmpDir));
    assert.strictEqual(store.obligations.length, 1);
    assert.strictEqual(store.owed.length, 1);
    assert.strictEqual(store.barriers.length, 1);
    assert.strictEqual(store.obligations[0].id, "t1/o1");
    assert.strictEqual(store.owed[0].id, "boss/q1");
    assert.strictEqual(store.barriers[0].id, "b1");
  });
});

describe("core: toSummary() stale marking", () => {
  it("marks status as stopped when lastSeen is past STALE_MS", () => {
    const fresh = toSummary(baseState("fresh", { lastSeen: new Date().toISOString() }));
    assert.strictEqual(fresh.status, "running");
    const stale = toSummary(
      baseState("stale", { lastSeen: new Date(Date.now() - STALE_MS - 1000).toISOString() }),
    );
    assert.strictEqual(stale.status, "stopped");
  });

  it("stale status override does not mutate the stored state field", () => {
    const s = toSummary(
      baseState("ghost", {
        state: "open",
        lastSeen: new Date(Date.now() - STALE_MS - 5000).toISOString(),
      }),
    );
    assert.strictEqual(s.state, "open");
    assert.strictEqual(s.status, "stopped");
  });
});

describe("state: watcher idempotency", () => {
  it("startWatcher twice keeps exactly one live watch; stopWatcher is idempotent", () => {
    let active = 0;
    const counting: StorageAdapter = {
      ...createFakeAdapter(),
      watchInbox() {
        active++;
        return () => active--;
      },
    };
    const stubPi = {
      sendUserMessage: () => {},
      registerTool: () => {},
      registerCommand: () => {},
    } as unknown as ExtensionAPI;
    const store = createPicodeStore(stubPi, counting);
    store.picodeId = "w1";
    const ctx = { ui: { setStatus: () => {}, setTitle: () => {} } } as unknown as ExtensionContext;
    store.startWatcher(() => {}, ctx);
    store.startWatcher(() => {}, ctx); // e.g. a second session_start
    assert.strictEqual(active, 1);
    store.stopWatcher();
    assert.strictEqual(active, 0);
    store.stopWatcher();
    assert.strictEqual(active, 0);
  });
});

describe("journal: compaction (auto at 500 entries)", () => {
  it("JOURNAL_COMPACT_THRESHOLD is 500", () => {
    assert.strictEqual(JOURNAL_COMPACT_THRESHOLD, 500);
  });
  it("JOURNAL_COMPACT_KEEP_RECENT is 100", () => {
    assert.strictEqual(JOURNAL_COMPACT_KEEP_RECENT, 100);
  });
  it("JOURNAL_COMPACT_COOLDOWN_MS is 24h", () => {
    assert.strictEqual(JOURNAL_COMPACT_COOLDOWN_MS, 24 * 60 * 60 * 1000);
  });

  it("isCompactionEntry detects the marker at the start of an entry", () => {
    assert.strictEqual(isCompactionEntry("<!-- COMPACTION 2026-01-15 10:30 -->\nsummary"), true);
    assert.strictEqual(isCompactionEntry("\n<!-- COMPACTION 2026-01-15 10:30 -->"), true);
  });
  it("isCompactionEntry returns false for regular journal entries", () => {
    assert.strictEqual(isCompactionEntry("<!-- 2026-01-15 10:30 -->\nWorking on: x"), false);
    assert.strictEqual(isCompactionEntry("Working on: x\nDone: y"), false);
  });

  it("decideCompaction returns null when entries are under the threshold", () => {
    const entries = Array.from({ length: 100 }, (_, i) => `<!-- ${i} -->\nentry ${i}`);
    const content = entries.join("\n");
    assert.strictEqual(decideCompaction(content), null);
  });

  it("decideCompaction splits oldest from newest when over the threshold", () => {
    const entries = Array.from({ length: 510 }, (_, i) => `<!-- ${i} -->\nentry ${i}`);
    const content = entries.join("\n");
    const plan = decideCompaction(content, Date.now());
    assert.ok(plan);
    assert.strictEqual(plan.toSummarize.length, 510 - JOURNAL_COMPACT_KEEP_RECENT);
    assert.strictEqual(plan.toKeep.length, JOURNAL_COMPACT_KEEP_RECENT);
    // First summarized entry is index 0; first kept is the boundary.
    assert.ok(plan.toSummarize[0].startsWith("<!-- 0 -->"));
    assert.ok(plan.toKeep[0].startsWith(`<!-- ${510 - JOURNAL_COMPACT_KEEP_RECENT} -->`));
    assert.ok(plan.toKeep[plan.toKeep.length - 1].startsWith("<!-- 509 -->"));
  });

  it("decideCompaction returns null when a recent COMPACTION marker is within cooldown", () => {
    const recent = new Date(Date.now() - 60_000); // 1 minute ago
    const ts = recent.toISOString().slice(0, 16).replace("T", " ");
    const entries = [
      ...Array.from({ length: 509 }, (_, i) => `<!-- ${i} -->\nentry ${i}`),
      `<!-- COMPACTION ${ts} -->\nold summary`,
    ];
    const plan = decideCompaction(entries.join("\n"), Date.now());
    assert.strictEqual(plan, null, "cooldown must suppress back-to-back compactions");
  });

  it("decideCompaction returns a plan when the last COMPACTION marker is older than cooldown", () => {
    const longAgo = new Date(Date.now() - JOURNAL_COMPACT_COOLDOWN_MS - 60_000);
    const ts = longAgo.toISOString().slice(0, 16).replace("T", " ");
    const entries = [
      ...Array.from({ length: 509 }, (_, i) => `<!-- ${i} -->\nentry ${i}`),
      `<!-- COMPACTION ${ts} -->\nancient summary`,
    ];
    const plan = decideCompaction(entries.join("\n"), Date.now());
    assert.ok(plan, "cooldown expired — must compact again");
  });
});

describe("local-fs: journal lock and setJournal", () => {
  it("acquireJournalLock succeeds on a free picode dir", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    mkdirSync(join(tmpDir, ".picode", "picodes", "lock1"), { recursive: true });
    await adapter.acquireJournalLock!("lock1");
    assert.ok(existsSync(join(tmpDir, ".picode", "picodes", "lock1", "journal.lock")));
    await adapter.releaseJournalLock!("lock1");
    assert.ok(!existsSync(join(tmpDir, ".picode", "picodes", "lock1", "journal.lock")));
  });

  it("acquireJournalLock throws after exhausting retries on a stuck (fresh) lock", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    mkdirSync(join(tmpDir, ".picode", "picodes", "lock2"), { recursive: true });
    // Place a fresh lock — well under the 10s stale cutoff — that this
    // process can't see (simulated by writing the file with a future mtime).
    const lockPath = join(tmpDir, ".picode", "picodes", "lock2", "journal.lock");
    writeFileSync(lockPath, "");
    const future = new Date(Date.now() + 60_000);
    utimesSync(lockPath, future, future);
    await assert.rejects(() => adapter.acquireJournalLock!("lock2"), /after 40 retries/);
  });

  it("acquireJournalLock unlinks a stale (old) lock and acquires", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    mkdirSync(join(tmpDir, ".picode", "picodes", "lock3"), { recursive: true });
    const lockPath = join(tmpDir, ".picode", "picodes", "lock3", "journal.lock");
    writeFileSync(lockPath, "");
    const past = new Date(Date.now() - 30_000);
    utimesSync(lockPath, past, past);
    await adapter.acquireJournalLock!("lock3");
    assert.ok(existsSync(lockPath));
    await adapter.releaseJournalLock!("lock3");
  });

  it("setJournal writes atomically and overwrites existing content", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.appendJournal!("sj", "\n<!-- 2026-01-15 10:00 -->\nfirst\n");
    await adapter.setJournal!("sj", "\n<!-- 2026-01-15 11:00 -->\nsecond\n");
    const content = await adapter.readJournal!("sj");
    assert.ok(content?.includes("second"));
    assert.ok(!content?.includes("first"), "old content must be replaced");
  });

  it("appendJournal acquires and releases the lock", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.appendJournal!("lock4", "\n<!-- ts -->\nx\n");
    assert.ok(!existsSync(join(tmpDir, ".picode", "picodes", "lock4", "journal.lock")));
  });
});

describe("commands: /picode-journal", () => {
  it("no args shows the last 12 entries", async () => {
    const h = makeHarness(tmpDir);
    const entries = Array.from({ length: 20 }, (_, i) => journalEntry(nowStamp(), `task ${i}`));
    writeJournal(h, "t1", entries.join(""));
    await callCommand(h, "/picode-journal");
    const text = h.notifications.at(-1)!.text;
    // Last entry must be visible, first must not.
    assert.match(text, /Working on: task 19/);
    assert.doesNotMatch(text, /Working on: task 0/);
  });

  it("status reports entry count, size, oldest and newest timestamps", async () => {
    const h = makeHarness(tmpDir);
    writeJournal(h, "t1", journalEntry(nowStamp(), "first") + journalEntry(nowStamp(), "last"));
    await callCommand(h, "/picode-journal", "status");
    const text = h.notifications.at(-1)!.text;
    assert.match(text, /2 entries/);
    assert.match(text, /bytes/);
    assert.match(text, /oldest/);
    assert.match(text, /newest/);
  });

  it("tail N shows exactly N most-recent entries", async () => {
    const h = makeHarness(tmpDir);
    const entries = Array.from({ length: 5 }, (_, i) => journalEntry(nowStamp(), `t${i}`));
    writeJournal(h, "t1", entries.join(""));
    await callCommand(h, "/picode-journal", "tail 2");
    const text = h.notifications.at(-1)!.text;
    assert.match(text, /Working on: t4/);
    assert.doesNotMatch(text, /Working on: t0/);
  });

  it("trim N keeps only the last N entries (no fork)", async () => {
    const h = makeHarness(tmpDir);
    const entries = Array.from({ length: 10 }, (_, i) => journalEntry(nowStamp(), `task ${i}`));
    writeJournal(h, "t1", entries.join(""));
    await callCommand(h, "/picode-journal", "trim 3");
    const content = await h.store.adapter.readJournal!("t1");
    assert.match(h.notifications.at(-1)!.text, /Trimmed: 10 → 3/);
    // Most recent 3 must survive.
    assert.match(content!, /Working on: task 9/);
    assert.match(content!, /Working on: task 7/);
    assert.doesNotMatch(content!, /Working on: task 0/);
  });

  it("clear deletes the journal", async () => {
    const h = makeHarness(tmpDir);
    writeJournal(h, "t1", journalEntry(nowStamp(), "stuff"));
    assert.ok(existsSync(join(h.store.picodeDir, "journal.md")));
    await callCommand(h, "/picode-journal", "clear");
    assert.ok(!existsSync(join(h.store.picodeDir, "journal.md")));
  });

  it("refuses to run when the picode never activated (opt-in gate)", async () => {
    const h = makeHarness(tmpDir);
    h.store.picodeId = "";
    await callCommand(h, "/picode-journal", "status");
    assert.match(h.notifications[0].text, /hasn't opted into picode/);
  });
});

describe("lifecycle: extractFirstLine (current-task widget)", () => {
  it("strips markdown bold from the first non-empty line", () => {
    assert.equal(
      extractFirstLine("**Objective:** Do the thing.\n\n## Context\nmore"),
      "Objective: Do the thing.",
    );
  });

  it("strips markdown headers", () => {
    assert.equal(extractFirstLine("## Context\n\nbody"), "Context");
    assert.equal(extractFirstLine("# Header"), "Header");
  });

  it("returns the first non-empty line when there is no markdown", () => {
    assert.equal(extractFirstLine("hello\nworld"), "hello");
  });

  it("skips leading blank lines", () => {
    assert.equal(extractFirstLine("\n\nactual line"), "actual line");
  });

  it("falls back to first 80 chars when every line strips to empty", () => {
    const long = "x".repeat(100);
    assert.equal(extractFirstLine("#\n**\n" + long), long.slice(0, 80));
  });

  it("truncates to 80 chars when the first line is longer", () => {
    assert.equal(extractFirstLine("x".repeat(100)), "x".repeat(80));
  });

  it("returns empty string for empty body", () => {
    assert.equal(extractFirstLine(""), "");
  });

  it("handles a realistic picode_send task body", () => {
    const body =
      "**Objective:** Add a current-task widget.\n\n## Context\nUser wants workers to see their task.\n\n## Steps\n1. Implement\n2. Test";
    assert.equal(extractFirstLine(body), "Objective: Add a current-task widget.");
  });
});

describe("core/time: deadlineFromSeconds", () => {
  it("returns an ISO string parseable as the default 15 min in the future", () => {
    const before = Date.now();
    const iso = deadlineFromSeconds();
    const parsed = new Date(iso).getTime();
    const DEFAULT_MS = 15 * 60_000;
    // Within a small tolerance (the function captured `now` once at call).
    assert.ok(
      parsed >= before + DEFAULT_MS - 50,
      `parsed ${parsed} before ${before} + ${DEFAULT_MS}`,
    );
    assert.ok(parsed <= before + DEFAULT_MS + 50);
  });

  it("60 seconds → 60_000 ms in the future", () => {
    const before = Date.now();
    const iso = deadlineFromSeconds(60);
    const parsed = new Date(iso).getTime();
    assert.ok(parsed >= before + 60_000 - 50);
    assert.ok(parsed <= before + 60_000 + 50);
  });

  it("explicit undefined matches the default", () => {
    const a = deadlineFromSeconds();
    const b = deadlineFromSeconds(undefined);
    const DEFAULT_MS = 15 * 60_000;
    const aMs = new Date(a).getTime();
    const bMs = new Date(b).getTime();
    assert.ok(Math.abs(aMs - bMs) < 50, `a-b = ${aMs - bMs}ms`);
    assert.ok(Math.abs(aMs - (Date.now() + DEFAULT_MS)) < 50);
  });

  it("zero throws RangeError (would otherwise be already-expired)", () => {
    assert.throws(() => deadlineFromSeconds(0), RangeError);
  });

  it("negative throws RangeError (would otherwise be already-expired)", () => {
    assert.throws(() => deadlineFromSeconds(-5), RangeError);
    assert.throws(() => deadlineFromSeconds(-0.0001), RangeError);
  });
});

describe("system-prompt: picode_send contract is in every worker template", () => {
  // Regression guard: the contract must live in the shared worker base
  // block so it reaches builder, reviewer, explorer, tester, designer,
  // bug-hunter, scout via the single WORKER_BASE_RULES + SUBTYPE_PROMPTS
  // composition. If someone refactors and drops the block, the next
  // worker will answer in plain text and the coordinator will go silent.
  //
  // Prompts now live in src/prompts/*.md files.
  const workerBase = readFileSync(
    new URL("../src/prompts/worker-base.md", import.meta.url),
    "utf-8",
  );
  const coordinator = readFileSync(
    new URL("../src/prompts/coordinator.md", import.meta.url),
    "utf-8",
  );
  it("WORKER_BASE_RULES mentions the communication contract and 'picode_send' reply path", () => {
    assert.ok(
      workerBase.includes("Communication contract"),
      "missing 'Communication contract' header",
    );
    assert.ok(
      workerBase.includes("reaches ONLY the human user"),
      "missing plain-text-only warning",
    );
    assert.ok(
      workerBase.includes("Use `picode_send` for everything"),
      "missing 'Use picode_send for everything' bullet",
    );
  });
  it("COORDINATOR_RULES has the silent-recovery rule", () => {
    assert.match(coordinator, /Worker silent\? Check their pane/);
    assert.ok(
      coordinator.includes("answered in plain text instead of via"),
      "silent-recovery rule must mention the plain-text mistake",
    );
  });
});

describe("tools/messaging: checkBodySize (picode_send body-size guard)", () => {
  it("body just under the limit is accepted", () => {
    const body = "x".repeat(MAX_BODY_BYTES - 1);
    assert.equal(checkBodySize(body), null);
  });

  it("body at exactly the limit is accepted (boundary inclusive)", () => {
    const body = "x".repeat(MAX_BODY_BYTES);
    assert.equal(checkBodySize(body), null);
  });

  it("body one byte over the limit is rejected with a helpful message", () => {
    const body = "x".repeat(MAX_BODY_BYTES + 1);
    const msg = checkBodySize(body);
    assert.ok(msg, "expected an error message");
    // Reports actual size and limit so the caller knows what to reduce.
    assert.match(msg!, new RegExp(String(MAX_BODY_BYTES + 1)));
    assert.match(msg!, new RegExp(String(MAX_BODY_BYTES)));
    assert.match(msg!, /Split into multiple sends/);
  });

  it("counts UTF-8 bytes, not characters (emoji at the boundary)", () => {
    // Each 😀 is 4 UTF-8 bytes. A body of MAX_BODY_BYTES/4 + 1 emoji
    // exceeds the byte limit by a single byte — IF the guard counts
    // bytes (not chars/surrogate pairs). The preflight confirms the
    // setup: bytes must exceed the limit and a single char must be
    // multi-byte in UTF-8.
    const emoji = "\u{1F600}"; // 😀 — 4 bytes in UTF-8
    const count = Math.floor(MAX_BODY_BYTES / 4) + 1; // guaranteed over by bytes
    const body = emoji.repeat(count);
    const bytes = Buffer.byteLength(body, "utf8");
    assert.ok(bytes > MAX_BODY_BYTES, `preflight: bytes=${bytes} should exceed ${MAX_BODY_BYTES}`);
    assert.ok(bytes > (4 * count) / 2, "preflight: emoji must be multi-byte in UTF-8");
    const msg = checkBodySize(body);
    assert.ok(msg, "emoji body over the byte limit must be rejected");
  });

  it("empty body is trivially accepted", () => {
    assert.equal(checkBodySize(""), null);
  });
});
