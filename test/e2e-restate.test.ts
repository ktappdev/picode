/**
 * Small, curated proof that RestateAdapter and the PicodeObject/PicodeRegistry
 * service actually work against a real Restate server — no fs involved, no
 * model calls. Needs Docker (spins up a real restate-server container via
 * @restatedev/restate-sdk-testcontainers) and takes real wall-clock time to
 * start/stop the container, so it's kept separate from both test:unit (no
 * subprocess at all) and test:e2e (real `pi` + model calls) — see
 * package.json's `test:e2e:restate` script.
 *
 * What's deliberately NOT covered here: the `deliverDue` handler's "spawn pi
 * when the picode isn't live" branch. Proving a stopped picode actually gets
 * revived needs a real `pi` binary + API key, which belongs in a manual
 * sanity check (see README.md "Running with the Restate adapter"), not an
 * automated test — the storage/delayed-delivery behavior below is what's
 * actually verifiable without that cost.
 *
 * Run: npm run test:e2e:restate (needs Docker; a few seconds container
 * startup/teardown, no API cost)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { PicodeObject, PicodeRegistry } from "../src/restate/service";
import { createRestateAdapter } from "../src/restate/adapter";
import type { StorageAdapter, JournalAdapter } from "../src/adapter/types";
import type { StateFile, Envelope } from "../src/core/types";

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

function envelope(from: string, to: string, body: string, extra: Partial<Envelope> = {}): Envelope {
  return {
    id: `${from}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    from,
    to,
    body,
    sentAt: new Date().toISOString(),
    ...extra,
  };
}

let env: RestateTestEnvironment;
let adapter: StorageAdapter & JournalAdapter;

describe("RestateAdapter against a real restate-server (testcontainers)", () => {
  before(async () => {
    env = await RestateTestEnvironment.start({ services: [PicodeObject, PicodeRegistry] });
    adapter = createRestateAdapter({ url: env.baseUrl() });
  });

  after(async () => {
    await env.stop();
  });

  it("savePicodeState/loadPicodeState round-trips through the Picode virtual object", async () => {
    await adapter.configure("/unused");
    await adapter.savePicodeState("picode-a", baseState("picode-a"));
    const loaded = await adapter.loadPicodeState("picode-a");
    assert.strictEqual(loaded?.id, "picode-a");
  });

  it("loadPicodeState/threadExists reflect an unknown picode correctly", async () => {
    assert.strictEqual(await adapter.loadPicodeState("ghost"), undefined);
    assert.strictEqual(await adapter.threadExists("ghost"), false);
  });

  it("enqueueMessage + drainInbox delivers durably with no local filesystem involved", async () => {
    await adapter.enqueueMessage(envelope("picode-a", "picode-b", "hi via restate"));
    const claimed = await adapter.drainInbox("picode-b");
    assert.strictEqual(claimed.length, 1);
    assert.strictEqual(claimed[0].body, "hi via restate");
    assert.deepStrictEqual(await adapter.drainInbox("picode-b"), []);
  });

  it("a retry with the same id does not duplicate the envelope (§7.6)", async () => {
    const msg = envelope("picode-a", "picode-e", "retry me");
    await adapter.enqueueMessage(msg);
    await adapter.enqueueMessage(msg);
    const claimed = await adapter.drainInbox("picode-e");
    assert.strictEqual(claimed.length, 1);
  });

  it("a deliverAfter envelope stays queued until due, then drains (§6)", async () => {
    await adapter.savePicodeState("picode-d", baseState("picode-d"));
    await adapter.enqueueMessage(
      envelope("picode-a", "picode-d", "later", {
        deliverAfter: new Date(Date.now() + 1500).toISOString(),
      }),
    );
    assert.deepStrictEqual(await adapter.drainInbox("picode-d"), [], "not due yet");
    await new Promise(r => setTimeout(r, 1800));
    const claimed = await adapter.drainInbox("picode-d");
    assert.strictEqual(claimed.length, 1);
    assert.strictEqual(claimed[0].body, "later");
  });

  it("listPcodes enumerates threads via the registry, not a directory listing", async () => {
    await adapter.savePicodeState("picode-c", baseState("picode-c"));
    const threads = await adapter.listPcodes();
    assert.ok(threads.some(t => t.id === "picode-c"));
  });
});
