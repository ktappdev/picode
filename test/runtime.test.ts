import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { detectRuntime } from "../src/runtime/detect";
import { TuiosClient } from "../src/runtime/tuios-client";
import { TuiosRuntime } from "../src/runtime/tuios";
import { startTuiosListener } from "../src/runtime/tuios-listener";

// No real runtime environment is consulted in these tests. In particular,
// never open the inherited Herdr/TUIOS daemon socket from a developer pane.
const clear = () => ({
  HERDR_ENV: "",
  HERDR_PANE_ID: "",
  TUIOS_SESSION: "",
  TUIOS_PANE_ID: "",
  TUIOS_SOCKET: "",
});

describe("multiplexer selection", () => {
  it("leaves a standalone Pi session unmanaged", () =>
    assert.equal(detectRuntime(clear()), "none"));
  it("preserves Herdr auto-detection", () =>
    assert.equal(detectRuntime({ ...clear(), HERDR_ENV: "1", HERDR_PANE_ID: "w:p" }), "herdr"));
  it("selects TUIOS when its full pane identity is present", () =>
    assert.equal(
      detectRuntime({
        ...clear(),
        TUIOS_SOCKET: "/tmp/tuios",
        TUIOS_SESSION: "work",
        TUIOS_PANE_ID: "pane",
      }),
      "tuios",
    ));
  it("recognizes TUIOS's input-only Herdr reporting socket", () =>
    assert.equal(
      detectRuntime({
        ...clear(),
        HERDR_ENV: "1",
        HERDR_PANE_ID: "pane",
        HERDR_SOCKET_PATH: "/tmp/tuios.herdr",
        TUIOS_SOCKET: "/tmp/tuios",
        TUIOS_SESSION: "work",
        TUIOS_PANE_ID: "pane",
      }),
      "tuios",
    ));
  it("refuses two distinct multiplexers without an override", () =>
    assert.throws(
      () =>
        detectRuntime({
          ...clear(),
          HERDR_ENV: "1",
          HERDR_PANE_ID: "outer",
          TUIOS_SOCKET: "/tmp/tuios",
          TUIOS_SESSION: "work",
          TUIOS_PANE_ID: "inner",
        }),
      /Both Herdr and TUIOS/,
    ));
  it("honours the explicit Herdr override", () =>
    assert.equal(
      detectRuntime({
        ...clear(),
        PICODE_RUNTIME: "herdr",
        HERDR_ENV: "1",
        HERDR_PANE_ID: "outer",
        TUIOS_SOCKET: "/tmp/tuios",
        TUIOS_SESSION: "work",
        TUIOS_PANE_ID: "inner",
      }),
      "herdr",
    ));
  it("rejects incomplete and invalid explicit selections", () => {
    assert.throws(
      () => detectRuntime({ ...clear(), PICODE_RUNTIME: "tuios", TUIOS_SOCKET: "/tmp/tuios" }),
      /needs TUIOS_SOCKET/,
    );
    assert.throws(
      () => detectRuntime({ ...clear(), PICODE_RUNTIME: "bad" }),
      /Invalid PICODE_RUNTIME/,
    );
  });
});

const sockets: Array<{ close: () => void; dir: string }> = [];
afterEach(() => {
  for (const item of sockets.splice(0)) {
    item.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

async function fakeDaemon(reply: (request: Record<string, unknown>) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), "picode-tuios-"));
  const path = join(dir, "socket");
  const server = createServer(socket => {
    let data = "";
    socket.on("data", chunk => {
      data += chunk.toString();
      const nl = data.indexOf("\n");
      if (nl < 0) return;
      const request = JSON.parse(data.slice(0, nl)) as Record<string, unknown>;
      socket.write(`${JSON.stringify(reply(request))}\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  sockets.push({ dir, close: () => server.close() });
  return new TuiosClient(path);
}

describe("TUIOS session-scoped runtime", () => {
  it("rejects any pane outside the coordinator's session", async () => {
    const routedSessions: unknown[] = [];
    let reportedWorkerCwd = "/tmp/worker";
    const client = await fakeDaemon(request => {
      if (request.verb !== "hello" && request.verb !== "list-verbs") {
        routedSessions.push((request.params as Record<string, unknown> | undefined)?.session);
      }
      switch (request.verb) {
        case "hello":
          return { id: request.id, result: { type: "hello", protocol: 1 } };
        case "list-verbs":
          return {
            id: request.id,
            result: {
              verbs: [
                "session-info",
                "list-windows",
                "list-workspaces",
                "list-agents",
                "new-window",
                "close-window",
                "set-window",
                "set-workspace-name",
                "capture-pane",
                "send-keys",
                "wait-for",
                "subscribe",
              ].map(verb => ({ verb })),
            },
          };
        case "session-info":
          return { id: request.id, result: { session_name: "work", session_id: "uuid" } };
        case "list-windows":
          return {
            id: request.id,
            result: {
              windows: [
                { window_id: "mine", workspace: 1, cwd: "/tmp", agent_state: "working" },
                {
                  window_id: "worker",
                  workspace: 2,
                  // New windows can briefly appear before PTY cwd is reported.
                  custom_name: "builder",
                  agent_state: "needs_input",
                },
              ],
            },
          };
        case "list-agents":
          return {
            id: request.id,
            result: {
              session: "work",
              agents: [
                { session: "work", window_id: "worker", cwd: reportedWorkerCwd },
                { session: "other", window_id: "other-worker", cwd: "/unsafe" },
              ],
            },
          };
        case "list-workspaces":
          return {
            id: request.id,
            result: {
              workspaces: Array.from({ length: 9 }, (_, index) => ({
                workspace: index + 1,
                name: "",
                window_count: 0,
              })),
            },
          };
      }
      return { id: request.id, error: { code: "unknown_verb", message: "unexpected" } };
    });
    const runtime = new TuiosRuntime({
      TUIOS_SOCKET: client.socketPath,
      TUIOS_SESSION: "work",
      TUIOS_PANE_ID: "mine",
    });
    await runtime.refresh();
    assert.equal(runtime.pane("worker").status, "blocked");
    assert.equal(runtime.pane("worker").cwd, "/tmp/worker");
    runtime.rememberWindowCwd("worker", "/tmp/remembered");
    reportedWorkerCwd = "";
    await runtime.refresh();
    assert.equal(runtime.pane("worker").cwd, "/tmp/remembered");
    assert.throws(() => runtime.pane("elsewhere"), /not in this TUIOS session/);
    assert.throws(() => runtime.tab("another-session:t2"), /outside the current TUIOS session/);
    assert.equal(runtime.tabNumber(runtime.tabFor(2)), 2);
    await runtime.call("list-windows", { session: "another-session" });
    assert.equal(routedSessions.at(-1), "work", "caller params cannot override the session lock");
  });
});

describe("TUIOS listener recovery", () => {
  it("reconciles a tracked window after a dropped subscription and replays from the last sequence", async () => {
    const subscriptions: Array<{
      params: Record<string, unknown>;
      event: (event: Record<string, unknown>) => void;
      disconnect: (error: Error) => void;
    }> = [];
    const notices: string[] = [];
    let windows = ["own", "worker"];
    let stopped = 0;
    const runtime = {
      session: "work",
      get panes() {
        return windows.map(id => ({ id, label: id }));
      },
      async refresh() {
        return runtime;
      },
      client: {
        subscribe(
          params: Record<string, unknown>,
          event: (event: Record<string, unknown>) => void,
          disconnect: (error: Error) => void,
          ack?: (value: Record<string, unknown>) => void,
        ) {
          subscriptions.push({ params, event, disconnect });
          queueMicrotask(() => ack?.({ seq: 8, boot_id: "boot-1" }));
          return () => {
            stopped++;
          };
        },
      },
    };
    const handle = startTuiosListener(
      runtime as unknown as TuiosRuntime,
      { inject: (messages: Array<{ text: string }>) => notices.push(messages[0].text) } as never,
      {} as never,
    );
    try {
      handle.trackPane("worker");
      await new Promise<void>(resolve => queueMicrotask(resolve));
      subscriptions[0].event({ type: "window-closed", session: "other", window: "worker", seq: 8 });
      assert.equal(handle.trackedPaneCount(), 1, "unrelated sessions cannot close our worker");
      subscriptions[0].event({
        type: "window-closed",
        session: "work",
        window: "untracked",
        seq: 9,
      });
      assert.equal(handle.trackedPaneCount(), 1, "unrelated sessions cannot close our worker");
      await new Promise(resolve => setTimeout(resolve, 5_050));
      subscriptions[0].disconnect(new Error("socket dropped"));
      windows = ["own"];
      await new Promise(resolve => setTimeout(resolve, 1_100));
      assert.equal(subscriptions.length, 2);
      assert.equal(subscriptions[1].params.after_seq, 9);
      assert.equal(subscriptions[1].params.boot_id, "boot-1");
      assert.equal(handle.trackedPaneCount(), 0);
      assert.equal(notices.length, 1);
      assert.match(notices[0], /worker.*closed while TUIOS was disconnected/);
    } finally {
      handle.stop();
    }
    assert.equal(stopped, 1, "shutdown closes the active subscription");
  });
});

describe("TUIOS JSON transport", () => {
  it("correlates a structured response", async () => {
    const client = await fakeDaemon(request => ({
      id: request.id,
      result: { type: "ok", window_id: "id" },
    }));
    assert.equal((await client.request("list-windows", { session: "work" })).window_id, "id");
  });
  it("rejects remote failures without changing state", async () => {
    const client = await fakeDaemon(request => ({
      id: request.id,
      error: { code: "forbidden", message: "read only" },
    }));
    await assert.rejects(client.request("new-window", {}), /forbidden: read only/);
  });
  it("rejects mismatched request IDs", async () => {
    const client = await fakeDaemon(() => ({ id: -1, result: { type: "ok" } }));
    await assert.rejects(client.request("list-windows"), /ID mismatch/);
  });
  it("closes a subscription that never acknowledges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-tuios-silent-"));
    const path = join(dir, "socket");
    const server = createServer(() => {});
    await new Promise<void>(resolve => server.listen(path, resolve));
    sockets.push({ dir, close: () => server.close() });
    const client = new TuiosClient(path);
    const disconnected = new Promise<Error>(resolve => {
      client.subscribe({}, () => {}, resolve, undefined, 20);
    });
    const error = await disconnected;
    assert.match(error.message, /timed out waiting for acknowledgement/);
  });
});
