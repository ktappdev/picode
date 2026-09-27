import { TuiosClient, record, type JsonRecord } from "./tuios-client";
import { effectiveAgentStatus, extractRole, isProtectedTabLabel } from "../tools/shared";

export interface TuiosWindow {
  id: string;
  label: string;
  status: string;
  workspace: number;
  cwd: string;
  rect: { x: number; y: number; width: number; height: number };
  agent: string;
}
export interface TuiosWorkspace {
  number: number;
  name: string;
  windowCount: number;
}

/** Session name is the routing key; session ID is the scope identity. Never
 * address a window by a caller-provided name or the daemon's focused index. */
export class TuiosRuntime {
  readonly client: TuiosClient;
  readonly session: string;
  readonly ownPane: string;
  private scopeId = "";
  private currentWorkspace = 0;
  private windows: TuiosWindow[] = [];
  private workspaces: TuiosWorkspace[] = [];
  private checked = false;
  private supportsListAgents = false;
  private knownWindowCwds = new Map<string, string>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    if (!env.TUIOS_SESSION || !env.TUIOS_PANE_ID || !env.TUIOS_SOCKET) {
      throw new Error("TUIOS_SOCKET, TUIOS_SESSION and TUIOS_PANE_ID are required");
    }
    this.client = new TuiosClient(env.TUIOS_SOCKET);
    this.session = env.TUIOS_SESSION;
    this.ownPane = env.TUIOS_PANE_ID;
  }

  get workspaceId() {
    return this.scopeId;
  }
  get tabId() {
    return this.tabFor(this.currentWorkspace);
  }
  tabFor(number: number) {
    return `${this.scopeId}:t${number}`;
  }
  tabNumber(tabId: string): number {
    const prefix = `${this.scopeId}:t`;
    const number = tabId.startsWith(prefix) ? tabId.slice(prefix.length) : "";
    if (!/^[1-9]$/.test(number)) {
      throw new Error(
        `Tab ${tabId} is outside the current TUIOS session. Use picode_panes() for exact IDs.`,
      );
    }
    return Number(number);
  }

  async refresh(): Promise<this> {
    if (!this.checked) {
      const hello = await this.client.request("hello", {
        client: "picode",
        version: "0.6.0",
        protocol: 1,
      });
      if (hello.type !== "hello" || hello.protocol !== 1)
        throw new Error("Unsupported TUIOS protocol version");
      const verbs = await this.client.request("list-verbs");
      if (!Array.isArray(verbs.verbs)) throw new Error("TUIOS verb catalog missing");
      const available = new Set(verbs.verbs.map(value => record(value).verb));
      this.supportsListAgents = available.has("list-agents");
      for (const required of [
        "session-info",
        "list-windows",
        "list-workspaces",
        "new-window",
        "split-window",
        "send-text",
        "close-window",
        "set-window",
        "set-workspace-name",
        "capture-pane",
        "send-keys",
        "wait-for",
        "subscribe",
      ]) {
        if (!available.has(required))
          throw new Error(`TUIOS daemon lacks required verb ${required}; update TUIOS.`);
      }
      this.checked = true;
    }
    const [info, list, tabs, agentSnapshot] = await Promise.all([
      this.client.request("session-info", { session: this.session }),
      this.client.request("list-windows", { session: this.session }),
      this.client.request("list-workspaces", { session: this.session }),
      this.supportsListAgents
        ? this.client
            .request("list-agents", { session: this.session, all: true })
            .catch(() => ({}) as JsonRecord)
        : Promise.resolve({} as JsonRecord),
    ]);
    if (info.session_name !== this.session || typeof info.session_id !== "string") {
      throw new Error("TUIOS session identity mismatch");
    }
    const rawWindows = list.windows;
    if (!Array.isArray(rawWindows) || !rawWindows.some(w => record(w).window_id === this.ownPane)) {
      throw new Error("Current TUIOS pane does not belong to the selected session");
    }
    if (!Array.isArray(tabs.workspaces)) throw new Error("TUIOS workspaces missing");
    const cwdByWindow = new Map<string, string>();
    if (Array.isArray(agentSnapshot.agents)) {
      for (const value of agentSnapshot.agents) {
        const agent = record(value);
        if (
          agent.session === this.session &&
          typeof agent.window_id === "string" &&
          typeof agent.cwd === "string" &&
          agent.cwd.length > 0
        ) {
          cwdByWindow.set(agent.window_id, agent.cwd);
        }
      }
    }
    const liveWindowIds = new Set(
      rawWindows
        .map(value => record(value).window_id)
        .filter((id): id is string => typeof id === "string"),
    );
    for (const id of this.knownWindowCwds.keys()) {
      if (!liveWindowIds.has(id)) this.knownWindowCwds.delete(id);
    }
    this.scopeId = `tuios:${info.session_id}`;
    this.currentWorkspace = Number(
      record(rawWindows.find(w => record(w).window_id === this.ownPane)).workspace,
    );
    if (
      !Number.isInteger(this.currentWorkspace) ||
      this.currentWorkspace < 1 ||
      this.currentWorkspace > 9
    ) {
      throw new Error("Current TUIOS workspace is invalid");
    }
    this.windows = rawWindows.map(value => {
      const w = record(value);
      if (typeof w.window_id !== "string" || !Number.isInteger(w.workspace)) {
        throw new Error("Invalid TUIOS window snapshot");
      }
      const label = typeof w.custom_name === "string" ? w.custom_name : "";
      const state = typeof w.agent_state === "string" ? w.agent_state : "none";
      const status =
        state === "needs_input"
          ? "blocked"
          : state === "errored" || state === "none"
            ? "unknown"
            : state;
      return {
        id: w.window_id,
        label,
        status: effectiveAgentStatus(status, extractRole(label)),
        workspace: w.workspace as number,
        cwd:
          typeof w.cwd === "string" && w.cwd.length > 0
            ? w.cwd
            : typeof w.window_id === "string"
              ? (cwdByWindow.get(w.window_id) ?? this.knownWindowCwds.get(w.window_id) ?? "")
              : "",
        rect: {
          x: Number(w.x) || 0,
          y: Number(w.y) || 0,
          width: Number(w.width) || 0,
          height: Number(w.height) || 0,
        },
        agent: state,
      };
    });
    this.workspaces = tabs.workspaces.map(value => {
      const w = record(value);
      if (
        typeof w.workspace !== "number" ||
        !Number.isInteger(w.workspace) ||
        w.workspace < 1 ||
        w.workspace > 9
      ) {
        throw new Error("Invalid TUIOS workspace snapshot");
      }
      return {
        number: w.workspace as number,
        name: String(w.name || ""),
        windowCount: Number(w.window_count) || 0,
      };
    });
    return this;
  }

  get panes(): readonly TuiosWindow[] {
    return this.windows;
  }
  get tabs(): readonly TuiosWorkspace[] {
    return this.workspaces;
  }
  pane(id: string): TuiosWindow {
    const pane = this.windows.find(window => window.id === id);
    if (!pane) throw new Error(`Pane ${id} is not in this TUIOS session. Run picode_panes().`);
    return pane;
  }
  tab(id: string): TuiosWorkspace {
    const number = this.tabNumber(id);
    const tab = this.workspaces.find(workspace => workspace.number === number);
    if (!tab) throw new Error(`TUIOS workspace ${number} not found`);
    return tab;
  }
  assertWritableTab(id: string): TuiosWorkspace {
    const tab = this.tab(id);
    if (isProtectedTabLabel(tab.name)) throw new Error(`Tab ${id} is user-owned (don't close).`);
    return tab;
  }
  async call(verb: string, params: JsonRecord = {}, timeoutMs?: number): Promise<JsonRecord> {
    // Scope is an invariant, not a default: an accidental `session` field in
    // params must never retarget a coordinator operation at another session.
    return this.client.request(verb, { ...params, session: this.session }, timeoutMs);
  }
  async rename(id: string, name: string): Promise<void> {
    this.pane(id);
    await this.call("set-window", { window: id, name });
  }
  rememberWindowCwd(id: string, cwd: string): void {
    this.knownWindowCwds.set(id, cwd);
  }

  /** Split a window's pane through the attached client (real BSP tiling).
   *  `direction` maps to TUIOS's split axis: "right" → vertical cut (new pane
   *  beside), "down" → horizontal cut (new pane below). Returns the new
   *  window id, or "" when the split ran but the id did not reach state. */
  async split(id: string, direction: "right" | "down"): Promise<string> {
    this.pane(id);
    // split-window focuses the target, routes Split to the attached client,
    // and the client asks the daemon for a new window which lands tiled.
    const result = await this.call("split-window", {
      window: id,
      direction: direction === "right" ? "vertical" : "horizontal",
    });
    return typeof result.window_id === "string" ? result.window_id : "";
  }

  async sendText(id: string, text: string): Promise<void> {
    this.pane(id);
    await this.call("send-text", { window: id, text });
  }

  async close(id: string): Promise<void> {
    this.pane(id);
    await this.call("close-window", { window: id });
    this.knownWindowCwds.delete(id);
  }
}
