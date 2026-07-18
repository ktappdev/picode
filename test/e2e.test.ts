/**
 * Curated end-to-end tests — each spawns a real `pi` subprocess with a real
 * DeepSeek model call. Every test here exists because it proves something
 * a unit test (test/unit.test.ts) structurally cannot: genuine ambiguity
 * resolution by the model, comprehension of rendered structured text, or a
 * real subprocess/cross-process boundary (lifecycle hooks, `pi --fork`
 * journal spawning, two independently-started processes sharing a
 * filesystem). See TESTING.md before adding a case here — if the prompt is
 * fully scripted ("call X with params Y"), the thing it exercises probably
 * already has (or belongs in) a unit test instead.
 *
 * Assertions read state.json / written files as ground truth. Where a
 * stdout check adds real signal it's kept loose — never a strict regex on
 * the model's exact phrasing (that's the single biggest source of flaky
 * failures this suite has hit historically).
 *
 * Run: npm run test:e2e (minutes, real API cost)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const EXT = join(import.meta.dirname!, "..", "src", "index.ts");
const TIMEOUT = 120_000;

// Volta refuses to resolve `pi` outside a project that declares it, and its
// shim uses the pinned Node. Use node 22.21.1 + pi binary directly.
const HOME = process.env.HOME ?? "";
const PI_NODE = join(HOME, ".volta/tools/image/node/22.21.1/bin/node");
const PI_SCRIPT = join(HOME, ".volta/tools/image/packages/@earendil-works/pi-coding-agent/bin/pi");

function runPi(
  prompt: string,
  cwd: string,
  opts: { session?: boolean; picodeId?: string; parent?: string } = {},
): { stdout: string; stderr: string; ok: boolean } {
  // --no-session means getSessionFile() returns undefined, blocking journal forks.
  // Use a real session dir when the test needs the journal to be written.
  const sessionArgs = opts.session
    ? ["--session-dir", join(cwd, ".sessions"), "--session-id", "test-session"]
    : ["--no-session"];
  const threadArgs = [
    ...(opts.picodeId ? ["--picode-id", opts.picodeId] : []),
    ...(opts.parent ? ["--picode-parent", opts.parent] : []),
  ];
  const result = spawnSync(
    PI_NODE,
    [
      PI_SCRIPT,
      "--extension",
      EXT,
      "--model",
      process.env.PI_E2E_MODEL ?? "deepseek/deepseek-chat",
      "--thinking",
      "off",
      ...sessionArgs,
      ...threadArgs,
      "--print",
      prompt,
    ],
    { cwd, timeout: TIMEOUT, encoding: "utf8" },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ok: result.status === 0,
  };
}

function readState(dir: string, picodeId: string) {
  const f = join(dir, ".picode", "threads", picodeId, "state.json");
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8"));
}

function readJournal(dir: string, picodeId: string): string {
  const f = join(dir, ".picode", "threads", picodeId, "journal.md");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

function inboxFiles(dir: string, picodeId: string, sub: "" | "processed" = ""): string[] {
  const d = join(dir, ".picode", "threads", picodeId, "inbox", sub);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter(f => f.endsWith(".json"));
}

// The system prompt tells agents to check picode_list and avoid dead threads,
// so fictional partners must exist with a fresh lastSeen or the model refuses.
function seedThread(dir: string, id: string, opts: { stale?: boolean } = {}) {
  const threadDir = join(dir, ".picode", "threads", id);
  mkdirSync(join(threadDir, "inbox", "processed"), { recursive: true });
  const now = opts.stale
    ? new Date(Date.now() - 5 * 60_000).toISOString()
    : new Date().toISOString();
  writeFileSync(
    join(threadDir, "state.json"),
    JSON.stringify({
      id,
      pid: 999999,
      cwd: dir,
      parent: null,
      role: null,
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
    }),
  );
}

/** Drop an envelope file into a picode's inbox the way a C1 actor would. */
function seedEnvelope(
  dir: string,
  ownerThreadId: string,
  msg: { from: string; body: string; id?: string; re?: string; expects?: true; urgency?: "high" },
  name = `${Date.now()}-seed.json`,
) {
  const inboxDir = join(dir, ".picode", "threads", ownerThreadId, "inbox");
  mkdirSync(inboxDir, { recursive: true });
  const envelope = {
    id: msg.id ?? `${msg.from}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    to: ownerThreadId,
    sentAt: new Date().toISOString(),
    ...msg,
  };
  writeFileSync(join(inboxDir, name), JSON.stringify(envelope));
  return envelope;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-picode-e2e-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("lifecycle", () => {
  it("a run with no tool calls ends at done", { timeout: TIMEOUT }, () => {
    const r = runPi("Say the word 'hello' and nothing else.", tmpDir, { picodeId: "t1" });
    assert.ok(r.ok);

    const s = readState(tmpDir, "t1");
    assert.ok(s !== null);
    assert.strictEqual(s.state, "done");
  });
});

describe("journal", () => {
  it("a turn that uses a tool produces a forked journal entry", { timeout: TIMEOUT }, () => {
    // Must use a real session: --no-session makes getSessionFile() return undefined,
    // which blocks forkJournal. The forked child keeps the parent alive until done,
    // so spawnSync already waits for the journal to be written — no sleep needed.
    // Needs the real `pi --fork` subprocess spawn — not reachable from a unit test.
    runPi("List the files in the current directory using the bash tool. Then say done.", tmpDir, {
      session: true,
      picodeId: "t1",
    });

    const journal = readJournal(tmpDir, "t1");
    assert.ok(journal.length > 10);
    assert.match(journal, /Working on:/i);
  });
});

describe("cross-process durability", () => {
  it(
    "a message written before the target ever starts is drained on its first session_start",
    { timeout: TIMEOUT },
    () => {
      seedEnvelope(tmpDir, "picode-a", { from: "outside", body: "seeded before start" });

      const r = runPi("Say 'ok'.", tmpDir, { picodeId: "picode-a" });
      assert.ok(r.ok);

      assert.strictEqual(inboxFiles(tmpDir, "picode-a").length, 0);
      assert.strictEqual(inboxFiles(tmpDir, "picode-a", "processed").length, 1);
    },
  );

  it(
    "a natural request to notify a teammate is discovered, delivered, and drains on their next start",
    { timeout: TIMEOUT * 2 },
    () => {
      // Needs to exist with a fresh lastSeen for the model to find it via
      // picode_list (the system prompt requires that lookup before sending)
      // — but picode-a itself hasn't actually run yet, so this still proves
      // real drain-on-first-session_start, just discovered rather than
      // hardcoded as the target the way the old scripted version was.
      seedThread(tmpDir, "picode-a");
      const r = runPi(
        "Let picode-a know you're starting work on the auth module. Then say done.",
        tmpDir,
        { picodeId: "picode-b" },
      );
      assert.ok(r.ok);

      const files = inboxFiles(tmpDir, "picode-a");
      assert.strictEqual(files.length, 1);
      const delivered = JSON.parse(
        readFileSync(join(tmpDir, ".picode", "threads", "picode-a", "inbox", files[0]), "utf8"),
      );
      // "Let them know" is a note or a request — either is defensible; what
      // matters is the envelope is well-formed and correctly attributed.
      assert.strictEqual(delivered.from, "picode-b");
      assert.match(delivered.id, /^picode-b\//);
      assert.ok(!delivered.re, "an unprompted notification is not a reply");

      const r2 = runPi("Say 'ok'.", tmpDir, { picodeId: "picode-a" });
      assert.ok(r2.ok);
      assert.strictEqual(inboxFiles(tmpDir, "picode-a").length, 0);
      assert.strictEqual(inboxFiles(tmpDir, "picode-a", "processed").length, 1);
    },
  );
});

describe("delegation", () => {
  it(
    "a natural request to delegate work creates an obligation a matching reply clears",
    { timeout: TIMEOUT * 2 },
    () => {
      seedThread(tmpDir, "picode-b");
      const r = runPi(
        "Ask picode-b to implement the login form and make sure you'll hear back when it's done. Then say done.",
        tmpDir,
        { picodeId: "picode-a" },
      );
      assert.ok(r.ok);

      let s = readState(tmpDir, "picode-a");
      assert.strictEqual(s?.obligations?.length, 1);
      const id = s.obligations[0].id;
      assert.match(id, /^picode-a\//);

      seedEnvelope(tmpDir, "picode-a", { from: "picode-b", body: "done", re: id });
      runPi("Say 'ok'.", tmpDir, { picodeId: "picode-a" });

      s = readState(tmpDir, "picode-a");
      assert.strictEqual(s?.obligations?.length ?? 0, 0);
    },
  );
});

describe("escalation", () => {
  it(
    "a natural 'I'm stuck' escalates to the parent as a tracked request",
    { timeout: TIMEOUT },
    () => {
      seedThread(tmpDir, "boss");
      const r = runPi(
        "You're stuck and can't proceed without a decision. Let your parent know you need one. Then say done.",
        tmpDir,
        { picodeId: "t1", parent: "boss" },
      );
      assert.ok(r.ok);

      const s = readState(tmpDir, "t1");
      assert.strictEqual(s?.obligations?.length, 1);
      assert.strictEqual(s.obligations[0].to, "boss");
    },
  );
});

describe("envelope comprehension", () => {
  it(
    "a received request carries its id so the model can correctly echo it back as re",
    { timeout: TIMEOUT },
    () => {
      seedThread(tmpDir, "boss");
      seedEnvelope(tmpDir, "t1", {
        from: "boss",
        id: "boss/QTEST42",
        body: "What is 2+2? Reply with just the number.",
        expects: true,
        urgency: "high",
      });

      const r = runPi(
        "If you received a request from another picode, answer it via the tool indicated in the message. Then say done.",
        tmpDir,
        { picodeId: "t1" },
      );
      assert.ok(r.ok);

      const bossInbox = inboxFiles(tmpDir, "boss");
      assert.strictEqual(bossInbox.length, 1);
      const reply = JSON.parse(
        readFileSync(join(tmpDir, ".picode", "threads", "boss", "inbox", bossInbox[0]), "utf8"),
      );
      assert.strictEqual(reply.re, "boss/QTEST42");
      assert.strictEqual(reply.from, "t1");

      // The owed record must be settled by the reply.
      const s = readState(tmpDir, "t1");
      assert.strictEqual(s?.owed?.length ?? 0, 0);
    },
  );
});

describe("picode_list", () => {
  it("surfaces real threads and reports a stale one as stopped", { timeout: TIMEOUT * 3 }, () => {
    runPi("Say 'ok'.", tmpDir, { picodeId: "picode-a" });
    runPi("Say 'ok'.", tmpDir, { picodeId: "picode-b" });
    seedThread(tmpDir, "ghost", { stale: true });

    const r = runPi(`Call picode_list and report every id you see along with its status.`, tmpDir, {
      picodeId: "picode-c",
    });
    assert.match(r.stdout, /picode-a/);
    assert.match(r.stdout, /picode-b/);
    assert.match(r.stdout, /ghost/);
    assert.match(r.stdout, /stopped/i);
  });
});

describe("fan-out and wait", () => {
  it(
    "delegating to two threads and waiting on both arms a barrier the replies resolve",
    { timeout: TIMEOUT * 2 },
    () => {
      seedThread(tmpDir, "alice");
      seedThread(tmpDir, "bob");

      const r1 = runPi(
        `Send a tracked request (expects=true) to alice and a separate one to bob asking them to review the PR. Note the id each send returns, then call picode_wait waiting on both of those ids together (mode="all"). Then say done.`,
        tmpDir,
        { picodeId: "t1" },
      );
      assert.ok(r1.ok);

      let s = readState(tmpDir, "t1");
      assert.strictEqual(s?.obligations?.length, 2);
      assert.strictEqual(s?.barriers?.length, 1);

      // Seed a reply per unique id across obligations and the barrier — the
      // model occasionally mistranscribes an id into picode_wait, and this
      // test is about the resolution mechanics, not model copying accuracy.
      const ids = new Set<string>([
        ...s.obligations.map((o: { id: string }) => o.id),
        ...s.barriers[0].pending,
      ]);
      let i = 0;
      for (const id of ids) {
        seedEnvelope(
          tmpDir,
          "t1",
          { from: ++i === 1 ? "alice" : "bob", body: "done", re: id },
          `${i}-reply.json`,
        );
      }

      const r2 = runPi("Say 'ok'.", tmpDir, { picodeId: "t1" });
      assert.ok(r2.ok);

      s = readState(tmpDir, "t1");
      assert.strictEqual(s?.obligations?.length ?? 0, 0);
      assert.strictEqual(s?.barriers?.length ?? 0, 0);
    },
  );
});

describe("scheduled self-wake", () => {
  it(
    "a natural 'remind yourself shortly' becomes a deliverAfter self-send that arrives once due",
    { timeout: TIMEOUT * 2 },
    () => {
      // Far enough out that it cannot come due while the first run is still
      // alive — a short delay races the in-process drain: once due, the
      // heartbeat delivers the reminder to the same session and the "held
      // until the next run" assertion below reads an already-drained inbox.
      const r = runPi(
        "Schedule a reminder to yourself for 10 minutes from now saying 'check the build'. Then say done.",
        tmpDir,
        { picodeId: "t1" },
      );
      assert.ok(r.ok);

      // The wake is a durable self-addressed envelope, held until due.
      const pending = inboxFiles(tmpDir, "t1");
      assert.strictEqual(pending.length, 1);
      const envelopePath = join(tmpDir, ".picode", "threads", "t1", "inbox", pending[0]);
      const msg = JSON.parse(readFileSync(envelopePath, "utf8"));
      assert.strictEqual(msg.to, "t1");
      assert.strictEqual(msg.from, "t1");
      assert.ok(msg.deliverAfter);
      assert.ok(new Date(msg.deliverAfter).getTime() > Date.now(), "held: not yet due");

      // Backdate the envelope on disk (a C1 actor owns these files) instead
      // of sleeping out the delay: by the next run it's due — boot drain
      // delivers and clears it.
      writeFileSync(
        envelopePath,
        JSON.stringify({ ...msg, deliverAfter: new Date(Date.now() - 1000).toISOString() }),
      );
      const r2 = runPi("Say 'ok'.", tmpDir, { picodeId: "t1" });
      assert.ok(r2.ok);
      assert.strictEqual(inboxFiles(tmpDir, "t1").length, 0);
    },
  );
});
