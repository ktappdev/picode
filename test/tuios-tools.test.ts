/**
 * Focused, deterministic tests for the TUIOS model-facing pane tools.
 *
 * Everything is mocked: a scripted `TuiosRuntime` stand-in, a stub `pi` that
 * captures registered tools, and a stub store. No socket is opened and no
 * daemon or Herdr/TUIOS environment variable is consulted, so these tests
 * cannot touch the developer's live multiplexer.
 *
 * Run: node --import tsx --test test/tuios-tools.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PicodeStore } from "../src/core/types";
import type { TuiosRuntime } from "../src/runtime/tuios";
import { isProtectedTabLabel } from "../src/tools/shared";
import { registerTuiosTools } from "../src/tools/tuios-tools";

const SCOPE = "tuios:session-1";

interface MockWindow {
  id: string;
  label: string;
  status: string;
  workspace: number;
  cwd: string;
  rect: { x: number; y: number; width: number; height: number };
  agent: string;
}

type CallRecord = { verb: string; params: Record<string, unknown> };

interface MockOptions {
  ownPane?: string;
  ownWorkspace?: number;
  windows?: Array<{ id: string; label: string; status: string; workspace: number; cwd?: string }>;
  workspaceNames?: Record<number, string>;
  /** Return undefined to fall through to the default handler; throw to fail. */
  onCall?: (verb: string, params: Record<string, unknown>) => Record<string, unknown> | undefined;
}

function agentStateFor(status: string): string {
  if (status === "working") return "working";
  if (status === "blocked") return "needs_input";
  if (status === "idle") return "idle";
  if (status === "done") return "done";
  return "none";
}

function makeMockRuntime(options: MockOptions = {}) {
  const ownPane = options.ownPane ?? "pane-own";
  const ownWorkspace = options.ownWorkspace ?? 1;
  const calls: CallRecord[] = [];
  const names = new Map<number, string>(
    Object.entries(options.workspaceNames ?? {}).map(([number, name]) => [Number(number), name]),
  );
  let windows: MockWindow[] = (options.windows ?? []).map(window => ({
    id: window.id,
    label: window.label,
    status: window.status,
    workspace: window.workspace,
    cwd: window.cwd ?? "/work",
    rect: { x: 0, y: 0, width: 80, height: 24 },
    agent: agentStateFor(window.status),
  }));

  const runtime = {
    client: {},
    session: "session-1",
    ownPane,
    get workspaceId() {
      return SCOPE;
    },
    get tabId() {
      return `${SCOPE}:t${ownWorkspace}`;
    },
    tabFor(number: number) {
      return `${SCOPE}:t${number}`;
    },
    tabNumber(tabId: string) {
      const prefix = `${SCOPE}:t`;
      const number = tabId.startsWith(prefix) ? tabId.slice(prefix.length) : "";
      if (!/^[1-9]$/.test(number)) {
        throw new Error(
          `Tab ${tabId} is outside the current TUIOS session. Use picode_panes() for exact IDs.`,
        );
      }
      return Number(number);
    },
    async refresh() {
      return runtime;
    },
    get panes() {
      return windows;
    },
    get tabs() {
      return Array.from({ length: 9 }, (_, index) => {
        const number = index + 1;
        return {
          number,
          name: names.get(number) ?? "",
          windowCount: windows.filter(window => window.workspace === number).length,
        };
      });
    },
    pane(id: string) {
      const window = windows.find(candidate => candidate.id === id);
      if (!window) throw new Error(`Pane ${id} is not in this TUIOS session. Run picode_panes().`);
      return window;
    },
    rememberWindowCwd(id: string, cwd: string) {
      const window = windows.find(candidate => candidate.id === id);
      if (window) window.cwd = cwd;
    },
    async split(id: string, direction: "right" | "down") {
      runtime.pane(id);
      calls.push({ verb: "split-window", params: { window: id, direction } });
      const created: MockWindow = {
        id: `win-split-${windows.length + 1}`,
        label: "",
        status: "unknown",
        workspace: windows.find(w => w.id === id)?.workspace ?? ownWorkspace,
        cwd: "",
        rect: { x: 0, y: 0, width: 40, height: 24 },
        agent: "none",
      };
      windows.push(created);
      return created.id;
    },
    async sendText(id: string, text: string) {
      runtime.pane(id);
      calls.push({ verb: "send-text", params: { window: id, text } });
    },
    tab(id: string) {
      const number = runtime.tabNumber(id);
      const tab = runtime.tabs.find(candidate => candidate.number === number);
      if (!tab) throw new Error(`TUIOS workspace ${number} not found`);
      return tab;
    },
    assertWritableTab(id: string) {
      const tab = runtime.tab(id);
      if (isProtectedTabLabel(tab.name)) throw new Error(`Tab ${id} is user-owned (don't close).`);
      return tab;
    },
    async call(verb: string, params: Record<string, unknown> = {}) {
      calls.push({ verb, params: { ...params } });
      const override = options.onCall?.(verb, params);
      if (override !== undefined) return override;

      if (verb === "new-window") {
        const created: MockWindow = {
          id: `win-new-${windows.length + 1}`,
          label: "",
          status: "unknown",
          workspace: Number(params.workspace) || ownWorkspace,
          cwd: String(params.cwd ?? "/work"),
          rect: { x: 0, y: 0, width: 80, height: 24 },
          agent: "none",
        };
        windows.push(created);
        return { type: "window_created", window_id: created.id };
      }
      if (verb === "close-window") {
        windows = windows.filter(window => window.id !== params.window);
        return { type: "ok" };
      }
      if (verb === "set-workspace-name") {
        names.set(Number(params.workspace), String(params.name ?? ""));
        return { type: "ok" };
      }
      if (verb === "wait-for") return { type: "wait_result", matched: true };
      if (verb === "capture-pane") return { type: "pane_content", content: "worker output line" };
      return { type: "ok" };
    },
    async rename(id: string, name: string) {
      runtime.pane(id);
      calls.push({ verb: "set-window", params: { window: id, name } });
    },
    async close(id: string) {
      runtime.pane(id);
      // `close` is the runtime's own validated close, not a raw verb call, so
      // the scripted hook has to be consulted here too.
      options.onCall?.("close-window", { window: id });
      calls.push({ verb: "close-window", params: { window: id } });
      windows = windows.filter(window => window.id !== id);
    },
  };

  return {
    runtime: runtime as unknown as TuiosRuntime,
    calls,
    windowIds: () => windows.map(w => w.id),
  };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}
type AnyTool = {
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: undefined,
    onUpdate?: undefined,
    ctx?: undefined,
  ) => Promise<ToolResult>;
};

function setup(options: MockOptions = {}, role = "coordinator") {
  const { runtime, calls } = makeMockRuntime(options);
  const tools: Record<string, AnyTool> = {};
  const tracked: string[] = [];
  const pi = {
    registerTool: (tool: AnyTool & { name: string }) => {
      tools[tool.name] = tool;
    },
  } as unknown as ExtensionAPI;

  registerTuiosTools(pi, { role } as unknown as PicodeStore, runtime, {
    trackPane: id => tracked.push(id),
  });

  const run = (name: string, params: unknown = {}) =>
    tools[name].execute("test", params, undefined, undefined, undefined);

  return { run, calls, tracked, tools };
}

function closeCalls(calls: CallRecord[]): CallRecord[] {
  return calls.filter(call => call.verb === "close-window");
}

function picodeIdFrom(argv: unknown): string {
  assert.ok(Array.isArray(argv), "new-window command must be an argv array");
  const index = argv.indexOf("--picode-id");
  assert.ok(index >= 0, "argv must carry --picode-id");
  return String(argv[index + 1]);
}

// --- spawn_worker ------------------------------------------------------

describe("registerTuiosTools: spawn_worker", () => {
  it("refuses a non-coordinator without touching the runtime", async () => {
    const { run, calls } = setup({}, "worker");
    const result = await run("spawn_worker", { role: "builder", model: "m", theme: "t" });
    assert.equal(result.details.ok, false);
    assert.equal(calls.length, 0);
  });

  it("launches pi as argv (no shell) and waits for idle", async () => {
    const { run, calls, tracked } = setup({
      workspaceNames: { 3: "workers" },
    });
    const result = await run("spawn_worker", {
      role: "builder",
      model: "test/model",
      theme: "test-theme",
      tab: `${SCOPE}:t3`,
    });

    assert.equal(result.details.ok, true);
    assert.equal(result.details.reused, false);
    assert.equal(result.details.tab_id, `${SCOPE}:t3`);

    const created = calls.find(call => call.verb === "new-window");
    assert.ok(created);
    assert.equal(created.params.workspace, 3);
    assert.equal(created.params.focus, false);
    assert.equal(created.params.cwd, process.cwd());
    const argv = created.params.command as unknown[];
    assert.deepEqual(argv.slice(0, 3), ["env", "PICODE_RUNTIME=tuios", "pi"]);
    assert.ok(argv.includes("--model") && argv.includes("test/model"));
    assert.ok(argv.includes("--theme") && argv.includes("test-theme"));
    assert.ok(argv.includes("--thinking") && argv.includes("high"));
    assert.match(picodeIdFrom(argv), /^builder(-\d+)?$/);

    const wait = calls.find(call => call.verb === "wait-for");
    assert.ok(wait);
    assert.equal(wait.params.condition, "agent-state");
    assert.equal(wait.params.window, result.details.pane_id);
    assert.equal(wait.params.until, "idle");
    assert.equal(wait.params.timeout, 30_000);

    assert.deepEqual(tracked, [result.details.pane_id]);
  });

  it("rejects a role that could be injected into argv", async () => {
    const { run, calls } = setup();
    const result = await run("spawn_worker", {
      role: "builder; rm -rf /",
      model: "m",
      theme: "t",
    });
    assert.equal(result.details.ok, false);
    assert.equal(calls.length, 0);
  });

  it("reuses an idle same-role window inside the target workspace", async () => {
    const { run, calls } = setup({
      windows: [{ id: "pane-b1", label: "builder", status: "idle", workspace: 3 }],
    });
    const result = await run("spawn_worker", {
      role: "builder",
      model: "m",
      theme: "t",
      cwd: "/work",
      tab: `${SCOPE}:t3`,
    });
    assert.equal(result.details.reused, true);
    assert.equal(result.details.pane_id, "pane-b1");
    assert.equal(
      calls.some(call => call.verb === "new-window"),
      false,
    );
  });

  it("does not reuse a same-role window with a different requested cwd", async () => {
    const { run, calls } = setup({
      windows: [{ id: "pane-b1", label: "builder", status: "idle", workspace: 3, cwd: "/other" }],
    });
    const result = await run("spawn_worker", {
      role: "builder",
      cwd: "/requested",
      tab: `${SCOPE}:t3`,
    });
    assert.equal(result.details.reused, false);
    // Different cwd → not reused; workspace has a worker pane to split, so the
    // new worker is a BSP split of it and Pi is typed into the new shell.
    const split = calls.find(call => call.verb === "split-window");
    assert.ok(split, "expected a split into the existing worker pane");
    const sent = calls.find(call => call.verb === "send-text");
    assert.ok(sent?.params.text?.toString().includes("/requested"), "cd to requested cwd");
  });

  it("does not reuse a same-role window from a different workspace", async () => {
    const { run, calls } = setup({
      windows: [{ id: "pane-b4", label: "builder", status: "idle", workspace: 4 }],
    });
    const result = await run("spawn_worker", {
      role: "builder",
      model: "m",
      theme: "t",
      tab: `${SCOPE}:t3`,
    });
    assert.equal(result.details.reused, false);
    assert.notEqual(result.details.pane_id, "pane-b4");
    assert.equal(calls.filter(call => call.verb === "new-window").length, 1);
  });

  it("refuses a tab outside the current session", async () => {
    const { run, calls } = setup();
    const result = await run("spawn_worker", {
      role: "builder",
      model: "m",
      theme: "t",
      tab: "other:t3",
    });
    assert.equal(result.details.ok, false);
    assert.equal(calls.filter(call => call.verb === "new-window").length, 0);
  });

  it("refuses a user-owned workspace", async () => {
    const { run, calls } = setup({ workspaceNames: { 3: "don't close - frontend" } });
    const result = await run("spawn_worker", {
      role: "builder",
      model: "m",
      theme: "t",
      tab: `${SCOPE}:t3`,
    });
    assert.equal(result.details.ok, false);
    assert.equal(calls.filter(call => call.verb === "new-window").length, 0);
  });

  it("warns instead of failing when the worker never reports ready", async () => {
    const { run } = setup({
      onCall: verb => {
        if (verb === "wait-for") throw new Error("TUIOS wait-for: timeout");
        return undefined;
      },
    });
    const result = await run("spawn_worker", {
      role: "builder",
      model: "m",
      theme: "t",
      tab: `${SCOPE}:t2`,
    });
    assert.equal(result.details.ok, true);
    assert.match(String(result.details.warning), /idle\/done within 30s/);
  });

  it("splits a worker pane in the coordinator's workspace (grid), not a floating window", async () => {
    const { run, calls } = setup({
      windows: [
        { id: "pane-own", label: "coordinator", status: "working", workspace: 1 },
        { id: "pane-w1", label: "builder", status: "idle", workspace: 1 },
      ],
    });
    // Mock windows have default rect 80x24 — w1 is a valid split target.
    const result = await run("spawn_worker", { role: "tester", model: "m", theme: "t" });
    assert.equal(result.details.ok, true);
    const split = calls.find(c => c.verb === "split-window");
    assert.ok(split, "worker pane should be split to grow the grid");
    assert.equal(split.params.window, "pane-w1");
    assert.equal(calls.filter(c => c.verb === "new-window").length, 0);
    const sent = calls.find(c => c.verb === "send-text");
    assert.ok(sent?.params.text?.toString().includes("--picode-id"));
    assert.ok(sent?.params.text?.toString().includes("exec env PICODE_RUNTIME=tuios pi"));
  });

  it("falls back to new-window on an empty workspace (nothing to split)", async () => {
    const { run, calls } = setup({ workspaceNames: { 3: "workers" } });
    const result = await run("spawn_worker", {
      role: "builder",
      model: "m",
      theme: "t",
      tab: `${SCOPE}:t3`,
    });
    assert.equal(result.details.ok, true);
    assert.equal(calls.filter(c => c.verb === "split-window").length, 0);
    assert.equal(calls.filter(c => c.verb === "new-window").length, 1);
  });

  it("overflows to new-window once the workspace grid holds 4 panes", async () => {
    const { run, calls } = setup({
      windows: [
        { id: "pane-own", label: "coordinator", status: "working", workspace: 1 },
        { id: "w1", label: "builder", status: "working", workspace: 1 },
        { id: "w2", label: "builder-1", status: "working", workspace: 1 },
        { id: "w3", label: "builder-2", status: "working", workspace: 1 },
      ],
    });
    const result = await run("spawn_worker", { role: "tester", model: "m", theme: "t" });
    assert.equal(result.details.ok, true);
    // Grid is at 4 panes → getSplitTarget returns null → floating new-window.
    assert.equal(calls.filter(c => c.verb === "split-window").length, 0);
    assert.equal(calls.filter(c => c.verb === "new-window").length, 1);
  });
});

// --- picode_panes ------------------------------------------------------

describe("registerTuiosTools: picode_panes", () => {
  it("refuses a workspace filter outside the session", async () => {
    const { run } = setup();
    const result = await run("picode_panes", { workspace: "tuios:other" });
    assert.equal(result.details.ok, false);
  });

  it("groups windows by workspace and marks protected and own panes", async () => {
    const { run } = setup({
      ownPane: "pane-own",
      windows: [
        { id: "pane-own", label: "coordinator", status: "working", workspace: 1 },
        { id: "pane-b3", label: "builder", status: "idle", workspace: 3 },
        { id: "pane-u4", label: "builder", status: "unknown", workspace: 4 },
      ],
      workspaceNames: { 4: "don't close - docs" },
    });
    const result = await run("picode_panes", {});
    assert.equal(result.details.total, 3);
    const summaries = result.details.panes as Array<Record<string, unknown>>;
    const own = summaries.find(summary => summary.pane_id === "pane-own");
    const idle = summaries.find(summary => summary.pane_id === "pane-b3");
    const userOwned = summaries.find(summary => summary.pane_id === "pane-u4");
    assert.match(String(own?.suggestion), /SELF/);
    assert.match(String(idle?.suggestion), /REUSE/);
    assert.match(String(userOwned?.suggestion), /OFF-LIMITS/);
    assert.equal(idle?.tab_id, `${SCOPE}:t3`);
  });
});

// --- picode_pane_read --------------------------------------------------

describe("registerTuiosTools: picode_pane_read", () => {
  it("refuses the coordinator's own window", async () => {
    const { run, calls } = setup({
      ownPane: "pane-own",
      windows: [{ id: "pane-own", label: "coordinator", status: "working", workspace: 1 }],
    });
    const result = await run("picode_pane_read", { pane_id: "pane-own" });
    assert.equal(result.details.ok, false);
    assert.equal(calls.length, 0);
  });

  it("refuses an id that is not an exact window in this session", async () => {
    const { run, calls } = setup();
    const result = await run("picode_pane_read", { pane_id: "worker-name" });
    assert.equal(result.details.ok, false);
    assert.equal(calls.filter(call => call.verb === "capture-pane").length, 0);
  });

  it("maps recent-unwrapped onto recent and says so", async () => {
    const { run, calls } = setup({
      windows: [{ id: "pane-b3", label: "builder", status: "idle", workspace: 3 }],
    });
    const result = await run("picode_pane_read", {
      pane_id: "pane-b3",
      source: "recent-unwrapped",
      lines: 40,
    });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.source, "recent");
    assert.match(String(result.details.warning), /recent-unwrapped/);
    const captured = calls.find(call => call.verb === "capture-pane");
    assert.equal(captured?.params.source, "recent");
    assert.equal(captured?.params.lines, 40);
    assert.equal(captured?.params.styled, false);
    assert.match(result.content[0].text, /worker output line/);
  });

  it("requests styled output for the ansi format", async () => {
    const { run, calls } = setup({
      windows: [{ id: "pane-b3", label: "builder", status: "blocked", workspace: 3 }],
    });
    const result = await run("picode_pane_read", { pane_id: "pane-b3", format: "ansi" });
    assert.equal(result.details.ok, true);
    const captured = calls.find(call => call.verb === "capture-pane");
    assert.equal(captured?.params.styled, true);
  });
});

// --- cleanup_panes -----------------------------------------------------

describe("registerTuiosTools: cleanup_panes", () => {
  it("refuses a non-coordinator", async () => {
    const { run, calls } = setup({}, "builder");
    const result = await run("cleanup_panes", {});
    assert.equal(result.details.ok, false);
    assert.equal(calls.length, 0);
  });

  it("refuses the coordinator's own window by exact id", async () => {
    const { run, calls } = setup({
      ownPane: "pane-own",
      windows: [{ id: "pane-own", label: "idle-worker", status: "idle", workspace: 1 }],
    });
    const result = await run("cleanup_panes", { pane_id: "pane-own", force: true });
    assert.equal(result.details.ok, false);
    assert.equal(closeCalls(calls).length, 0);
  });

  it("protects a working window even when targeted", async () => {
    const { run, calls } = setup({
      windows: [{ id: "pane-w", label: "builder", status: "working", workspace: 3 }],
    });
    const result = await run("cleanup_panes", { pane_id: "pane-w" });
    assert.equal(result.details.ok, false);
    assert.equal(closeCalls(calls).length, 0);
  });

  it("closes a done worker by exact id without force", async () => {
    const { run } = setup({
      windows: [{ id: "pane-w", label: "builder", status: "done", workspace: 3 }],
    });
    const result = await run("cleanup_panes", { pane_id: "pane-w" });
    assert.equal(result.details.ok, true);
    assert.deepEqual(result.details.closed, ["pane-w"]);
    assert.equal(result.details.action, "closed");
  });

  it("protects unknown agent state even with force", async () => {
    const { run, calls } = setup({
      windows: [{ id: "pane-w", label: "builder", status: "unknown", workspace: 3 }],
    });
    const result = await run("cleanup_panes", { pane_id: "pane-w", force: true });
    assert.equal(result.details.ok, false);
    assert.equal(closeCalls(calls).length, 0);
  });

  it("requires force to close an idle worker by exact id", async () => {
    const { run, calls } = setup({
      windows: [{ id: "pane-w", label: "builder", status: "idle", workspace: 3 }],
    });
    const refused = await run("cleanup_panes", { pane_id: "pane-w" });
    assert.equal(refused.details.ok, false);
    const forced = await run("cleanup_panes", { pane_id: "pane-w", force: true });
    assert.equal(forced.details.ok, true);
    assert.equal(closeCalls(calls).length, 1);
  });

  it("bulk-closes only stopped worker windows", async () => {
    const { run } = setup({
      ownPane: "pane-own",
      windows: [
        { id: "pane-own", label: "coordinator", status: "working", workspace: 1 },
        { id: "pane-dead", label: "builder", status: "done", workspace: 3 },
        { id: "pane-unknown", label: "builder", status: "unknown", workspace: 3 },
        { id: "pane-idle", label: "builder", status: "idle", workspace: 3 },
        { id: "pane-busy", label: "reviewer", status: "working", workspace: 3 },
        { id: "pane-shell", label: "", status: "unknown", workspace: 3 },
        { id: "pane-user", label: "builder", status: "unknown", workspace: 4 },
      ],
      workspaceNames: { 4: "don't close - notes" },
    });
    const result = await run("cleanup_panes", {});
    assert.deepEqual(result.details.closed, ["pane-dead"]);
    const skipped = result.details.skipped as string[];
    assert.ok(skipped.includes("pane-own"));
    assert.ok(skipped.includes("pane-idle"));
    assert.ok(skipped.includes("pane-busy"));
    assert.ok(skipped.includes("pane-unknown"));
    assert.ok(!skipped.includes("pane-user"));
    assert.ok(!skipped.includes("pane-shell"));
  });

  it("bulk-closes idle workers only with force", async () => {
    const { run, calls } = setup({
      windows: [{ id: "pane-idle", label: "builder", status: "idle", workspace: 3 }],
    });
    const withoutForce = await run("cleanup_panes", {});
    assert.deepEqual(withoutForce.details.closed, []);
    const withForce = await run("cleanup_panes", { force: true });
    assert.deepEqual(withForce.details.closed, ["pane-idle"]);
    assert.equal(closeCalls(calls).length, 1);
  });

  it("bulk dry_run lists candidates without closing them", async () => {
    const { run, calls } = setup({
      windows: [{ id: "pane-dead", label: "builder", status: "done", workspace: 3 }],
    });
    const result = await run("cleanup_panes", { dry_run: true });
    assert.equal(result.details.action, "would close");
    assert.deepEqual(result.details.closed, ["pane-dead"]);
    assert.equal(closeCalls(calls).length, 0);
  });
});

// --- picode_tab_create -------------------------------------------------

describe("registerTuiosTools: picode_tab_create", () => {
  it("refuses a non-coordinator", async () => {
    const { run, calls } = setup({}, "builder");
    const result = await run("picode_tab_create", { label: "workers-2" });
    assert.equal(result.details.ok, false);
    assert.equal(calls.length, 0);
  });

  it("claims an empty workspace by name without creating an unknown root shell", async () => {
    const { run, calls } = setup({
      ownPane: "pane-own",
      ownWorkspace: 1,
      windows: [{ id: "pane-own", label: "coordinator", status: "working", workspace: 1 }],
    });
    const result = await run("picode_tab_create", { label: "workers-2" });

    assert.equal(result.details.ok, true);
    assert.equal(result.details.tab_id, `${SCOPE}:t2`);
    assert.equal(result.details.root_pane_id, null);
    assert.equal(result.details.root_window_created, false);
    assert.equal(result.details.label, "workers-2");
    assert.equal(calls.filter(call => call.verb === "new-window").length, 0);

    const named = calls.find(call => call.verb === "set-workspace-name");
    assert.deepEqual(named?.params, { workspace: 2, name: "workers-2" });
  });

  it("leaves no window behind when claiming the workspace fails", async () => {
    const { run, calls } = setup({
      ownPane: "pane-own",
      ownWorkspace: 1,
      onCall: verb => {
        if (verb === "set-workspace-name") throw new Error("TUIOS set-workspace-name: forbidden");
        return undefined;
      },
    });
    const result = await run("picode_tab_create", { label: "workers-2" });
    assert.equal(result.details.ok, false);
    assert.equal(closeCalls(calls).length, 0);
    assert.equal(calls.filter(call => call.verb === "new-window").length, 0);
  });

  it("reports when no workspace slot is free", async () => {
    const windows = Array.from({ length: 9 }, (_, index) => ({
      id: `pane-${index + 1}`,
      label: "builder",
      status: "unknown",
      workspace: index + 1,
    }));
    const { run, calls } = setup({ windows });
    const result = await run("picode_tab_create", {});
    assert.equal(result.details.ok, false);
    assert.match(result.content[0].text, /No unused TUIOS workspace/);
    assert.equal(calls.filter(call => call.verb === "new-window").length, 0);
  });
});

// --- picode_tab_close --------------------------------------------------

describe("registerTuiosTools: picode_tab_close", () => {
  it("refuses the coordinator's own workspace", async () => {
    const { run, calls } = setup({ ownWorkspace: 1 });
    const result = await run("picode_tab_close", { tab_id: `${SCOPE}:t1` });
    assert.equal(result.details.ok, false);
    assert.equal(closeCalls(calls).length, 0);
  });

  it("refuses a user-owned workspace", async () => {
    const { run, calls } = setup({ workspaceNames: { 3: "don't close - docs" } });
    const result = await run("picode_tab_close", { tab_id: `${SCOPE}:t3` });
    assert.equal(result.details.ok, false);
    assert.equal(closeCalls(calls).length, 0);
  });

  it("refuses a workspace holding a working window", async () => {
    const { run, calls } = setup({
      windows: [{ id: "pane-w", label: "builder", status: "working", workspace: 3 }],
    });
    const result = await run("picode_tab_close", { tab_id: `${SCOPE}:t3`, force: true });
    assert.equal(result.details.ok, false);
    assert.equal(closeCalls(calls).length, 0);
  });

  it("protects a workspace with unknown agent state even with force", async () => {
    const { run, calls } = setup({
      windows: [{ id: "pane-w", label: "builder", status: "unknown", workspace: 3 }],
    });
    const result = await run("picode_tab_close", { tab_id: `${SCOPE}:t3`, force: true });
    assert.equal(result.details.ok, false);
    assert.equal(closeCalls(calls).length, 0);
  });

  it("requires force to close a workspace holding idle windows", async () => {
    const { run, calls } = setup({
      windows: [{ id: "pane-w", label: "builder", status: "idle", workspace: 3 }],
    });
    const refused = await run("picode_tab_close", { tab_id: `${SCOPE}:t3` });
    assert.equal(refused.details.ok, false);
    assert.equal(closeCalls(calls).length, 0);
  });

  it("empties the workspace and clears its name with force", async () => {
    const { run, calls } = setup({
      workspaceNames: { 3: "workers" },
      windows: [{ id: "pane-w", label: "builder", status: "idle", workspace: 3 }],
    });
    const result = await run("picode_tab_close", { tab_id: `${SCOPE}:t3`, force: true });
    assert.deepEqual(result.details, { ok: true, tab_id: `${SCOPE}:t3`, closed: true });

    const closed = closeCalls(calls);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].params.window, "pane-w");
    const cleared = calls.find(call => call.verb === "set-workspace-name");
    assert.deepEqual(cleared?.params, { workspace: 3, name: "" });
  });

  it("does not claim success if it cannot release an emptied workspace slot", async () => {
    const { run, calls } = setup({
      workspaceNames: { 3: "workers" },
      onCall: verb => {
        if (verb === "set-workspace-name") throw new Error("TUIOS name update failed");
        return undefined;
      },
    });
    const result = await run("picode_tab_close", { tab_id: `${SCOPE}:t3` });
    assert.equal(result.details.ok, false);
    assert.match(result.content[0].text, /slot is not reusable/);
    assert.equal(closeCalls(calls).length, 0);
  });

  it("does not claim success when a window will not close", async () => {
    const { run } = setup({
      workspaceNames: { 3: "workers" },
      windows: [{ id: "pane-w", label: "builder", status: "idle", workspace: 3 }],
      onCall: verb => {
        if (verb === "close-window") throw new Error("TUIOS close-window: busy");
        return undefined;
      },
    });
    const result = await run("picode_tab_close", { tab_id: `${SCOPE}:t3`, force: true });
    assert.equal(result.details.ok, false);
    assert.match(result.content[0].text, /not fully cleared/);
  });
});
