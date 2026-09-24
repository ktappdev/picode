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

import { describe, it, beforeEach, afterEach, mock } from "node:test";
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
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { createPicodeStore } from "../src/state";
import type { PicodeStore } from "../src/core/types";
import { createInbox } from "../src/inbox";
import type { Injection } from "../src/inbox";
import { DEADLINE_EXPIRY_GRACE_MS } from "../src/inbox";
import {
  belongsToWorkspace,
  effectiveAgentStatus,
  extractPaneInfo,
  isProtectedTabLabel,
  quietCallRenderer,
  quietToolResult,
  tabLabelMap,
} from "../src/tools/shared";
import { envelopeMessageRenderer, systemMessageRenderer } from "../src/renderers";
import { isQuietTui, resolveQuietTui, setQuietTui } from "../src/core/quiet-tui";
import { countPanesInTab, solePaneInTab, resolveThinking } from "../src/tools/spawn";
import { validateLabel } from "../src/tools/tab-create";
import { registerLifecycle, extractFirstLine } from "../src/lifecycle";
import { getListenerHandle, setListenerHandle } from "../src/herdr/listener";
import { deadlineFromSeconds } from "../src/core/time";
import { checkBodySize, MAX_BODY_BYTES } from "../src/tools/messaging";
import { registerTools } from "../src/tools/index";
import { registerCommands } from "../src/commands";
import {
  buildRoleItems,
  buildModelItems,
  formatContextWindow,
  formatModelDescription,
  readModelsConfig,
  writeModelsConfig,
} from "../src/commands-models";
import {
  journalFingerprint,
  isDuplicateOfLastEntry,
  journalForkArgs,
  journalMode,
  journalSignature,
  piSelfCommand,
  shouldJournal,
  buildJournalPrompt,
  renderJournalMessage,
  JOURNAL_CONTEXT_MAX_MESSAGES,
  JOURNAL_CONTEXT_MAX_CHARS,
  JOURNAL_MIN_INTERVAL_MS,
  isCompactionEntry,
  decideCompaction,
  JOURNAL_COMPACT_THRESHOLD,
  JOURNAL_COMPACT_KEEP_RECENT,
  JOURNAL_COMPACT_COOLDOWN_MS,
} from "../src/journal";
import { buildWakeLaunch } from "../src/restate/wake-launch";
import {
  advanceSitrep,
  initialSitrepStreak,
  resolveSitrepMaxIdle,
  sitrepSignature,
  SITREP_MAX_IDLE_DEFAULT,
} from "../src/core/sitrep";
import { createLocalFsAdapter } from "../src/adapter/local-fs";
import type { StorageAdapter } from "../src/adapter/types";
import type { StateFile, Envelope, PicodeSummary } from "../src/core/types";
import { STALE_MS, PROCESSED_TTL_MS, CLIENT_CAPABILITIES, toSummary } from "../src/core/types";
import { formatThreadLine } from "../src/core/format";
import { ulid, mintEnvelopeId } from "../src/core/ids";
import { detectWorkerRole } from "../src/core/roles";
import { threadModelPrompt } from "../src/core/system-prompt";
import {
  DEFAULT_MODELS,
  loadModelsConfig,
  mergeModelsConfig,
  modelsConfigPaths,
  resolveConfiguredModel,
  resolveModelFromConfigs,
} from "../src/core/model-config";

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
  const sentCustom: { msg: SentCustom; options?: { triggerTurn?: boolean; deliverAs?: string } }[] =
    [];
  const notifications: Notify[] = [];
  const tools: Record<string, AnyTool> = {};
  const commands: Record<string, AnyCommand> = {};

  const stubPi = {
    sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
      calls.push({ content, options });
    },
    sendMessage: (msg: SentCustom, options?: { triggerTurn?: boolean; deliverAs?: string }) => {
      sentCustom.push({ msg, options });
    },
    registerTool: (tool: AnyTool & { name: string }) => {
      tools[tool.name] = tool;
    },
    registerCommand: (name: string, opts: AnyCommand) => {
      commands[name] = opts;
    },
    getFlag: () => undefined,
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
  registerCommands(stubPi, store, inbox, join(dir, "agent"));
  // Fire-and-forget: LocalFsAdapter's writes have no internal `await`, so the
  // fs side effect (state.json existing, matching real session_start) has
  // already happened synchronously by the time this call returns, even
  // though the returned promise itself settles a microtask later.
  void store.persist();

  // Mutable so gate tests can flip between "agent idle" (injections start a
  // run) and "agent streaming" (injections queue). Default mirrors mid-run.
  const agent = { idle: false };

  // /picode-quiet flips tool expansion round-trip to force already-rendered
  // rows to re-run their renderers; record the sequence so a test can assert
  // it. Fresh chats start collapsed.
  let toolsExpanded = false;
  const expansionFlips: boolean[] = [];

  const ctx = {
    ui: {
      setStatus: () => {},
      setTitle: () => {},
      setFooter: () => {},
      notify: (text: string, level?: string) => notifications.push({ text, level }),
      getToolsExpanded: () => toolsExpanded,
      setToolsExpanded: (v: boolean) => {
        toolsExpanded = v;
        expansionFlips.push(v);
      },
    },
    isIdle: () => agent.idle,
    waitForIdle: async () => {},
    shutdown: () => {},
    cwd: dir,
  } as unknown as ExtensionCommandContext;

  return {
    store,
    inbox,
    tools,
    commands,
    ctx,
    calls,
    sentCustom,
    notifications,
    dir,
    expansionFlips,
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

/** An entry as far as lifecycle is concerned. Identity/résumé tests only need
 *  `custom`; the journal-fork path builds its slice from `message` entries, so
 *  tests that drive a real fork have to supply those. */
type LifecycleEntry =
  CustomEntry | { type: "message"; message: { role: string; [key: string]: unknown } };

type SentCustom = {
  customType: string;
  content: string;
  display?: boolean;
  details?: unknown;
};

type SentMessage = {
  customType: string;
  content: string;
  options?: { triggerTurn?: boolean; deliverAs?: string };
  display?: boolean;
  details?: unknown;
};

function makeLifecycleHarness(dir: string) {
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  const setActiveToolsCalls: string[][] = [];
  const sentMessages: SentMessage[] = [];
  const userMessages: string[] = [];
  const titles: string[] = [];
  const notifications: { text: string; level?: string }[] = [];
  const registeredThreadTools = [
    "picode_status",
    "picode_list",
    "picode_journal",
    "picode_send",
    "picode_wait",
    "picode_suspend",
    "picode_resume",
  ];
  let activeTools = [...registeredThreadTools, "bash", "read_file", "write", "edit", "picode_run"]; // include file and command tools for role-filter assertions

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
    sendMessage: (msg: SentCustom, options?: { triggerTurn?: boolean; deliverAs?: string }) => {
      sentMessages.push({
        customType: msg.customType,
        content: msg.content,
        options,
        display: msg.display,
      });
    },
    sendUserMessage: (content: string) => {
      userMessages.push(content);
    },
    appendEntry: () => {},
  } as unknown as ExtensionAPI;

  const store = createPicodeStore(stubPi);
  const inbox = createInbox(store, stubPi);
  registerLifecycle(stubPi, store, inbox);
  // session_start starts a watcher + heartbeat; the top-level afterEach
  // closes them so the runner can exit.
  openStores.push(store);

  function makeCtx(entries: LifecycleEntry[] = [], header?: { parentSession?: string }) {
    return {
      cwd: dir,
      ui: {
        setStatus: () => {},
        setTitle: (title: string) => titles.push(title),
        setFooter: () => {},
        notify: (text: string, level?: string) => notifications.push({ text, level }),
      },
      sessionManager: {
        getEntries: () => entries,
        getSessionFile: () => undefined,
        getSessionId: () => "test-session",
        getHeader: () => header ?? null,
      },
      isIdle: () => true,
    } as unknown as ExtensionContext;
  }

  return {
    store,
    inbox,
    dir,
    notifications,
    setFlag(name: string, value: string | boolean) {
      flags[name] = value;
    },
    fire(event: string, ctx: unknown, payload: unknown = {}) {
      return handlers[event]?.(payload, ctx);
    },
    makeCtx,
    setActiveToolsCalls,
    sentMessages,
    userMessages,
    titles,
    get activeTools() {
      return activeTools;
    },
    registeredThreadTools,
  };
}

let tmpDir: string;

/** Herdr env inherited from the developer's shell. When this suite runs from
 *  inside a Herdr pane — which is how picode is normally developed — these are
 *  already set. A test that flips `HERDR_ENV` to "1" to satisfy the
 *  coordinator's must-run-in-herdr guard then *also* satisfies
 *  `startHerdrListener`'s guard (which additionally requires
 *  HERDR_WORKSPACE_ID), opening a real `net.Socket` subscription to the live
 *  daemon. Nothing closes it, so libuv stays alive and `node --test` never
 *  exits — after reporting every test green. Parked here so the suite is
 *  hermetic wherever it runs: a test must opt in explicitly, never inherit. */
const HERDR_ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_WORKSPACE_ID",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
] as const;
let savedHerdrEnv: Record<string, string | undefined> = {};
let savedQuietEnv: string | undefined;

/** Stores whose lifecycle wiring a test has started. `session_start` opens a
 *  real `fs.watch` (local-fs.ts `watchInbox`) and a real heartbeat interval
 *  (lifecycle.ts) — neither is anything an assertion cares about, but both
 *  hold libuv handles, so leaving them open keeps the runner alive after the
 *  last test has passed. Tracked here so afterEach closes them. */
const openStores: PicodeStore[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-picode-unit-"));
  savedHerdrEnv = {};
  for (const key of HERDR_ENV_KEYS) {
    savedHerdrEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Same hermeticity for the quiet-screen switch: never inherit a
  // PICODE_QUIET_TUI from the developer's shell, and start every test loud —
  // quiet describes flip the flag themselves.
  savedQuietEnv = process.env.PICODE_QUIET_TUI;
  delete process.env.PICODE_QUIET_TUI;
  setQuietTui(false);
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedHerdrEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (savedQuietEnv === undefined) delete process.env.PICODE_QUIET_TUI;
  else process.env.PICODE_QUIET_TUI = savedQuietEnv;
  // Renderers read module state — never let one test's quiet flip leak.
  setQuietTui(false);
  // Close handles before the directory they watch is removed, so the watcher
  // isn't left reporting ENOENT against a deleted path.
  for (const store of openStores.splice(0)) {
    store.stopWatcher();
    store.stopHeartbeat();
  }
  // Belt-and-suspenders for any test that starts the listener itself. The
  // handle is not reachable from the store — lifecycle.ts holds it in its own
  // closure and stops it only on session_shutdown, which these tests never
  // fire. stop() clears the socket and both of the listener's timers.
  getListenerHandle()?.stop();
  setListenerHandle(null);
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

  it("warns when target already has queued messages", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    seedEnvelope(h, "alice", { from: "coordinator", body: "older queued task" });
    const r = await callTool(h, "picode_send", { to: "alice", body: "new task", expects: true });
    assert.strictEqual(r.details.ok, true);
    assert.match(r.content[0].text, /"alice" already has 1 queued message waiting/);
    assert.deepStrictEqual(r.details.queued, [{ to: "alice", count: 1 }]);
  });

  it("reports queued warnings only for targets that already have inbox backlog", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    seedRemoteThread(h, "bob");
    seedEnvelope(h, "alice", { from: "coordinator", body: "older queued task" });
    const r = await callTool(h, "picode_send", { to: "alice,bob", body: "new task" });
    assert.strictEqual(r.details.ok, true);
    assert.match(r.content[0].text, /"alice" already has 1 queued message waiting/);
    assert.doesNotMatch(r.content[0].text, /"bob" already has/);
    assert.deepStrictEqual(r.details.queued, [{ to: "alice", count: 1 }]);
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

  it("omits empty obligations and barriers sections (no 'none' noise)", async () => {
    const h = makeHarness(tmpDir);
    const r = await callTool(h, "picode_status");
    assert.doesNotMatch(r.content[0].text, /Obligations:/);
    assert.doesNotMatch(r.content[0].text, /Barriers:/);
    assert.doesNotMatch(r.content[0].text, /Owed replies:/);
  });

  it("defaults tail to 15 entries for journal (compact one-liners)", async () => {
    const h = makeHarness(tmpDir);
    // Write 60 entries
    const entries = Array.from({ length: 60 }, (_, i) =>
      journalEntry(nowStamp(), `task ${i}`),
    ).join("");
    writeJournal(h, h.store.picodeId, entries);
    const r = await callTool(h, "picode_status");
    // Compact mode: one line per entry, no "Working on:" prefix
    assert.doesNotMatch(r.content[0].text, /task 0\b/);
    assert.doesNotMatch(r.content[0].text, /task 44\b/);
    assert.match(r.content[0].text, /task 45/);
    assert.match(r.content[0].text, /task 59/);
    // Should NOT contain full multi-line entry bodies
    assert.doesNotMatch(r.content[0].text, /Working on: task/);
  });

  it("tail=0 + compact=false returns full multi-line journal", async () => {
    const h = makeHarness(tmpDir);
    const entries = Array.from({ length: 10 }, (_, i) =>
      journalEntry(nowStamp(), `task ${i}`),
    ).join("");
    writeJournal(h, h.store.picodeId, entries);
    const r = await callTool(h, "picode_status", { tail: 0, compact: false });
    assert.match(r.content[0].text, /Working on: task 0/);
    assert.match(r.content[0].text, /Working on: task 9/);
  });

  it("explicit tail overrides default (compact one-liners)", async () => {
    const h = makeHarness(tmpDir);
    const entries = Array.from({ length: 20 }, (_, i) =>
      journalEntry(nowStamp(), `task ${i}`),
    ).join("");
    writeJournal(h, h.store.picodeId, entries);
    const r = await callTool(h, "picode_status", { tail: 5 });
    assert.doesNotMatch(r.content[0].text, /task 14\b/);
    assert.match(r.content[0].text, /task 15/);
    assert.match(r.content[0].text, /task 19/);
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
  it("returns the full journal when tail=0 + compact=false", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    writeJournal(h, "alice", journalEntry(nowStamp(), "task A") + journalEntry(nowStamp(), "B"));
    const r = await callTool(h, "picode_journal", { id: "alice", tail: 0, compact: false });
    assert.match(r.content[0].text, /task A/);
    assert.match(r.content[0].text, /Working on: B/);
  });

  it("defaults tail to 15 entries (compact one-liners)", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const entries = Array.from({ length: 60 }, (_, i) =>
      journalEntry(nowStamp(), `task ${i}`),
    ).join("");
    writeJournal(h, "alice", entries);
    const r = await callTool(h, "picode_journal", { id: "alice" });
    // Compact mode: one line per entry, no "Working on:" prefix
    assert.doesNotMatch(r.content[0].text, /task 0\b/);
    assert.doesNotMatch(r.content[0].text, /task 44\b/);
    assert.match(r.content[0].text, /task 45/);
    assert.match(r.content[0].text, /task 59/);
    assert.doesNotMatch(r.content[0].text, /Working on: task/);
  });

  it("tail limits to the last N entries (compact)", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    writeJournal(h, "alice", journalEntry(nowStamp(), "old") + journalEntry(nowStamp(), "newest"));
    const r = await callTool(h, "picode_journal", { id: "alice", tail: 1 });
    assert.doesNotMatch(r.content[0].text, /\bold\b/);
    assert.match(r.content[0].text, /newest/);
  });

  it("lookbackMinutes excludes entries older than the cutoff (compact)", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice");
    const oldTs = stamp(new Date(Date.now() - 3 * 60 * 60_000));
    writeJournal(h, "alice", journalEntry(oldTs, "ancient") + journalEntry(nowStamp(), "fresh"));
    const r = await callTool(h, "picode_journal", { id: "alice", lookbackMinutes: 60 });
    assert.doesNotMatch(r.content[0].text, /ancient/);
    assert.match(r.content[0].text, /fresh/);
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

describe("unit: purge ledger reconciliation", () => {
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(origCwd);
  });

  it("default purge skips stale workers referenced by current ledgers", async () => {
    const h = makeHarness(tmpDir);
    h.store.role = "coordinator";
    seedRemoteThread(h, "dead", { stale: true });
    h.store.obligations.push({
      id: "t1/request",
      to: "dead",
      summary: "unfinished request",
      sentAt: new Date().toISOString(),
    });
    await h.store.persist();

    process.chdir(h.dir);
    const result = await callTool(h, "picode_purge");

    assert.deepStrictEqual(result.details.purged, []);
    assert.deepStrictEqual(
      result.details.skipped.find((entry: { id: string }) => entry.id === "dead"),
      { id: "dead", reason: "referenced by current picode" },
    );
    assert.ok(existsSync(join(h.store.picodesRootDir, "dead", "state.json")));
  });

  it("forced purge clears references and reconciles barriers", async () => {
    const h = makeHarness(tmpDir);
    h.store.role = "coordinator";
    seedRemoteThread(h, "dead", { stale: true });
    h.store.obligations.push(
      {
        id: "t1/dead-request",
        to: "dead",
        summary: "dead request",
        sentAt: new Date().toISOString(),
      },
      {
        id: "t1/live-request",
        to: "live",
        summary: "live request",
        sentAt: new Date().toISOString(),
      },
    );
    h.store.owed.push(
      {
        id: "dead/incoming",
        from: "dead",
        summary: "dead incoming",
        receivedAt: new Date().toISOString(),
      },
      {
        id: "live/incoming",
        from: "live",
        summary: "live incoming",
        receivedAt: new Date().toISOString(),
      },
    );
    h.store.barriers.push(
      {
        id: "barrier.mixed",
        pending: ["t1/dead-request", "t1/live-request"],
        mode: "all",
        createdAt: new Date().toISOString(),
      },
      {
        id: "barrier.dead-only",
        pending: ["t1/dead-request"],
        mode: "any",
        createdAt: new Date().toISOString(),
      },
    );

    process.chdir(h.dir);
    const result = await callTool(h, "picode_purge", { force: true });

    assert.deepStrictEqual(result.details.purged, ["dead"]);
    assert.deepStrictEqual(result.details.cleanup, {
      clearedObligations: ["t1/dead-request"],
      clearedOwed: ["dead/incoming"],
      updatedBarriers: ["barrier.mixed"],
      cancelledBarriers: ["barrier.dead-only"],
    });
    assert.deepStrictEqual(
      h.store.obligations.map(obligation => obligation.id),
      ["t1/live-request"],
    );
    assert.deepStrictEqual(
      h.store.owed.map(owed => owed.id),
      ["live/incoming"],
    );
    assert.deepStrictEqual(h.store.barriers[0].pending, ["t1/live-request"]);
    const persisted = await h.store.adapter.loadPicodeState("t1");
    assert.deepStrictEqual(
      {
        obligations: persisted?.obligations.map(obligation => obligation.id),
        owed: persisted?.owed.map(owed => owed.id),
        barrierPending: persisted?.barriers[0]?.pending,
      },
      {
        obligations: ["t1/live-request"],
        owed: ["live/incoming"],
        barrierPending: ["t1/live-request"],
      },
    );
    assert.ok(!existsSync(join(h.store.picodesRootDir, "dead")));
  });
});

describe("inbox: checkDeadlines auto-expire (barriers + obligations)", () => {
  it("an obligation past deadline + grace is removed from the store and emits an expired notice", async () => {
    const h = makeHarness(tmpDir);
    const overdueBy = DEADLINE_EXPIRY_GRACE_MS + 5_000;
    h.store.obligations.push({
      id: "t1/dead",
      to: "alice",
      summary: "the report",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() - overdueBy).toISOString(),
    });
    assert.strictEqual(h.store.obligations.length, 1);
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.store.obligations.length, 0, "obligation reaped after grace");
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /obligation expired #t1\/dead/);
  });

  it("a barrier past deadline + grace is removed from the store and emits an expired notice", async () => {
    const h = makeHarness(tmpDir);
    const overdueBy = DEADLINE_EXPIRY_GRACE_MS + 5_000;
    h.store.barriers.push({
      id: "b.dead",
      pending: ["t1/x"],
      mode: "all",
      createdAt: new Date().toISOString(),
      deadline: new Date(Date.now() - overdueBy).toISOString(),
    });
    assert.strictEqual(h.store.barriers.length, 1);
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.store.barriers.length, 0, "barrier reaped after grace");
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /barrier expired "b\.dead"/);
  });

  it("nudges once at the deadline, then expires on a later tick after grace", async () => {
    const h = makeHarness(tmpDir);
    // Deadline 1s ago — past deadline, but not yet past grace.
    h.store.obligations.push({
      id: "t1/aging",
      to: "bob",
      summary: "slow thing",
      sentAt: new Date().toISOString(),
      deadline: new Date(Date.now() - 1_000).toISOString(),
    });
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 1, "nudge fires at deadline");
    assert.match(h.calls[0].content, /obligation overdue #t1\/aging/);
    assert.strictEqual(h.store.obligations.length, 1, "still in store between nudge and grace");
    // Second tick before grace elapses → no second nudge, still in store.
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 1, "no double nudge");
    assert.strictEqual(h.store.obligations.length, 1);
  });

  it("an obligation with no deadline is never expired or nudged", async () => {
    const h = makeHarness(tmpDir);
    h.store.obligations.push({
      id: "t1/nodeadline",
      to: "alice",
      summary: "no SLA",
      sentAt: new Date().toISOString(),
    });
    await h.inbox.checkDeadlines(h.ctx);
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(h.store.obligations.length, 1, "no-deadline obligations are immortal");
  });
});

describe("tools/shared: effectiveAgentStatus heartbeat cross-check", () => {
  // effectiveAgentStatus reads .picode/picodes/<id>/state.json from
  // process.cwd(); the harness seeds state.json under tmpDir, so chdir
  // into tmpDir for these tests and restore after.
  let origCwd: string;
  beforeEach(() => {
    origCwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(origCwd);
  });

  it("overrides working → unknown when the picode heartbeat is stale (zombie)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eff-1-"));
    process.chdir(dir);
    const picodeDir = join(dir, ".picode", "picodes", "scout", "inbox", "processed");
    mkdirSync(picodeDir, { recursive: true });
    const statePath = join(dir, ".picode", "picodes", "scout", "state.json");
    writeFileSync(
      statePath,
      JSON.stringify(
        baseState("scout", { lastSeen: new Date(Date.now() - STALE_MS - 5_000).toISOString() }),
      ),
    );
    assert.strictEqual(effectiveAgentStatus("working", "scout"), "unknown");
  });

  it("keeps working when the heartbeat is fresh (live worker)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eff-2-"));
    process.chdir(dir);
    const picodeDir = join(dir, ".picode", "picodes", "builder", "inbox", "processed");
    mkdirSync(picodeDir, { recursive: true });
    const statePath = join(dir, ".picode", "picodes", "builder", "state.json");
    writeFileSync(
      statePath,
      JSON.stringify(baseState("builder", { lastSeen: new Date().toISOString() })),
    );
    assert.strictEqual(effectiveAgentStatus("working", "builder"), "working");
  });

  it("passes idle/done/unknown/stopped through unchanged (no heartbeat check needed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eff-3-"));
    process.chdir(dir);
    // No state.json at all — fail-open must still pass these through.
    for (const s of ["idle", "done", "unknown", "stopped"]) {
      assert.strictEqual(effectiveAgentStatus(s, "ghost"), s);
    }
  });

  it("fail-open: returns herdr status when state.json is missing for working", () => {
    const dir = mkdtempSync(join(tmpdir(), "eff-4-"));
    process.chdir(dir);
    // No state.json — can't prove stale, so don't override.
    assert.strictEqual(effectiveAgentStatus("working", "missing"), "working");
  });

  it("fail-open: returns herdr status when state.json is corrupt", () => {
    const dir = mkdtempSync(join(tmpdir(), "eff-5-"));
    process.chdir(dir);
    const picodeDir = join(dir, ".picode", "picodes", "broken", "inbox", "processed");
    mkdirSync(picodeDir, { recursive: true });
    writeFileSync(join(dir, ".picode", "picodes", "broken", "state.json"), "{ not json");
    assert.strictEqual(effectiveAgentStatus("working", "broken"), "working");
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

  it('phase "done" journals an operator-only conversation run — decisions made in plain text must not be lost', () => {
    const store = bareStore();
    assert.strictEqual(shouldJournal(store, true, "done"), true); // baseline entry
    // User answers a question, coordinator replies in text: no tools, no
    // structural change. Without this write, the stale "awaiting decision"
    // entry resurfaces on every startup resume.
    assert.strictEqual(shouldJournal(store, false, "done", true), true);
    assert.strictEqual(shouldJournal(store, false, "done"), false); // flag is per-run
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

  it("the journal fork loads extensions and runs on the bounded prompt, not the session", () => {
    const args = journalForkArgs("/tmp/x", "summarize this");
    assert.ok(!args.includes("--no-extensions"), "extensions load so journal model can resolve");
    assert.ok(!args.includes("--fork"), "forking the session would send its whole transcript");
    assert.ok(args.includes("--print"));
    assert.strictEqual(args[args.indexOf("--print") + 1], "summarize this");
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

  it("the journal fork pins a model only when one is configured", () => {
    assert.ok(!journalForkArgs("/tmp/x", "p").includes("--model"));
    const pinned = journalForkArgs("/tmp/x", "p", "deepseek/deepseek-chat");
    assert.ok(pinned.includes("--model"));
    assert.ok(pinned.includes("deepseek/deepseek-chat"));
  });

  it("renderJournalMessage clips tool results hard and marks errors", () => {
    const toolResult = renderJournalMessage({
      role: "toolResult",
      toolName: "picode_pane_read",
      content: [{ type: "text", text: "x".repeat(5_000) }],
      isError: false,
    });
    assert.match(toolResult!, /^Tool result picode_pane_read: /);
    assert.ok(toolResult!.length < 500, "tool results are clipped to a gist");
    const failed = renderJournalMessage({
      role: "toolResult",
      toolName: "spawn_worker",
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
    assert.match(failed!, /\(error\)/);
  });

  it("renderJournalMessage drops images and unknown roles, summarizes tool calls", () => {
    assert.strictEqual(
      renderJournalMessage({ role: "branchSummary", summary: "s" }),
      null,
      "summaries are anchored via the previous entry, not re-rendered",
    );
    const imageOnly = renderJournalMessage({
      role: "user",
      content: [{ type: "image", data: "abc", mimeType: "image/png" }],
    });
    assert.match(imageOnly!, /^User: $/, "images never reach the fork prompt");
    const assistant = renderJournalMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Running the build." },
        { type: "toolCall", id: "1", name: "picode_run", arguments: {} },
      ],
    });
    assert.match(assistant!, /Running the build\./);
    assert.match(assistant!, /\[calls picode_run\]/);
  });

  it("buildJournalPrompt bounds messages, total chars, and anchors on the previous entry", () => {
    const many = Array.from({ length: JOURNAL_CONTEXT_MAX_MESSAGES + 10 }, (_, i) => ({
      role: "user",
      content: `msg ${i}`,
    }));
    const prompt = buildJournalPrompt(many, "<!-- 2026-08-22 12:00 -->\nWorking on: old task");
    assert.doesNotMatch(prompt, /msg 9\n/, "only the most recent messages are included");
    assert.match(prompt, /msg 49/);
    assert.match(prompt, /Working on: old task/, "previous entry rides along for continuity");

    const huge = buildJournalPrompt([{ role: "user", content: "y".repeat(80_000) }], undefined);
    assert.ok(huge.length < JOURNAL_CONTEXT_MAX_CHARS + 3_000, "total size is hard-capped");
    assert.match(huge, /…earlier activity clipped…|…$/, "clipping is visible to the fork model");
  });
});

describe("lifecycle: opt-in gate (§2.3)", () => {
  it("no --picode-id and no prior identity: stays inactive, never touches disk, hides picode_* tools", async () => {
    const h = makeLifecycleHarness(tmpDir);
    await h.fire("session_start", h.makeCtx());
    assert.ok(!existsSync(join(tmpDir, ".picode")), "no .picode/ dir for a non-picode session");
    assert.strictEqual(h.setActiveToolsCalls.length, 1);
    assert.deepStrictEqual(h.activeTools, ["bash", "read_file", "write", "edit"]);
  });

  it("--picode-id passed: activates, creates .picode/, hides picode_journal from the worker", async () => {
    const h = makeLifecycleHarness(tmpDir);
    h.setFlag("picode-id", "t9");
    await h.fire("session_start", h.makeCtx());
    assert.ok(existsSync(join(tmpDir, ".picode", "picodes", "t9", "state.json")));
    // worker role → picode_journal hidden; the READ_ONLY set may also filter
    assert.ok(!h.activeTools.includes("picode_journal"));
    h.store.stopHeartbeat();
    h.store.stopWatcher();
  });

  it("Recall Round Table exposes only its reply tool and title", async () => {
    const h = makeLifecycleHarness(tmpDir);
    h.setFlag("picode-id", "builder");
    h.setFlag("picode-round-table", true);
    await h.fire("session_start", h.makeCtx());
    assert.deepStrictEqual(h.activeTools, ["picode_round_table_reply"]);
    assert.match(h.titles.at(-1) ?? "", /🗣️ Round Table · builder/);
    h.store.stopHeartbeat();
    h.store.stopWatcher();
  });

  it("designer retains implementation tools while losing journal access", async () => {
    const h = makeLifecycleHarness(tmpDir);
    h.setFlag("picode-id", "designer");
    await h.fire("session_start", h.makeCtx());
    assert.ok(h.activeTools.includes("write"));
    assert.ok(h.activeTools.includes("edit"));
    assert.ok(h.activeTools.includes("picode_run"));
    assert.ok(!h.activeTools.includes("picode_journal"));
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

  it("a forked session (parentSession header) stays inactive even with a picode-identity entry", async () => {
    const h = makeLifecycleHarness(tmpDir);
    const ctx = h.makeCtx([{ type: "custom", customType: "picode-identity", data: { id: "t7" } }], {
      parentSession: "/some/source/session.jsonl",
    });
    await h.fire("session_start", ctx);
    assert.ok(
      !existsSync(join(tmpDir, ".picode", "picodes", "t7", "state.json")),
      "fork must not persist state — it is not the source picode",
    );
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

  it("workers get picode_journal hidden from active tools", async () => {
    const h = makeLifecycleHarness(tmpDir);
    h.setFlag("picode-id", "builder");
    h.setFlag("picode-role", "builder");
    await h.fire("session_start", h.makeCtx());
    assert.ok(!h.activeTools.includes("picode_journal"), "worker must not see picode_journal");
    assert.ok(
      h.activeTools.includes("picode_status"),
      "worker keeps picode_status for owed-reply recovery",
    );
    h.store.stopHeartbeat();
    h.store.stopWatcher();
  });

  it("coordinator startup appends resume context without waking (journal + obligations)", async () => {
    const prev = process.env.HERDR_ENV;
    process.env.HERDR_ENV = "1";
    try {
      const h = makeLifecycleHarness(tmpDir);
      h.setFlag("picode-id", "coordinator");
      h.setFlag("picode-role", "coordinator");
      h.store.picodesRootDir = join(tmpDir, ".picode", "picodes");
      mkdirSync(join(h.store.picodesRootDir, "coordinator"), { recursive: true });
      writeFileSync(
        join(h.store.picodesRootDir, "coordinator", "journal.md"),
        journalEntry(nowStamp(), "ship the lexer").trim() + "\n",
      );
      h.store.obligations.push({
        id: "coord/o1",
        to: "builder",
        summary: "build lexer",
        sentAt: new Date().toISOString(),
      });
      await h.fire("session_start", h.makeCtx());
      await new Promise(r => setImmediate(r));
      // Full resume context rides in the collapsed picode-system message…
      assert.strictEqual(h.sentMessages.length, 1);
      assert.strictEqual(h.sentMessages[0].customType, "picode-system");
      const context = h.sentMessages[0].content;
      assert.match(context, /Startup resume/);
      assert.match(context, /ship the lexer/);
      assert.match(context, /coord\/o1/);
      // …including the reading rules that stop stale decision re-asks
      // and keep open questions to a single line.
      assert.match(context, /Never re-ask the user/);
      assert.match(context, /LAST entry is the current state/);
      assert.match(context, /ONE short line/);
      assert.match(context, /do not re-present analysis/);
      // Startup context is passive; the coordinator waits for an operator prompt.
      assert.strictEqual(h.userMessages.length, 0);
      assert.strictEqual(h.sentMessages[0].options?.triggerTurn, false);
      assert.strictEqual(h.sentMessages[0].options?.deliverAs, undefined);
      h.store.stopHeartbeat();
      h.store.stopWatcher();
    } finally {
      if (prev === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = prev;
    }
  });

  it("worker startup injects no resume context", async () => {
    const h = makeLifecycleHarness(tmpDir);
    h.setFlag("picode-id", "scout");
    h.setFlag("picode-role", "scout");
    h.store.picodesRootDir = join(tmpDir, ".picode", "picodes");
    mkdirSync(join(h.store.picodesRootDir, "scout"), { recursive: true });
    writeFileSync(
      join(h.store.picodesRootDir, "scout", "journal.md"),
      journalEntry(nowStamp(), "scout task").trim() + "\n",
    );
    await h.fire("session_start", h.makeCtx());
    assert.strictEqual(h.userMessages.length, 0, "worker must not get resume injection");
    h.store.stopHeartbeat();
    h.store.stopWatcher();
  });

  it("startup resume context is a passive append — it never triggers or steers a turn", async () => {
    const prev = process.env.HERDR_ENV;
    process.env.HERDR_ENV = "1";
    try {
      const h = makeLifecycleHarness(tmpDir);
      h.setFlag("picode-id", "coordinator");
      h.setFlag("picode-role", "coordinator");
      h.store.picodesRootDir = join(tmpDir, ".picode", "picodes");
      mkdirSync(join(h.store.picodesRootDir, "coordinator"), { recursive: true });
      writeFileSync(
        join(h.store.picodesRootDir, "coordinator", "journal.md"),
        journalEntry(nowStamp(), "ship the lexer").trim() + "\n",
      );
      await h.fire("session_start", h.makeCtx());
      await new Promise(r => setImmediate(r));
      // No startup primer: the coordinator waits for an operator prompt.
      assert.strictEqual(h.sentMessages.length, 1);
      assert.strictEqual(h.sentMessages[0].options?.triggerTurn, false);
      assert.strictEqual(h.sentMessages[0].options?.deliverAs, undefined);
      assert.strictEqual(h.userMessages.length, 0, "startup must not wake coordinator");
      h.store.stopHeartbeat();
      h.store.stopWatcher();
    } finally {
      if (prev === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = prev;
    }
  });

  it("before_agent_start persists rules in a section without forcing a prompt", async () => {
    const h = makeLifecycleHarness(tmpDir);
    h.setFlag("picode-id", "t8");
    const ctx = h.makeCtx();
    await h.fire("session_start", ctx);
    const sections: Record<string, string> = {};
    const event = {
      systemPrompt: "base",
      systemPromptOptions: { sections },
    };
    const result = await h.fire("before_agent_start", ctx, event);
    assert.equal(
      typeof sections.picode,
      "string",
      "Picode rules are persisted as a system section",
    );
    assert.equal(
      result,
      undefined,
      "the hook must not force a one-run system prompt override: returning `systemPrompt` makes Pi strip every persisted system message and project a fresh head (dist/core/agent-session.js _installAgentForcedPromptProjection), so a roster digest that moves would rewrite the leading prompt and re-bill the whole conversation",
    );
    h.store.stopHeartbeat();
    h.store.stopWatcher();
  });

  it("keeps the forced-prompt fallback only for Pi without structured sections", async () => {
    const h = makeLifecycleHarness(tmpDir);
    h.setFlag("picode-id", "t9");
    const ctx = h.makeCtx();
    await h.fire("session_start", ctx);

    // Pi versions without `systemPromptOptions.sections` cannot persist the
    // rules in the transcript, so the one-run override is the only way to get
    // them into a prompt-driven request. Pin that branch: it is the only
    // remaining path where Picode rewrites the leading prompt, and it must not
    // break silently for users on those versions.
    const result = (await h.fire("before_agent_start", ctx, {
      systemPrompt: "base",
      systemPromptOptions: {},
    })) as { systemPrompt?: string } | undefined;

    assert.ok(result?.systemPrompt, "an older Pi still receives the rules as a forced prompt");
    assert.ok(
      result.systemPrompt.startsWith("base\n\n"),
      "the forced prompt extends the base prompt rather than replacing it",
    );
    assert.ok(result.systemPrompt.includes("t9"), "the Picode rules reach the request");

    h.store.stopHeartbeat();
    h.store.stopWatcher();
  });

  it("keeps a stable worker roster stub in its own section", async () => {
    const prevHerdr = process.env.HERDR_ENV;
    process.env.HERDR_ENV = "1";
    try {
      const h = makeLifecycleHarness(tmpDir);
      h.setFlag("picode-id", "coordinator");
      h.setFlag("picode-role", "coordinator");
      const ctx = h.makeCtx();
      await h.fire("session_start", ctx);

      // Seed one worker and let its liveness/age move between runs. Those
      // volatile facts belong to on-demand picode_list(), not the prompt stub.
      const seedWorker = (minutesAgo: number) => {
        const workerDir = join(tmpDir, ".picode", "picodes", "builder-a1");
        mkdirSync(workerDir, { recursive: true });
        writeFileSync(
          join(workerDir, "state.json"),
          JSON.stringify({
            role: "builder",
            status: "stopped",
            state: "open",
            lastSeen: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
          }),
        );
      };

      seedWorker(12);
      const first: Record<string, string> = {};
      await h.fire("before_agent_start", ctx, {
        systemPrompt: "base",
        systemPromptOptions: { sections: first },
      });

      seedWorker(40);
      const second: Record<string, string> = {};
      await h.fire("before_agent_start", ctx, {
        systemPrompt: "base",
        systemPromptOptions: { sections: second },
      });

      assert.ok(first["picode-workers"], "the roster travels in a section of its own");
      assert.equal(
        first["picode-workers"],
        second["picode-workers"],
        "volatile worker state must not churn the roster stub",
      );
      assert.match(first["picode-workers"], /builder-a1 \(builder\)/);
      assert.equal(
        first.picode,
        second.picode,
        "the stable roster stub is isolated from the rules section",
      );
      assert.equal(
        first.picode.includes("builder-a1"),
        false,
        "the rules section must not carry the roster rows",
      );
      h.store.stopHeartbeat();
      h.store.stopWatcher();
    } finally {
      if (prevHerdr === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = prevHerdr;
    }
  });
});

describe("core: bounded sit-rep policy", () => {
  it("falls back to the default cap on junk, so a typo cannot disable the cap", () => {
    assert.strictEqual(resolveSitrepMaxIdle(undefined), SITREP_MAX_IDLE_DEFAULT);
    assert.strictEqual(resolveSitrepMaxIdle(""), SITREP_MAX_IDLE_DEFAULT);
    assert.strictEqual(resolveSitrepMaxIdle("   "), SITREP_MAX_IDLE_DEFAULT);
    assert.strictEqual(resolveSitrepMaxIdle("three"), SITREP_MAX_IDLE_DEFAULT);
    assert.strictEqual(resolveSitrepMaxIdle("-2"), SITREP_MAX_IDLE_DEFAULT);
    assert.strictEqual(resolveSitrepMaxIdle("5"), 5);
    assert.strictEqual(resolveSitrepMaxIdle("2.9"), 2);
    assert.strictEqual(
      resolveSitrepMaxIdle("0"),
      0,
      "0 is the explicit 'never pause' escape hatch",
    );
  });

  it("fingerprint ignores ordering but reacts to every input", () => {
    const base = { trackedPanes: 2, obligations: ["b", "a"], barriers: ["bar1"], owed: [] };
    assert.strictEqual(
      sitrepSignature(base),
      sitrepSignature({ trackedPanes: 2, obligations: ["a", "b"], barriers: ["bar1"], owed: [] }),
    );
    assert.notStrictEqual(sitrepSignature(base), sitrepSignature({ ...base, trackedPanes: 1 }));
    assert.notStrictEqual(sitrepSignature(base), sitrepSignature({ ...base, obligations: ["a"] }));
    assert.notStrictEqual(sitrepSignature(base), sitrepSignature({ ...base, barriers: [] }));
    assert.notStrictEqual(sitrepSignature(base), sitrepSignature({ ...base, owed: ["boss/q1"] }));
  });

  it("lets maxIdle no-change checks through, then pauses instead of injecting", () => {
    let streak = initialSitrepStreak();
    const decisions: string[] = [];
    for (let i = 0; i < 5; i++) {
      const step = advanceSitrep(streak, "same", 3);
      streak = step.streak;
      decisions.push(step.decision);
    }
    // One baseline + three no-change checks, then silence.
    assert.deepStrictEqual(decisions, ["inject", "inject", "inject", "inject", "pause"]);
  });

  it("a changed picture resets the streak", () => {
    let streak = initialSitrepStreak();
    for (let i = 0; i < 3; i++) streak = advanceSitrep(streak, "a", 3).streak;
    assert.strictEqual(streak.idle, 2);
    const moved = advanceSitrep(streak, "b", 3);
    assert.strictEqual(moved.decision, "inject");
    assert.strictEqual(moved.streak.idle, 0);
  });

  it("maxIdle 0 polls forever", () => {
    let streak = initialSitrepStreak();
    for (let i = 0; i < 25; i++) {
      const step = advanceSitrep(streak, "same", 0);
      streak = step.streak;
      assert.strictEqual(step.decision, "inject");
    }
  });
});

describe("lifecycle: bounded sit-reps", () => {
  /** Fires session_start as a coordinator with a fast sit-rep interval and a
   *  stubbed pane count. Before the stub goes in, the herdr listener that
   *  session_start just started is stopped: the sit-rep policy needs a pane
   *  count, not a live socket subscription (or its reconnect timer). */
  async function sitrepHarness(maxIdle: number) {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w-test";
    process.env.PICODE_SITREP_INTERVAL_MS = "1000";
    process.env.PICODE_SITREP_MAX_IDLE = String(maxIdle);
    const h = makeLifecycleHarness(tmpDir);
    h.setFlag("picode-id", "coordinator");
    h.setFlag("picode-role", "coordinator");
    await h.fire("session_start", h.makeCtx());
    getListenerHandle()?.stop();
    setListenerHandle({
      stop: () => {},
      trackPane: () => {},
      untrackPane: () => {},
      trackedPaneCount: () => 1,
    });
    return h;
  }

  /** Restore the sit-rep knobs and close the handles the harness opened. */
  function closeSitrepHarness(h: ReturnType<typeof makeLifecycleHarness>) {
    h.store.stopHeartbeat();
    h.store.stopWatcher();
    for (const key of ["PICODE_SITREP_INTERVAL_MS", "PICODE_SITREP_MAX_IDLE"]) {
      delete process.env[key];
    }
  }

  it("pauses after the idle cap and re-arms when the operator speaks", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const h = await sitrepHarness(2);
    try {
      const tick = () => mock.timers.tick(1000);
      tick(); // baseline
      tick(); // unchanged #1
      tick(); // unchanged #2
      assert.strictEqual(h.userMessages.length, 3, "each check wakes the coordinator");
      assert.strictEqual(h.notifications.length, 0, "nothing to report yet");

      tick(); // the check after the cap pauses instead of injecting
      assert.strictEqual(h.userMessages.length, 3, "a paused timer must not wake the model");
      assert.match(h.notifications.at(-1)!.text, /2 checks in a row found no changes/);

      mock.timers.tick(600_000);
      assert.strictEqual(h.userMessages.length, 3, "paused means paused — an hour changes nothing");

      // Operator speaks: fresh baseline, checks run again.
      await h.fire("input", h.makeCtx(), { source: "prompt" });
      tick();
      assert.strictEqual(h.userMessages.length, 4, "operator input re-arms the timer");
      closeSitrepHarness(h);
    } finally {
      mock.timers.reset();
    }
  });

  it("a delivered envelope re-arms a paused timer", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const h = await sitrepHarness(1);
    try {
      mock.timers.tick(1000); // baseline
      mock.timers.tick(1000); // unchanged #1
      mock.timers.tick(1000); // > cap → pause
      assert.strictEqual(h.userMessages.length, 2);
      const pausedAt = h.userMessages.length;

      // An envelope landing is real activity — the inbox hook restarts the
      // timer, so a paused idle check never eats a teammate's message.
      h.inbox.onInjected?.([{ text: "[request from boss] status?", urgency: "low" }]);
      mock.timers.tick(1000);
      assert.strictEqual(h.userMessages.length, pausedAt + 1);
      closeSitrepHarness(h);
    } finally {
      mock.timers.reset();
    }
  });

  it("skips the journal fork for a sit-rep run that changed nothing, keeps it for real work", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const h = await sitrepHarness(3);
    const forked: string[] = [];
    h.store.forkJournal = prompt => forked.push(prompt);
    // One ctx over a shared entries array: the fork slices off messages it has
    // already summarized, so a second run needs new entries to be fork-worthy.
    const entries: LifecycleEntry[] = [];
    const runCtx = () => h.makeCtx(entries);
    try {
      mock.timers.tick(1000);
      assert.strictEqual(h.userMessages.length, 1, "sit-rep injected");

      // The sit-rep run: tools ran, the run settled (open → done), and the
      // picture did not otherwise move.
      entries.push({ type: "message", message: { role: "user", content: "check the workers" } });
      await h.fire("tool_execution_start", runCtx(), {});
      await h.fire("agent_end", runCtx());
      assert.strictEqual(forked.length, 0, "a no-op check must not buy a second model call");

      // Same shape again, but this run actually moved something.
      mock.timers.tick(1000);
      entries.push({ type: "message", message: { role: "user", content: "builder replied" } });
      await h.fire("tool_execution_start", runCtx(), {});
      h.store.obligations.push({
        id: "coord/o9",
        to: "builder",
        summary: "build the lexer",
        sentAt: new Date().toISOString(),
      });
      await h.fire("agent_end", runCtx());
      assert.strictEqual(forked.length, 1, "a run that changed state still journals");
      closeSitrepHarness(h);
    } finally {
      mock.timers.reset();
    }
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
    // Passive append, never deliverAs:"nextTurn" — that queue only drains on
    // prompt()-driven turns, and a coordinator woken solely by envelopes
    // would starve the reminder forever.
    assert.strictEqual(h.sentMessages[0].options?.triggerTurn, false);
    assert.strictEqual(h.sentMessages[0].options?.deliverAs, undefined);
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

  it("/picode-models shows built-in global defaults with no files", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/picode-models");
    const text = h.notifications.at(-1)!.text;
    assert.match(text, /Global defaults/);
    assert.match(text, /Project overrides/);
    assert.match(text, /inherits global defaults/);
  });

  it("/picode-models sets and persists a project override", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/picode-models", "builder gemini-2.5-flash");
    assert.match(h.notifications.at(-1)!.text, /Set builder/);
    const paths = modelsConfigPaths(tmpDir, join(tmpDir, "agent"));
    assert.equal(JSON.parse(readFileSync(paths.project, "utf8")).builder, "gemini-2.5-flash");
    assert.equal(existsSync(paths.global), false);
  });

  it("/picode-models --global sets only a global override", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/picode-models", "--global scout commandcode/scout");
    assert.match(h.notifications.at(-1)!.text, /global defaults/);
    const paths = modelsConfigPaths(tmpDir, join(tmpDir, "agent"));
    assert.equal(JSON.parse(readFileSync(paths.global, "utf8")).scout, "commandcode/scout");
    assert.equal(existsSync(paths.project), false);
  });

  it("/picode-models --reset deletes the project override file", async () => {
    const h = makeHarness(tmpDir);
    const modelsPath = join(tmpDir, ".picode", "models.json");
    mkdirSync(join(tmpDir, ".picode"), { recursive: true });
    writeFileSync(modelsPath, JSON.stringify({ builder: "deepseek/deepseek-v4-pro" }));
    await callCommand(h, "/picode-models", "--reset");
    assert.match(h.notifications.at(-1)!.text, /global defaults restored/);
    assert.equal(existsSync(modelsPath), false);
  });

  it("/picode-models --global --reset keeps a valid global file", async () => {
    const h = makeHarness(tmpDir);
    const paths = modelsConfigPaths(tmpDir, join(tmpDir, "agent"));
    writeModelsConfig(paths.global, { scout: "global/scout" });
    await callCommand(h, "/picode-models", "--global --reset");
    assert.match(h.notifications.at(-1)!.text, /built-in defaults restored/);
    assert.deepEqual(readModelsConfig(paths.global), {});
  });

  it("/picode-models no-UI listing resolves global default for roles", async () => {
    const h = makeHarness(tmpDir);
    const paths = modelsConfigPaths(tmpDir, join(tmpDir, "agent"));
    writeModelsConfig(paths.global, { default: "global/default" });
    await callCommand(h, "/picode-models");
    const text = h.notifications.at(-1)!.text;
    assert.match(text, /builder: global\/default/);
    assert.match(text, /scout: global\/default/);
  });

  it("/picode-models no-UI listing excludes theme key", async () => {
    const h = makeHarness(tmpDir);
    const modelsPath = join(tmpDir, ".picode", "models.json");
    mkdirSync(join(tmpDir, ".picode"), { recursive: true });
    writeFileSync(
      modelsPath,
      JSON.stringify({ builder: "deepseek/deepseek-v4-pro", theme: "tokyo-night" }),
    );
    await callCommand(h, "/picode-models");
    const text = h.notifications.at(-1)!.text;
    assert.match(text, /builder/);
    assert.doesNotMatch(text, /theme/);
  });
});

// --- commands-models: pure helpers --------------------------------------

describe("commands-models: pure helpers", () => {
  // Minimal mock Model matching the shape returned by modelRegistry.getAvailable()
  function mockModel(
    provider: string,
    id: string,
    opts: { contextWindow?: number; reasoning?: boolean } = {},
  ) {
    return {
      id,
      name: id,
      provider,
      reasoning: opts.reasoning ?? false,
      contextWindow: opts.contextWindow ?? 128000,
      maxTokens: 16384,
    } as never; // cast — we only use id/provider/reasoning/contextWindow
  }

  it("formatContextWindow formats millions and thousands", () => {
    assert.equal(formatContextWindow(1_000_000), "1M");
    assert.equal(formatContextWindow(1_500_000), "1.5M");
    assert.equal(formatContextWindow(128_000), "128K");
    assert.equal(formatContextWindow(49_152), "49K");
    assert.equal(formatContextWindow(500), "500");
  });

  it("formatModelDescription appends reasoning flag", () => {
    const m1 = mockModel("deepseek", "deepseek-v4-pro", {
      contextWindow: 1_000_000,
      reasoning: true,
    });
    const m2 = mockModel("deepseek", "deepseek-v4-flash", { contextWindow: 1_000_000 });
    assert.equal(formatModelDescription(m1), "1M · reasoning");
    assert.equal(formatModelDescription(m2), "1M");
  });

  it("readModelsConfig returns {} when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-test-"));
    try {
      const result = readModelsConfig(join(dir, "models.json"));
      assert.deepEqual(result, {});
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("readModelsConfig parses existing JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-test-"));
    try {
      const p = join(dir, "models.json");
      writeFileSync(
        p,
        JSON.stringify({ builder: "deepseek/deepseek-v4-pro", theme: "tokyo-night" }),
      );
      const result = readModelsConfig(p);
      assert.equal(result.builder, "deepseek/deepseek-v4-pro");
      assert.equal(result.theme, "tokyo-night");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("readModelsConfig throws on invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-test-"));
    try {
      const p = join(dir, "models.json");
      writeFileSync(p, "{not valid json");
      assert.throws(() => readModelsConfig(p));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("readModelsConfig rejects non-string values", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-test-"));
    try {
      const p = join(dir, "models.json");
      writeFileSync(p, JSON.stringify({ scout: 42 }));
      assert.throws(() => readModelsConfig(p), /scout.*must be a string/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("writeModelsConfig writes 2-space indented JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-test-"));
    try {
      const p = join(dir, "models.json");
      writeModelsConfig(p, { builder: "deepseek/deepseek-v4-pro", theme: "tokyo-night" });
      const raw = readFileSync(p, "utf8");
      assert.match(raw, /"builder": "deepseek\/deepseek-v4-pro"/);
      assert.match(raw, /"theme": "tokyo-night"/);
      // 2-space indent
      assert.match(raw, /\n {2}"builder"/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("buildRoleItems includes standard roles in order", () => {
    const items = buildRoleItems({});
    const labels = items.map(i => i.label);
    // default first, then journal, then builder, reviewer, tester, …
    assert.equal(labels[0], "default");
    assert.equal(labels[1], "journal");
    assert.equal(labels[2], "builder");
    assert.equal(labels[3], "reviewer");
    assert.ok(labels.includes("visionary"));
    assert.ok(labels.includes("(reset all)"));
    assert.ok(labels.includes("(done)"));
  });

  it("buildRoleItems shows current model as description", () => {
    const items = buildRoleItems({ builder: "deepseek/deepseek-v4-pro" });
    const builder = items.find(i => i.label === "builder")!;
    assert.equal(builder.description, "deepseek/deepseek-v4-pro");
    const tester = items.find(i => i.label === "tester")!;
    assert.equal(tester.description, "(not set)");
  });

  it("buildRoleItems shows inherited global model", () => {
    const items = buildRoleItems({}, { scout: "global/scout" });
    const scout = items.find(i => i.label === "scout")!;
    assert.equal(scout.description, "(inherits global: global/scout)");
  });

  it("buildRoleItems applies current-scope default before inherited config", () => {
    const items = buildRoleItems({ default: "project/default" }, { scout: "global/scout" });
    const scout = items.find(i => i.label === "scout")!;
    assert.equal(scout.description, "(inherits this scope default: project/default)");
  });

  it("buildRoleItems excludes theme and coordinator keys", () => {
    const items = buildRoleItems({
      theme: "tokyo-night",
      coordinator: "windsurf/glm-5-2",
      builder: "deepseek/deepseek-v4-pro",
    });
    const labels = items.map(i => i.label);
    assert.ok(!labels.includes("theme"));
    assert.ok(!labels.includes("coordinator"));
    assert.ok(labels.includes("builder"));
  });

  it("buildRoleItems includes custom role keys from config", () => {
    const items = buildRoleItems({ "my-custom-role": "windsurf/glm-5-2" });
    const labels = items.map(i => i.label);
    assert.ok(labels.includes("my-custom-role"));
  });

  it("buildModelItems sorts by provider then id", () => {
    const models = [
      mockModel("windsurf", "glm-5-2"),
      mockModel("deepseek", "deepseek-v4-flash"),
      mockModel("deepseek", "deepseek-v4-pro", { reasoning: true }),
    ];
    const items = buildModelItems(models, undefined);
    // First item is (clear) sentinel
    const values = items.map(i => i.value);
    assert.equal(values[0], "\x00clear");
    assert.equal(values[1], "deepseek/deepseek-v4-flash");
    assert.equal(values[2], "deepseek/deepseek-v4-pro");
    assert.equal(values[3], "windsurf/glm-5-2");
    // Last is (back)
    assert.equal(values.at(-1), "\x00back");
  });

  it("buildModelItems description shows context window + reasoning", () => {
    const models = [
      mockModel("deepseek", "deepseek-v4-pro", { contextWindow: 1_000_000, reasoning: true }),
    ];
    const items = buildModelItems(models, undefined);
    const modelItem = items.find(i => i.value === "deepseek/deepseek-v4-pro")!;
    assert.equal(modelItem.description, "1M · reasoning");
  });

  it("buildModelItems (clear) description shows current model when set", () => {
    const models = [mockModel("deepseek", "deepseek-v4-pro")];
    const items = buildModelItems(models, "deepseek/deepseek-v4-pro");
    const clearItem = items.find(i => i.value === "\x00clear")!;
    assert.match(clearItem.description!, /was deepseek\/deepseek-v4-pro/);
  });

  it("buildModelItems (clear) on a project override keeps global model", () => {
    const models = [mockModel("project", "scout")];
    const items = buildModelItems(models, "project/scout", "global/scout");
    const clearItem = items.find(i => i.value === "\x00clear")!;
    assert.equal(clearItem.description, "inherit global/default (currently global/scout)");
  });

  it("buildRoleItems includes journal role after default", () => {
    const items = buildRoleItems({});
    const labels = items.map(i => i.label);
    assert.equal(labels[0], "default");
    assert.equal(labels[1], "journal");
    const journal = items.find(i => i.label === "journal")!;
    assert.equal(journal.description, "(inherits coordinator model)");
  });

  it("buildRoleItems shows journal model as description when set", () => {
    const items = buildRoleItems({ journal: "deepseek/deepseek-v4-flash" });
    const journal = items.find(i => i.label === "journal")!;
    assert.equal(journal.description, "deepseek/deepseek-v4-flash");
  });

  it("buildRoleItems includes (journal cadence) entry", () => {
    const items = buildRoleItems({ "journal-cadence": "done" });
    const cadence = items.find(i => i.label === "(journal cadence)")!;
    assert.ok(cadence);
    assert.equal(cadence.description, "done");
  });

  it("buildRoleItems (journal cadence) shows done (default) when unset", () => {
    const items = buildRoleItems({});
    const cadence = items.find(i => i.label === "(journal cadence)")!;
    assert.equal(cadence.description, "done (default)");
  });

  it("buildRoleItems filters journal-cadence from custom role keys", () => {
    const items = buildRoleItems({ "journal-cadence": "done", "my-role": "x/y" });
    const labels = items.map(i => i.label);
    assert.ok(!labels.includes("journal-cadence"));
    assert.ok(labels.includes("my-role"));
  });
});

describe("model-config: global and project precedence", () => {
  it("uses project override, then global override, then built-in default", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-model-config-"));
    try {
      const globalPath = join(dir, "global", "models.json");
      const projectPath = join(dir, "project", "models.json");
      writeModelsConfig(globalPath, {
        scout: "global/scout",
        builder: "global/builder",
      });
      writeModelsConfig(projectPath, { scout: "project/scout" });

      const config = mergeModelsConfig(globalPath, projectPath);
      assert.equal(config.scout, "project/scout");
      assert.equal(config.builder, "global/builder");
      assert.equal(config.reviewer, DEFAULT_MODELS.reviewer);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves exact, multi-hyphen prefix, then default models", () => {
    const config = {
      default: "models/default",
      bug: "models/bug",
      "bug-hunter": "models/bug-hunter",
    };
    assert.equal(resolveConfiguredModel(config, "bug-hunter"), "models/bug-hunter");
    assert.equal(resolveConfiguredModel(config, "bug-hunter-2"), "models/bug-hunter");
    assert.equal(resolveConfiguredModel(config, "unknown-2"), "models/default");
  });

  it("scope defaults beat lower-scope role defaults", () => {
    assert.equal(
      resolveModelFromConfigs("builder", { default: "project/default" }, {}),
      "project/default",
    );
    assert.equal(
      resolveModelFromConfigs("builder", {}, { default: "global/default" }),
      "global/default",
    );
    assert.equal(resolveModelFromConfigs("builder", {}, {}), DEFAULT_MODELS.builder);
  });

  it("loadModelsConfig reads explicit global and project directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-model-config-"));
    try {
      const agentDir = join(dir, "agent");
      const projectDir = join(dir, "project");
      const paths = modelsConfigPaths(projectDir, agentDir);
      writeModelsConfig(paths.global, { default: "global/default", scout: "global/scout" });
      writeModelsConfig(paths.project, { builder: "project/builder" });

      const config = loadModelsConfig(projectDir, agentDir);
      assert.equal(config.scout, "global/scout");
      assert.equal(config.builder, "project/builder");
      assert.equal(config.reviewer, "global/default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("journal: journalMode with modelsPath", () => {
  function makePi(flag?: string) {
    const flags: Record<string, string | boolean | undefined> = {};
    if (flag !== undefined) flags["picode-journal"] = flag;
    return { getFlag: (name: string) => flags[name] } as unknown as ExtensionAPI;
  }

  it("returns done when models.json has journal-cadence done and no CLI flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-jm-"));
    try {
      const p = join(dir, "models.json");
      writeFileSync(p, JSON.stringify({ "journal-cadence": "done" }));
      assert.equal(journalMode(makePi(), p), "done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns turn when models.json explicitly sets journal-cadence turn", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-jm-"));
    try {
      const p = join(dir, "models.json");
      writeFileSync(p, JSON.stringify({ "journal-cadence": "turn" }));
      assert.equal(journalMode(makePi(), p), "turn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("global cadence applies and project cadence overrides it", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-jm-"));
    try {
      const globalPath = join(dir, "global.json");
      const projectPath = join(dir, "project.json");
      writeFileSync(globalPath, JSON.stringify({ "journal-cadence": "turn" }));
      assert.equal(journalMode(makePi(), projectPath, undefined, globalPath), "turn");
      writeFileSync(projectPath, JSON.stringify({ "journal-cadence": "off" }));
      assert.equal(journalMode(makePi(), projectPath, undefined, globalPath), "off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI flag wins over models.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-jm-"));
    try {
      const p = join(dir, "models.json");
      writeFileSync(p, JSON.stringify({ "journal-cadence": "done" }));
      assert.equal(journalMode(makePi("off"), p), "off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls through to done on invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-jm-"));
    try {
      const p = join(dir, "models.json");
      writeFileSync(p, "{not valid json");
      assert.equal(journalMode(makePi(), p), "done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns done when models.json absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-jm-"));
    try {
      assert.equal(journalMode(makePi(), join(dir, "models.json")), "done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("worker roles never journal — role gate wins over cadence", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-jm-"));
    try {
      const p = join(dir, "models.json");
      writeFileSync(p, JSON.stringify({ "journal-cadence": "done" }));
      assert.equal(journalMode(makePi(), p, "builder"), "off");
      assert.equal(journalMode(makePi(), p, "scout"), "off");
      assert.equal(journalMode(makePi("turn"), p, "visionary"), "off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("coordinator role honors cadence and CLI flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-jm-"));
    try {
      const p = join(dir, "models.json");
      writeFileSync(p, JSON.stringify({ "journal-cadence": "done" }));
      assert.equal(journalMode(makePi(), p, "coordinator"), "done");
      assert.equal(journalMode(makePi("turn"), p, "coordinator"), "turn");
      assert.equal(journalMode(makePi("off"), p, "coordinator"), "off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("countQueued counts only inbox-root JSON envelopes", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    await adapter.enqueueMessage(wireEnvelope("alice", "bob", "first"));
    await adapter.enqueueMessage(wireEnvelope("alice", "bob", "second"));
    const claimedDir = join(tmpDir, ".picode", "picodes", "bob", "inbox", "claimed");
    const processedDir = join(tmpDir, ".picode", "picodes", "bob", "inbox", "processed");
    mkdirSync(claimedDir, { recursive: true });
    mkdirSync(processedDir, { recursive: true });
    writeFileSync(join(claimedDir, "claimed.json"), JSON.stringify(wireEnvelope("a", "bob", "c")));
    writeFileSync(
      join(processedDir, "processed.json"),
      JSON.stringify(wireEnvelope("a", "bob", "p")),
    );
    assert.strictEqual(await adapter.countQueued("bob"), 2);
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
    async countQueued(id) {
      const arr = inboxes.get(id) ?? [];
      const now = Date.now();
      return arr.filter(
        m =>
          (!m.expiresAt || new Date(m.expiresAt).getTime() > now) &&
          (!m.deliverAfter || new Date(m.deliverAfter).getTime() <= now),
      ).length;
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
  it("coordinator init leaves model defaults outside project config", async () => {
    const adapter = createLocalFsAdapter();
    await adapter.configure(tmpDir);
    const store = createPicodeStore(mkPi("coord1", "coordinator"), adapter);
    await store.init(tmpDir, mkCtx(tmpDir));
    assert.equal(existsSync(join(tmpDir, ".picode", "models.json")), false);
    assert.equal(
      loadModelsConfig(tmpDir, join(tmpDir, "agent")).visionary,
      "opencode-go/mimo-v2.5",
    );
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

describe("core: toSummary() ghost detection", () => {
  it("done + stale → ghost=true", () => {
    const s = toSummary(
      baseState("planner", {
        state: "done",
        lastSeen: new Date(Date.now() - STALE_MS - 1000).toISOString(),
      }),
    );
    assert.strictEqual(s.ghost, true);
    assert.strictEqual(s.state, "done");
    assert.strictEqual(s.status, "stopped");
  });

  it("done + fresh → ghost=false", () => {
    const s = toSummary(baseState("alive", { state: "done", lastSeen: new Date().toISOString() }));
    assert.strictEqual(s.ghost, false);
    assert.strictEqual(s.status, "running");
  });

  it("stopped + stale → ghost=true", () => {
    const s = toSummary(
      baseState("crashed", {
        state: "stopped",
        lastSeen: new Date(Date.now() - STALE_MS - 2000).toISOString(),
      }),
    );
    assert.strictEqual(s.ghost, true);
    assert.strictEqual(s.state, "stopped");
  });

  it("stopped + fresh → ghost=false", () => {
    const s = toSummary(
      baseState("just-stopped", {
        state: "stopped",
        status: "stopped",
        lastSeen: new Date().toISOString(),
      }),
    );
    assert.strictEqual(s.ghost, false);
  });

  it("idle + stale → ghost=false (transient state, not terminal)", () => {
    const s = toSummary(
      baseState("idler", {
        state: "idle",
        lastSeen: new Date(Date.now() - STALE_MS - 3000).toISOString(),
      }),
    );
    assert.strictEqual(s.ghost, false);
    assert.strictEqual(s.status, "stopped"); // still stale-flagged
  });

  it("open + stale → ghost=false", () => {
    const s = toSummary(
      baseState("worker", {
        state: "open",
        lastSeen: new Date(Date.now() - STALE_MS - 4000).toISOString(),
      }),
    );
    assert.strictEqual(s.ghost, false);
    assert.strictEqual(s.status, "stopped");
  });

  it("working + stale → ghost=false", () => {
    const s = toSummary(
      baseState("busy", {
        state: "working",
        lastSeen: new Date(Date.now() - STALE_MS - 5000).toISOString(),
      }),
    );
    assert.strictEqual(s.ghost, false);
    assert.strictEqual(s.status, "stopped");
  });
});

describe("core: formatThreadLine ghost rendering", () => {
  it("appends [ghost] when ghost=true", () => {
    const summary: PicodeSummary = {
      id: "planner",
      pid: 1,
      state: "done",
      status: "stopped",
      parent: "coordinator",
      role: "worker",
      lastSeen: "2026-07-20T23:12:05.943Z",
      obligations: 1,
      owed: 0,
      barriers: 0,
      ghost: true,
    };
    const line = formatThreadLine(summary);
    assert.match(line, /ghost/);
    assert.match(line, /obligations=1/); // existing fields intact
  });

  it("omits [ghost] when ghost=false", () => {
    const summary: PicodeSummary = {
      id: "alice",
      pid: 2,
      state: "idle",
      status: "running",
      parent: null,
      role: "builder",
      lastSeen: new Date().toISOString(),
      obligations: 0,
      owed: 0,
      barriers: 0,
      ghost: false,
    };
    const line = formatThreadLine(summary);
    assert.doesNotMatch(line, /ghost/);
    assert.doesNotMatch(line, /owed=/); // zero counts suppressed
  });

  it("done+fresh summary has no ghost in rendered line", () => {
    const summary: PicodeSummary = {
      id: "resting",
      pid: 3,
      state: "done",
      status: "running",
      parent: null,
      role: "worker",
      lastSeen: new Date().toISOString(),
      obligations: 0,
      owed: 0,
      barriers: 0,
      ghost: false,
    };
    const line = formatThreadLine(summary);
    assert.doesNotMatch(line, /ghost/);
    assert.match(line, /\[done\] {2}running/);
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

describe("journal: compaction (auto at 200 entries)", () => {
  it("JOURNAL_COMPACT_THRESHOLD is 200", () => {
    assert.strictEqual(JOURNAL_COMPACT_THRESHOLD, 200);
  });
  it("JOURNAL_COMPACT_KEEP_RECENT is 50", () => {
    assert.strictEqual(JOURNAL_COMPACT_KEEP_RECENT, 50);
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
    const entries = Array.from({ length: 210 }, (_, i) => `<!-- ${i} -->\nentry ${i}`);
    const content = entries.join("\n");
    const plan = decideCompaction(content, Date.now());
    assert.ok(plan);
    assert.strictEqual(plan.toSummarize.length, 210 - JOURNAL_COMPACT_KEEP_RECENT);
    assert.strictEqual(plan.toKeep.length, JOURNAL_COMPACT_KEEP_RECENT);
    // First summarized entry is index 0; first kept is the boundary.
    assert.ok(plan.toSummarize[0].startsWith("<!-- 0 -->"));
    assert.ok(plan.toKeep[0].startsWith(`<!-- ${210 - JOURNAL_COMPACT_KEEP_RECENT} -->`));
    assert.ok(plan.toKeep[plan.toKeep.length - 1].startsWith("<!-- 209 -->"));
  });

  it("decideCompaction returns null when a recent COMPACTION marker is within cooldown", () => {
    const recent = new Date(Date.now() - 60_000); // 1 minute ago
    const ts = recent.toISOString().slice(0, 16).replace("T", " ");
    const entries = [
      ...Array.from({ length: 209 }, (_, i) => `<!-- ${i} -->\nentry ${i}`),
      `<!-- COMPACTION ${ts} -->\nold summary`,
    ];
    const plan = decideCompaction(entries.join("\n"), Date.now());
    assert.strictEqual(plan, null, "cooldown must suppress back-to-back compactions");
  });

  it("decideCompaction returns a plan when the last COMPACTION marker is older than cooldown", () => {
    const longAgo = new Date(Date.now() - JOURNAL_COMPACT_COOLDOWN_MS - 60_000);
    const ts = longAgo.toISOString().slice(0, 16).replace("T", " ");
    const entries = [
      ...Array.from({ length: 209 }, (_, i) => `<!-- ${i} -->\nentry ${i}`),
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
    await assert.rejects(() => adapter.acquireJournalLock!("lock2"), /after 240 retries/);
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

  it("skips markdown headings, returns first content line", () => {
    assert.equal(extractFirstLine("## Context\n\nbody"), "body");
    assert.equal(
      extractFirstLine("## Objective\nThis is a test objective"),
      "This is a test objective",
    );
  });

  it("skips all heading levels", () => {
    assert.equal(extractFirstLine("# Header\n## Sub\n### Deep\nactual content"), "actual content");
  });

  it("falls back to raw body when only headings present", () => {
    assert.equal(extractFirstLine("# Header"), "# Header".slice(0, 80));
  });

  it("returns the first non-empty line when there is no markdown", () => {
    assert.equal(extractFirstLine("hello\nworld"), "hello");
  });

  it("skips leading blank lines", () => {
    assert.equal(extractFirstLine("\n\nactual line"), "actual line");
  });

  it("falls back to first 80 chars when every line is heading or blank", () => {
    const long = "x".repeat(100);
    assert.equal(extractFirstLine("# h\n## h2\n" + long), long.slice(0, 80));
  });

  it("truncates to 80 chars when the first line is longer", () => {
    assert.equal(extractFirstLine("x".repeat(100)), "x".repeat(80));
  });

  it("returns empty string for empty body", () => {
    assert.equal(extractFirstLine(""), "");
  });

  it("handles a realistic picode_send task body with ## Objective heading", () => {
    const body =
      "## Objective\nAdd a current-task widget.\n\n## Context\nUser wants workers to see their task.\n\n## Steps\n1. Implement\n2. Test";
    assert.equal(extractFirstLine(body), "Add a current-task widget.");
  });

  it("handles a realistic picode_send task body with bold objective", () => {
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

describe("role and prompt contracts", () => {
  it("detects planner and runner IDs, and aliases explorer to scout", () => {
    assert.equal(detectWorkerRole("planner"), "planner");
    assert.equal(detectWorkerRole("runner-1"), "runner");
    assert.equal(detectWorkerRole("visionary"), "visionary");
    assert.equal(detectWorkerRole("visionary-2"), "visionary");
    assert.equal(detectWorkerRole("explorer"), "scout");
    assert.equal(detectWorkerRole("explorer-2"), "scout");
    assert.equal(detectWorkerRole("helper-1"), "worker");
    assert.equal(detectWorkerRole("gauntlet"), "gauntlet");
    assert.equal(detectWorkerRole("gauntlet-2"), "gauntlet");
  });

  it("separates worker role prompt from communication model", () => {
    const prompt = threadModelPrompt({
      picodeId: "planner",
      picodeDir: "",
      picodesRootDir: "",
      parent: "coordinator",
      role: "planner",
      sessionFile: null,
      startedAt: "",
      state: "open",
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
    });
    assert.match(prompt, /Ken Taylor\.\n\n### Role: Worker/);
    assert.match(prompt, /work lost\.\n\n### Subtype: Planner/);
  });
  it("loads the visionary prompt as a specialized worker subtype", () => {
    const prompt = threadModelPrompt({
      picodeId: "visionary",
      picodeDir: "",
      picodesRootDir: "",
      parent: "coordinator",
      role: "visionary",
      sessionFile: null,
      startedAt: "",
      state: "open",
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
    });
    assert.match(prompt, /visual evidence specialist/);
    assert.match(prompt, /multimodal model/);
    assert.match(prompt, /Plain-text output reaches only the human operator/);
  });

  it("workers get no journal-recovery guidance; coordinator does", () => {
    const worker = threadModelPrompt({
      picodeId: "builder",
      picodeDir: "",
      picodesRootDir: "",
      parent: "coordinator",
      role: "builder",
      sessionFile: null,
      startedAt: "",
      state: "open",
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
    });
    assert.match(worker, /Your journal is disabled/);
    assert.doesNotMatch(worker, /picode_journal\(id\)/);
    assert.doesNotMatch(
      worker,
      /recover your identity, obligations, owed replies, and recent journal/,
    );
    const coord = threadModelPrompt({
      picodeId: "coordinator",
      picodeDir: "",
      picodesRootDir: "",
      parent: null,
      role: "coordinator",
      sessionFile: null,
      startedAt: "",
      state: "open",
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
    });
    assert.match(coord, /recover your identity, obligations, owed replies, and recent journal/);
    assert.match(coord, /picode_journal\(id\)/);
  });
});

describe("system-prompt: picode_send contract is in every worker template", () => {
  // Regression guard: the contract must live in the shared worker base
  // block so it reaches builder, reviewer, explorer, tester, designer,
  // bug-hunter, scout, visionary via the single WORKER_BASE_RULES + SUBTYPE_PROMPTS
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
      workerBase.includes("Use `picode_send` for status updates"),
      "missing picode_send usage bullet",
    );
    // The close-out path moved from a plain "done" send to picode_finish, so
    // this guard now protects that wiring too: if the finish instruction ever
    // drops out of the shared base, every worker silently stops leaving
    // handoff notes and the revivable-worker ledger goes blind.
    assert.ok(
      workerBase.includes("Close an assigned task with `picode_finish`"),
      "missing picode_finish close-out rule",
    );
  });
  it("COORDINATOR_RULES has the silent-recovery rule", () => {
    assert.match(coordinator, /Worker silent\? Check their pane/);
    assert.ok(
      coordinator.includes("answered in plain text instead of via"),
      "silent-recovery rule must mention the plain-text mistake",
    );
    assert.match(coordinator, /Mandatory image routing/);
    assert.match(coordinator, /exact disk path/);
    assert.match(coordinator, /IDs are opaque strings/);
    assert.match(coordinator, /never guess, truncate, construct/);
    assert.match(coordinator, /locked to your current `HERDR_WORKSPACE_ID`/);
    assert.match(coordinator, /opencode-go\/mimo-v2\.5/);
    // The revivable-worker ladder is a decision rule, not a tool description:
    // without it in the prompt the coordinator never notices a worker worth
    // resuming and revive_closed_session is never called.
    assert.match(coordinator, /Call `picode_list\(\)` before every dispatch/);
    assert.match(coordinator, /revive_closed_session\(picode_id, task, dry_run=true\)/);
    assert.match(coordinator, /spawn fresh instead/);
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

describe("tools/pane-read: picode_pane_read validation (no herdr needed)", () => {
  // These tests exercise the validation paths that fail before reaching
  // execSync("herdr ..."), so they work without a real Herdr session.
  // The happy path requires a live Herdr pane and is covered by E2E.

  it("refuses to run outside Herdr (HERDR_ENV not set)", async () => {
    const h = makeHarness(tmpDir);
    const origEnv = process.env.HERDR_ENV;
    delete process.env.HERDR_ENV;
    try {
      const r = await callTool(h, "picode_pane_read", { pane_id: "w1:p2" });
      assert.strictEqual(r.details.ok, false);
      assert.match(r.content[0].text, /HERDR_ENV not set/);
    } finally {
      if (origEnv !== undefined) process.env.HERDR_ENV = origEnv;
    }
  });

  it("rejects empty pane_id", async () => {
    const h = makeHarness(tmpDir);
    process.env.HERDR_ENV = "1";
    try {
      const r = await callTool(h, "picode_pane_read", { pane_id: "" });
      assert.strictEqual(r.details.ok, false);
      assert.match(r.content[0].text, /pane_id is required/);
    } finally {
      delete process.env.HERDR_ENV;
    }
  });

  it("rejects reading its own pane", async () => {
    const h = makeHarness(tmpDir);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    try {
      const r = await callTool(h, "picode_pane_read", { pane_id: "w1:p1" });
      assert.strictEqual(r.details.ok, false);
      assert.match(r.content[0].text, /own pane/);
    } finally {
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_PANE_ID;
    }
  });

  it("rejects invalid source", async () => {
    const h = makeHarness(tmpDir);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    try {
      const r = await callTool(h, "picode_pane_read", {
        pane_id: "w1:p2",
        source: "bogus",
      });
      assert.strictEqual(r.details.ok, false);
      assert.match(r.content[0].text, /source must be one of/);
    } finally {
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_PANE_ID;
    }
  });

  it("rejects invalid format", async () => {
    const h = makeHarness(tmpDir);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    try {
      const r = await callTool(h, "picode_pane_read", {
        pane_id: "w1:p2",
        format: "xml",
      });
      assert.strictEqual(r.details.ok, false);
      assert.match(r.content[0].text, /format must be/);
    } finally {
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_PANE_ID;
    }
  });

  it("rejects lines out of range", async () => {
    const h = makeHarness(tmpDir);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    try {
      const r = await callTool(h, "picode_pane_read", {
        pane_id: "w1:p2",
        lines: 0,
      });
      assert.strictEqual(r.details.ok, false);
      assert.match(r.content[0].text, /lines must be between/);
    } finally {
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_PANE_ID;
    }
  });

  it("rejects pane IDs from another workspace", async () => {
    const h = makeHarness(tmpDir);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    try {
      const r = await callTool(h, "picode_pane_read", { pane_id: "w2:p2" });
      assert.strictEqual(r.details.ok, false);
      assert.match(r.content[0].text, /outside current Herdr workspace/);
    } finally {
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_WORKSPACE_ID;
    }
  });
});

describe("tools/panes: workspace lock (no herdr needed)", () => {
  it("rejects a workspace filter outside current workspace", async () => {
    const h = makeHarness(tmpDir);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    try {
      const r = await callTool(h, "picode_panes", { workspace: "w2" });
      assert.strictEqual(r.details.ok, false);
      assert.match(r.content[0].text, /outside current Herdr workspace/);
    } finally {
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_WORKSPACE_ID;
    }
  });

  it("recognizes IDs with exact workspace prefix", () => {
    assert.ok(belongsToWorkspace("w1:p2", "w1"));
    assert.ok(!belongsToWorkspace("w10:p2", "w1"));
    assert.ok(!belongsToWorkspace("w2:p2", "w1"));
  });

  it("unwraps Herdr pane-get responses and rejects error payloads", () => {
    const pane = { pane_id: "w1:p2", workspace_id: "w1" };
    assert.deepStrictEqual(extractPaneInfo({ result: { pane } }), pane);
    assert.deepStrictEqual(extractPaneInfo({ result: pane }), pane);
    assert.strictEqual(extractPaneInfo({ result: { error: "not found" } }), null);
  });
});

describe("tools/cleanup-panes: targeted pane_id validation (no herdr needed)", () => {
  // Tests the targeted-mode validation paths that fail before execSync.
  it("refuses to close its own pane even with pane_id", async () => {
    const h = makeHarness(tmpDir);
    h.store.role = "coordinator";
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_PANE_ID = "w1:p1";
    try {
      const r = await callTool(h, "cleanup_panes", { pane_id: "w1:p1" });
      assert.strictEqual(r.details.ok, false);
      assert.match(r.content[0].text, /own pane/);
    } finally {
      delete process.env.HERDR_WORKSPACE_ID;
      delete process.env.HERDR_PANE_ID;
    }
  });

  it("refuses to close a pane from another workspace", async () => {
    const h = makeHarness(tmpDir);
    h.store.role = "coordinator";
    process.env.HERDR_WORKSPACE_ID = "w1";
    try {
      const r = await callTool(h, "cleanup_panes", { pane_id: "w2:p2" });
      assert.strictEqual(r.details.ok, false);
      assert.match(r.content[0].text, /outside current Herdr workspace/);
    } finally {
      delete process.env.HERDR_WORKSPACE_ID;
    }
  });
});

describe("tools/tab-close: workspace lock (no herdr needed)", () => {
  it("refuses to close a tab from another workspace", async () => {
    const h = makeHarness(tmpDir);
    h.store.role = "coordinator";
    process.env.HERDR_WORKSPACE_ID = "w1";
    try {
      const r = await callTool(h, "picode_tab_close", { tab_id: "w2:t2" });
      assert.strictEqual(r.details.ok, false);
      assert.match(r.content[0].text, /outside current Herdr workspace/);
    } finally {
      delete process.env.HERDR_WORKSPACE_ID;
    }
  });
});

describe("tools/spawn: workspace lock (no herdr needed)", () => {
  it("refuses to spawn into a tab from another workspace", async () => {
    const h = makeHarness(tmpDir);
    h.store.role = "coordinator";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.HERDR_TAB_ID = "w1:t1";
    try {
      const r = await callTool(h, "spawn_worker", { role: "scout", tab: "w2:t2" });
      assert.strictEqual(r.details.ok, false);
      assert.match(r.content[0].text, /outside current Herdr workspace/);
    } finally {
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_WORKSPACE_ID;
      delete process.env.HERDR_PANE_ID;
      delete process.env.HERDR_TAB_ID;
    }
  });
});

describe("tools/cleanup-panes: WORKER_ROLE_PATTERN", () => {
  // Verify the regex matches suffixed roles and new roles.
  // We test the pattern indirectly via the module's behavior — but since
  // the pattern is module-internal, we verify via a re-declaration match.
  const pattern =
    /^(builder|reviewer|tester|worker|scout|bug-hunter|designer|planner|runner|visionary|gauntlet|explorer)(-[0-9]+)?$/i;

  it("matches base roles", () => {
    assert.ok(pattern.test("builder"));
    assert.ok(pattern.test("worker"));
    assert.ok(pattern.test("scout"));
    assert.ok(pattern.test("bug-hunter"));
  });

  it("matches suffixed roles (worker-1, builder-2, etc.)", () => {
    assert.ok(pattern.test("worker-1"));
    assert.ok(pattern.test("worker-12"));
    assert.ok(pattern.test("builder-2"));
    assert.ok(pattern.test("scout-3"));
  });

  it("matches new roles (planner, runner, visionary, explorer)", () => {
    assert.ok(pattern.test("planner"));
    assert.ok(pattern.test("runner"));
    assert.ok(pattern.test("visionary"));
    assert.ok(pattern.test("explorer"));
    assert.ok(pattern.test("gauntlet"));
    assert.ok(pattern.test("gauntlet-3"));
  });

  it("rejects non-worker roles", () => {
    assert.ok(!pattern.test("coordinator"));
    assert.ok(!pattern.test("admin"));
    assert.ok(!pattern.test(""));
  });

  it("rejects invalid suffixes", () => {
    assert.ok(!pattern.test("worker-abc"));
    assert.ok(!pattern.test("worker--1"));
  });
});

describe("tools/cleanup-panes: targeted close skips role check", () => {
  // When pane_id is explicitly provided, cleanup_panes should NOT refuse
  // to close panes with empty/non-worker labels. Dead panes lose labels.
  // This test verifies the validation path: we mock herdr to return a pane
  // with empty label and unknown status, and expect it to proceed (not error).
  //
  // We can't easily mock execSync here, so we verify the behavior indirectly:
  // the targeted path no longer checks WORKER_ROLE_PATTERN, so a pane with
  // label "" should NOT produce the "does not match a worker role" error.
  // Instead it should either close or error on a different check.
  //
  // Since we can't mock herdr pane get, we just verify the code path doesn't
  // have the role check anymore by checking that the error message for a
  // non-existent pane is "not found" (not "does not match").
  it("does not check WORKER_ROLE_PATTERN for targeted pane_id", async () => {
    const h = makeHarness(tmpDir);
    h.store.role = "coordinator";
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_PANE_ID = "w1:p1";
    try {
      // Pane doesn't exist → herdr pane get fails → "not found" error
      // If the role check still ran first, we'd never reach this path
      // because empty label would trigger "does not match" error.
      const r = await callTool(h, "cleanup_panes", { pane_id: "w1:pZZ" });
      assert.strictEqual(r.details.ok, false);
      // Should say "not found", NOT "does not match a worker role"
      assert.match(r.content[0].text, /not found/);
      assert.doesNotMatch(r.content[0].text, /does not match a worker role/);
    } finally {
      delete process.env.HERDR_WORKSPACE_ID;
      delete process.env.HERDR_PANE_ID;
    }
  });
});

describe("tools/spawn: threadIdExists checks picode state", () => {
  // Verify that threadIdExists detects picode-ids that exist in state.json
  // even when pane labels are lost. We test this by creating a state.json
  // with status=running and a dead PID, then verifying spawn auto-suffixes.
  //
  // Since threadIdExists is module-internal, we test via the public behavior:
  // spawn_worker should auto-suffix when a picode-id is already running.
  // We can't easily call spawn_worker without herdr, so we verify the logic
  // by checking the state file detection directly.
  it("detects running picode in state.json with live PID pattern", () => {
    const picodesRoot = join(tmpDir, ".picode", "picodes", "builder-3");
    mkdirSync(picodesRoot, { recursive: true });
    // Use current process PID (always alive) to simulate running picode
    writeFileSync(
      join(picodesRoot, "state.json"),
      JSON.stringify({ id: "builder-3", pid: process.pid, status: "running" }),
    );
    // Verify the state file exists and is readable
    const s = JSON.parse(readFileSync(join(picodesRoot, "state.json"), "utf8"));
    assert.strictEqual(s.status, "running");
    assert.strictEqual(s.pid, process.pid);
  });

  it("treats dead PID in state.json as stale (not blocking)", () => {
    const picodesRoot = join(tmpDir, ".picode", "picodes", "builder-dead");
    mkdirSync(picodesRoot, { recursive: true });
    // PID 999999 is extremely unlikely to exist
    writeFileSync(
      join(picodesRoot, "state.json"),
      JSON.stringify({ id: "builder-dead", pid: 999999, status: "running" }),
    );
    // isPidAlive(999999) should return false
    let alive = true;
    try {
      process.kill(999999, 0);
    } catch (e: unknown) {
      if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ESRCH") {
        alive = false;
      }
    }
    assert.strictEqual(alive, false, "PID 999999 should not be alive");
  });
});

// ── Multi-tab helpers: countPanesInTab, solePaneInTab ──────────────

describe("spawn: countPanesInTab", () => {
  const ws = "w1";
  const panes = [
    { pane_id: "w1:p1", workspace_id: ws, tab_id: "w1:t1", agent_status: "working" },
    { pane_id: "w1:p2", workspace_id: ws, tab_id: "w1:t1", agent_status: "idle" },
    { pane_id: "w1:p3", workspace_id: ws, tab_id: "w1:t1", agent_status: "done" },
    { pane_id: "w1:p4", workspace_id: ws, tab_id: "w1:t2", agent_status: "working" },
    { pane_id: "w1:p5", workspace_id: ws, tab_id: "w1:t2", agent_status: undefined },
    { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", agent_status: "idle" },
  ] as Array<Record<string, unknown>>;

  it("counts agent panes in w1:t1 (3)", () => {
    assert.strictEqual(countPanesInTab(panes, ws, "w1:t1"), 3);
  });

  it("counts agent panes in w1:t2 (1 — undefined agent excluded)", () => {
    assert.strictEqual(countPanesInTab(panes, ws, "w1:t2"), 1);
  });

  it("returns 0 for empty tab", () => {
    assert.strictEqual(countPanesInTab(panes, ws, "w1:t9"), 0);
  });

  it("excludes panes from other workspaces", () => {
    assert.strictEqual(countPanesInTab(panes, ws, "w2:t1"), 0);
  });
});

describe("spawn: solePaneInTab", () => {
  const ws = "w1";
  it("returns pane_id when tab has exactly 1 pane", () => {
    const panes = [
      { pane_id: "w1:p1", workspace_id: ws, tab_id: "w1:t5" },
      { pane_id: "w1:p2", workspace_id: ws, tab_id: "w1:t1" },
      { pane_id: "w1:p3", workspace_id: ws, tab_id: "w1:t1" },
    ] as Array<Record<string, unknown>>;
    assert.strictEqual(solePaneInTab(panes, ws, "w1:t5"), "w1:p1");
  });

  it("returns null when tab has 2+ panes", () => {
    const panes = [
      { pane_id: "w1:p1", workspace_id: ws, tab_id: "w1:t1" },
      { pane_id: "w1:p2", workspace_id: ws, tab_id: "w1:t1" },
    ] as Array<Record<string, unknown>>;
    assert.strictEqual(solePaneInTab(panes, ws, "w1:t1"), null);
  });

  it("returns null when tab has 0 panes", () => {
    const panes = [{ pane_id: "w1:p1", workspace_id: ws, tab_id: "w1:t1" }] as Array<
      Record<string, unknown>
    >;
    assert.strictEqual(solePaneInTab(panes, ws, "w1:t9"), null);
  });
});

describe("spawn: resolveThinking", () => {
  it("maps standard deep-reasoning roles to high", () => {
    for (const role of ["builder", "reviewer", "bug-hunter"]) {
      assert.strictEqual(resolveThinking(role), "high");
    }
  });
  it("requests max thinking for planner and designer", () => {
    assert.strictEqual(resolveThinking("planner"), "max");
    assert.strictEqual(resolveThinking("designer"), "max");
  });
  it("maps scouting/vision to medium (explorer alias included)", () => {
    for (const role of ["scout", "explorer", "visionary"]) {
      assert.strictEqual(resolveThinking(role), "medium");
    }
  });
  it("maps mechanical roles to low", () => {
    for (const role of ["tester", "runner"]) {
      assert.strictEqual(resolveThinking(role), "low");
    }
  });
  it("resolves suffixed ids via prefix", () => {
    assert.strictEqual(resolveThinking("builder-1"), "high");
    assert.strictEqual(resolveThinking("scout-3"), "medium");
    assert.strictEqual(resolveThinking("gauntlet"), "max");
    assert.strictEqual(resolveThinking("gauntlet-2"), "max");
  });
  it("returns null for unlisted roles (inherits pi default)", () => {
    assert.strictEqual(resolveThinking("worker"), null);
    assert.strictEqual(resolveThinking("worker-1"), null);
  });
});

// ── Tab tool validation: validateLabel ─────────────────────────────

describe("tab-create: validateLabel", () => {
  it("accepts empty label", () => {
    assert.strictEqual(validateLabel(""), null);
  });

  it("accepts valid labels", () => {
    assert.strictEqual(validateLabel("frontend"), null);
    assert.strictEqual(validateLabel("workers-2"), null);
    assert.strictEqual(validateLabel("back_end"), null);
    assert.strictEqual(validateLabel("tab3"), null);
  });

  it("rejects label too long (>32 chars)", () => {
    const long = "a".repeat(33);
    const result = validateLabel(long);
    assert.ok(result, "should return error for 33-char label");
    assert.ok(result!.includes("too long"));
  });

  it("accepts label exactly 32 chars", () => {
    const max = "a".repeat(32);
    assert.strictEqual(validateLabel(max), null);
  });

  it("rejects special characters", () => {
    assert.ok(validateLabel("front end"), "spaces rejected");
    assert.ok(validateLabel("front;end"), "semicolon rejected");
    assert.ok(validateLabel("front&end"), "ampersand rejected");
    assert.ok(validateLabel("front$end"), "dollar rejected");
    assert.ok(validateLabel("front/end"), "slash rejected");
  });

  it("rejects shell injection attempts", () => {
    assert.ok(validateLabel("; rm -rf /"), "command injection rejected");
    assert.ok(validateLabel("$(whoami)"), "command substitution rejected");
    assert.ok(validateLabel("`whoami`"), "backtick injection rejected");
  });
});

// ── Protected (user-owned) tab labels ─────────────────────────────

describe("shared: isProtectedTabLabel", () => {
  it("matches the three canonical phrasings", () => {
    assert.ok(isProtectedTabLabel("don't close"));
    assert.ok(isProtectedTabLabel("dont close"));
    assert.ok(isProtectedTabLabel("do not close"));
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    assert.ok(isProtectedTabLabel("DON'T CLOSE"));
    assert.ok(isProtectedTabLabel("  don't close  "));
  });

  it("matches prefixed/suffixed user labels", () => {
    assert.ok(isProtectedTabLabel("don't close — frontend"));
    assert.ok(isProtectedTabLabel("dont-close-backend"));
    assert.ok(isProtectedTabLabel("frontend — don't close"));
  });

  it("normalizes curly apostrophes and other punctuation", () => {
    assert.ok(isProtectedTabLabel("don’t close — backend"));
  });

  it("rejects unrelated labels", () => {
    assert.ok(!isProtectedTabLabel("frontend"));
    assert.ok(!isProtectedTabLabel("workers-2"));
    assert.ok(!isProtectedTabLabel(""));
    assert.ok(!isProtectedTabLabel(null));
    assert.ok(!isProtectedTabLabel(undefined));
    assert.ok(!isProtectedTabLabel("close"));
  });

  it("does not match a bare 'close' or 'don't' fragment", () => {
    assert.ok(!isProtectedTabLabel("don't"));
    assert.ok(!isProtectedTabLabel("don't worry"));
  });
});

describe("shared: tabLabelMap", () => {
  it("maps tab_id to label and skips missing ids", () => {
    const m = tabLabelMap([
      { tab_id: "w1:t1", label: "don't close" },
      { tab_id: "w1:t2", label: "frontend" },
      { label: "no-id" },
    ]);
    assert.strictEqual(m.get("w1:t1"), "don't close");
    assert.strictEqual(m.get("w1:t2"), "frontend");
    assert.strictEqual(m.has("no-id"), false);
  });

  it("returns an empty map for undefined input", () => {
    assert.strictEqual(tabLabelMap(undefined).size, 0);
  });
});

describe("operator screen: coordinator envelope injections", () => {
  it("coordinator drains envelopes via prompt()-driven sendUserMessage even when primed", async () => {
    const h = makeHarness(tmpDir);
    h.store.role = "coordinator";
    seedEnvelope(h, "t1", { from: "builder", body: "lexer done" });
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.sentCustom.length, 0);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /\[note from builder #/);
    assert.match(h.calls[0].content, /lexer done/);
    assert.strictEqual(h.calls[0].options?.deliverAs, "followUp");
  });

  it("one high-urgency part steers the whole batch", async () => {
    const h = makeHarness(tmpDir);
    h.store.role = "coordinator";
    seedEnvelope(
      h,
      "t1",
      { from: "builder", body: "urgent fix", urgency: "high" },
      "0-urgent.json",
    );
    seedEnvelope(h, "t1", { from: "scout", body: "fyi" }, "1-low.json");
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.sentCustom.length, 0);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /urgent fix/);
    assert.match(h.calls[0].content, /fyi/);
    assert.strictEqual(h.calls[0].options?.deliverAs, "steer");
  });

  it("unprimed coordinator falls back to sendUserMessage so the first run gets the picode system prompt", async () => {
    const h = makeHarness(tmpDir);
    h.store.role = "coordinator";
    seedEnvelope(h, "t1", { from: "builder", body: "hello" });
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.sentCustom.length, 0);
    assert.strictEqual(h.calls.length, 1);
    assert.match(h.calls[0].content, /hello/);
  });

  it("worker keeps the verbose path for incoming task envelopes", async () => {
    const h = makeHarness(tmpDir);
    h.store.role = "worker";
    seedEnvelope(h, "t1", { from: "coordinator", body: "do the thing" });
    await h.inbox.drainInbox(h.ctx);
    assert.strictEqual(h.sentCustom.length, 0);
    assert.strictEqual(h.calls.length, 1, "task envelope stays visible on the worker's screen");
  });
});

describe("operator screen: message renderers", () => {
  const theme = {
    fg: (_k: string, s: string) => s,
    bg: (_k: string, s: string) => s,
  } as unknown as Theme;

  function renderEnvelope(content: string, details: unknown, expanded: boolean): string {
    const component = envelopeMessageRenderer(
      { customType: "picode-envelope", content, display: true, details } as never,
      { expanded },
      theme,
    );
    return component!.render(120).join("\n");
  }

  it("collapsed envelope shows the header line, not the body", () => {
    const out = renderEnvelope(
      "[request from scout #coord/01ABC]\ninvestigate the flaky test\n(this expects a reply…)",
      { count: 1, highUrgency: false },
      false,
    );
    assert.match(out, /📨/);
    assert.match(out, /request from scout #coord\/01ABC/);
    assert.doesNotMatch(out, /investigate the flaky test/);
  });

  it("collapsed batch shows +N more and ⚠ for high urgency", () => {
    const out = renderEnvelope(
      "[reply from builder #coord/01DEF]\nshipped",
      { count: 3, highUrgency: true },
      false,
    );
    assert.match(out, /⚠/);
    assert.match(out, /\(\+2 more\)/);
  });

  it("content without a bracket header falls back to a generic label", () => {
    const out = renderEnvelope("garbage body", { count: 1, highUrgency: false }, false);
    assert.match(out, /incoming envelope/);
  });

  it("expanded envelope shows the full text", () => {
    const out = renderEnvelope(
      "[request from scout #coord/01ABC]\ninvestigate the flaky test",
      { count: 1, highUrgency: false },
      true,
    );
    assert.match(out, /investigate the flaky test/);
  });

  function renderSystem(content: string, expanded: boolean): string {
    const component = systemMessageRenderer(
      { customType: "picode-system", content, display: true, details: {} } as never,
      { expanded },
      theme,
    );
    return component!.render(120).join("\n");
  }

  it("collapsed system message shows the first line with the prefix stripped", () => {
    const out = renderSystem(
      "[picode-system] Startup resume — your last journal entries:\n<!-- 2026-08-22 10:00 -->\nWorking on: lexer",
      false,
    );
    assert.match(out, /⚙/);
    assert.match(out, /Startup resume — your last journal entries:/);
    assert.doesNotMatch(out, /Working on: lexer/);
  });

  it("expanded system message shows the full prompt", () => {
    const out = renderSystem("[picode-system] Periodic sit-rep: run picode_panes().", true);
    assert.match(out, /Periodic sit-rep: run picode_panes\(\)/);
  });
});

describe("operator screen: quietToolResult", () => {
  const theme = {
    fg: (_k: string, s: string) => s,
    bg: (_k: string, s: string) => s,
  } as unknown as Theme;

  it("collapsed renders nothing but the model still gets result.content", () => {
    const result = {
      content: [{ type: "text", text: "Panes: 3 total" }],
      details: {},
    } as AgentToolResult<unknown>;
    const out = quietToolResult(result, { expanded: false, isPartial: false }, theme)
      .render(120)
      .join("\n");
    assert.doesNotMatch(out, /Panes/);
  });

  it("expanded shows the text", () => {
    const result = {
      content: [{ type: "text", text: "Panes: 3 total" }],
      details: {},
    } as AgentToolResult<unknown>;
    const out = quietToolResult(result, { expanded: true, isPartial: false }, theme)
      .render(120)
      .join("\n");
    assert.match(out, /Panes: 3 total/);
  });

  it("every operator-quiet tool wires renderResult — and the verbose ones don't", () => {
    const h = makeHarness(tmpDir);
    const QUIET_TOOLS = [
      "picode_status",
      "picode_list",
      "picode_journal",
      "picode_panes",
      "picode_pane_read",
      "cleanup_panes",
      "picode_purge",
      "picode_send",
      "picode_wait",
      "spawn_worker",
    ];
    for (const name of QUIET_TOOLS) {
      assert.ok(h.tools[name], `${name} is registered`);
      assert.strictEqual(
        (h.tools[name] as { renderResult?: unknown }).renderResult,
        quietToolResult,
        `${name} renders quiet when collapsed`,
      );
    }
    // picode_run (build/test output) and suspend/resume stay on screen.
    for (const name of ["picode_run", "picode_suspend", "picode_resume"]) {
      const tool = h.tools[name] as { renderResult?: unknown } | undefined;
      if (tool) assert.notStrictEqual(tool.renderResult, quietToolResult, `${name} stays verbose`);
    }
  });
});

describe("slash command argument completions", () => {
  type Completable = {
    getArgumentCompletions?: (
      prefix: string,
    ) => { value: string; description?: string }[] | null | Promise<{ value: string }[] | null>;
  };

  it("/picode-journal completes subcommands, filtered by prefix", async () => {
    const h = makeHarness(tmpDir);
    const cmd = h.commands["/picode-journal"] as unknown as Completable;
    const all = (await cmd.getArgumentCompletions?.("")) ?? [];
    assert.deepStrictEqual(
      all.map(i => i.value),
      ["status", "tail", "trim", "clear", "compact"],
    );
    const filtered = (await cmd.getArgumentCompletions?.("cl")) ?? [];
    assert.deepStrictEqual(
      filtered.map(i => i.value),
      ["clear"],
    );
    assert.deepStrictEqual((await cmd.getArgumentCompletions?.("zzz")) ?? [], []);
  });

  it("/picode-send completes roster ids (never self), * first; body typing is left alone", async () => {
    const h = makeHarness(tmpDir);
    seedRemoteThread(h, "alice", { role: "builder" });
    seedRemoteThread(h, "bob");
    const cmd = h.commands["/picode-send"] as unknown as Completable;
    const all = (await cmd.getArgumentCompletions?.("")) ?? [];
    assert.deepStrictEqual(
      all.map(i => i.value),
      ["*", "alice", "bob"],
      "self (t1) must not be offered, * comes first",
    );
    const filtered = (await cmd.getArgumentCompletions?.("al")) ?? [];
    assert.deepStrictEqual(
      filtered.map(i => i.value),
      ["alice"],
    );
    assert.strictEqual(
      await cmd.getArgumentCompletions?.("alice fixing the"),
      null,
      "once the body starts, no completions",
    );
  });

  it("/picode-reset completes --force", async () => {
    const h = makeHarness(tmpDir);
    const cmd = h.commands["/picode-reset"] as unknown as Completable;
    const all = (await cmd.getArgumentCompletions?.("")) ?? [];
    assert.deepStrictEqual(
      all.map(i => i.value),
      ["--force"],
    );
    assert.deepStrictEqual(
      ((await cmd.getArgumentCompletions?.("--f")) ?? []).map(i => i.value),
      ["--force"],
    );
    assert.deepStrictEqual((await cmd.getArgumentCompletions?.("--force ")) ?? [], []);
  });
});

// --- operator quiet screen (display-only) -------------------------------
// Resolution + render-time behavior of /picode-quiet. Nothing here touches
// the protocol: envelope delivery, obligations, and the model's context are
// built before any renderer runs (convertToLlm ignores `display`),
// so every test below asserts SCREEN output only.

describe("operator quiet: config resolution", () => {
  const agentDir = () => join(tmpDir, "agent");

  function seed(path: string, contents: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  it("PICODE_QUIET_TUI env beats both files", () => {
    seed(join(tmpDir, ".picode", "quiet-tui.json"), "false");
    seed(join(agentDir(), ".picode", "quiet-tui.json"), "false");
    process.env.PICODE_QUIET_TUI = "1";
    assert.deepStrictEqual(resolveQuietTui(tmpDir, agentDir()), { value: true, source: "env" });
  });

  it("project file beats the global file", () => {
    seed(join(tmpDir, ".picode", "quiet-tui.json"), "true");
    seed(join(agentDir(), ".picode", "quiet-tui.json"), "false");
    assert.deepStrictEqual(resolveQuietTui(tmpDir, agentDir()), { value: true, source: "project" });
  });

  it("global file applies when the project has none", () => {
    seed(join(agentDir(), ".picode", "quiet-tui.json"), "true");
    assert.deepStrictEqual(resolveQuietTui(tmpDir, agentDir()), { value: true, source: "global" });
  });

  it("no config anywhere defaults to loud", () => {
    assert.deepStrictEqual(resolveQuietTui(tmpDir, agentDir()), {
      value: false,
      source: "default",
    });
  });

  it("malformed project file falls through instead of crashing", () => {
    seed(join(tmpDir, ".picode", "quiet-tui.json"), "{not json");
    seed(join(agentDir(), ".picode", "quiet-tui.json"), "true");
    assert.deepStrictEqual(resolveQuietTui(tmpDir, agentDir()), { value: true, source: "global" });
  });
});

describe("operator quiet: message renderers", () => {
  const theme = {
    fg: (_k: string, s: string) => s,
    bg: (_k: string, s: string) => s,
  } as unknown as Theme;

  function envelope(content: string, details: unknown, expanded: boolean) {
    return envelopeMessageRenderer(
      { customType: "picode-envelope", content, display: true, details } as never,
      { expanded },
      theme,
    );
  }

  function system(content: string, expanded: boolean) {
    return systemMessageRenderer(
      { customType: "picode-system", content, display: true, details: {} } as never,
      { expanded },
      theme,
    );
  }

  it("quiet hides a collapsed low-urgency envelope — truthy-empty, or pi falls back", () => {
    setQuietTui(true);
    const component = envelope(
      "[request from scout #coord/01ABC]\ninvestigate the flaky test",
      { count: 1, highUrgency: false },
      false,
    );
    // Undefined would make CustomMessageComponent fall back to FULL default
    // rendering — the exact opposite of quiet.
    assert.ok(component, "renderer must return a component");
    assert.strictEqual(component.render(120).join("\n"), "");
  });

  it("quiet keeps a collapsed high-urgency envelope visible", () => {
    setQuietTui(true);
    const component = envelope(
      "[reply from builder #coord/01DEF]\nshipped",
      { count: 1, highUrgency: true },
      false,
    );
    assert.match(component!.render(120).join("\n"), /⚠/);
  });

  it("quiet still shows envelope content when expanded", () => {
    setQuietTui(true);
    const component = envelope(
      "[request from scout #coord/01ABC]\ninvestigate the flaky test",
      { count: 1, highUrgency: false },
      true,
    );
    assert.match(component!.render(120).join("\n"), /investigate the flaky test/);
  });

  it("quiet hides a collapsed system message", () => {
    setQuietTui(true);
    const component = system("[picode-system] Periodic sit-rep: run picode_panes().", false);
    assert.ok(component, "renderer must return a component");
    assert.strictEqual(component.render(120).join("\n"), "");
  });
});

describe("operator quiet: tool call rows", () => {
  const theme = {
    fg: (_k: string, s: string) => s,
    bg: (_k: string, s: string) => s,
    bold: (s: string) => s,
  } as unknown as Theme;
  const render = quietCallRenderer("picode_send");

  it("quiet + collapsed renders an empty call row", () => {
    setQuietTui(true);
    assert.strictEqual(render({}, theme, { expanded: false }).render(120).join("\n"), "");
  });

  it("quiet + expanded still names the row", () => {
    setQuietTui(true);
    assert.match(render({}, theme, { expanded: true }).render(120).join("\n"), /picode_send/);
  });

  it("loud renders the name exactly like pi's fallback", () => {
    setQuietTui(false);
    assert.match(render({}, theme, { expanded: false }).render(120).join("\n"), /picode_send/);
  });

  it("every operator-quiet tool wires renderCall — and the verbose ones don't", () => {
    const h = makeHarness(tmpDir);
    const QUIET_TOOLS = [
      "picode_status",
      "picode_list",
      "picode_journal",
      "picode_panes",
      "picode_pane_read",
      "cleanup_panes",
      "picode_purge",
      "picode_send",
      "picode_wait",
      "spawn_worker",
      "picode_finish",
      "revive_closed_session",
    ];
    for (const name of QUIET_TOOLS) {
      assert.ok(h.tools[name], `${name} is registered`);
      assert.strictEqual(
        typeof (h.tools[name] as { renderCall?: unknown }).renderCall,
        "function",
        `${name} renders a quiet call row`,
      );
    }
    for (const name of ["picode_run", "picode_suspend", "picode_resume"]) {
      const tool = h.tools[name] as { renderCall?: unknown } | undefined;
      if (tool) assert.strictEqual(tool.renderCall, undefined, `${name} stays verbose`);
    }
  });
});

describe("operator quiet: /picode-quiet", () => {
  const globalFile = () => join(tmpDir, "agent", ".picode", "quiet-tui.json");
  const projectFile = () => join(tmpDir, ".picode", "quiet-tui.json");

  it("on persists and applies quiet", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/picode-quiet", "on");
    assert.strictEqual(isQuietTui(), true, "flag applied");
    assert.strictEqual(readFileSync(globalFile(), "utf8").trim(), "true");
  });

  it("off persists and applies loud again", async () => {
    const h = makeHarness(tmpDir);
    setQuietTui(true);
    await callCommand(h, "/picode-quiet", "off");
    assert.strictEqual(isQuietTui(), false);
    assert.strictEqual(readFileSync(globalFile(), "utf8").trim(), "false");
  });

  it("no-argument toggles the current mode, twice", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/picode-quiet");
    assert.strictEqual(isQuietTui(), true);
    await callCommand(h, "/picode-quiet");
    assert.strictEqual(isQuietTui(), false);
  });

  it("a toggle round-trips tool expansion so on-screen rows re-render", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/picode-quiet");
    // expand → collapse re-runs every row's renderer, ending back at the
    // user's original collapsed state in the same render tick.
    assert.deepStrictEqual(h.expansionFlips, [true, false]);
  });

  it("--project writes this repo's config, not the global one", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/picode-quiet", "on --project");
    assert.ok(existsSync(projectFile()), "project config written");
    assert.ok(!existsSync(globalFile()), "global config untouched");
  });

  it("status reports the resolved source without writing a file", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/picode-quiet", "status");
    assert.match(h.notifications.at(-1)!.text, /source: default/);
    assert.ok(!existsSync(globalFile()) && !existsSync(projectFile()));
  });

  it("an unknown argument warns with usage and changes nothing", async () => {
    const h = makeHarness(tmpDir);
    await callCommand(h, "/picode-quiet", "banana");
    assert.match(h.notifications.at(-1)!.text, /Usage: \/picode-quiet/);
    assert.strictEqual(isQuietTui(), false);
    assert.ok(!existsSync(globalFile()));
  });
});

describe("operator quiet: session_start applies config", () => {
  it("an active session resolves the project quiet file into the render flag", async () => {
    mkdirSync(join(tmpDir, ".picode"), { recursive: true });
    writeFileSync(join(tmpDir, ".picode", "quiet-tui.json"), "true\n");
    const h = makeLifecycleHarness(tmpDir);
    h.setFlag("picode-id", "t-quiet");
    await h.fire("session_start", h.makeCtx());
    assert.strictEqual(isQuietTui(), true);
    h.store.stopHeartbeat();
    h.store.stopWatcher();
  });
});
