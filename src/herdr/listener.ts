import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connect, Socket } from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Event types we subscribe to from Herdr.
 *  Note: pane.agent_status_changed requires a specific pane_id per subscription,
 *  so global worker-death detection uses pane.closed/pane.exited for now.
 *  Per-pane status tracking is a future enhancement. */
const WATCHED_EVENTS = ["pane.closed", "pane.exited"] as const;

interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Resolve the path to the Herdr API socket.
 *  Falls back to a Herdr default if HERDR_CONFIG_PATH is set. */
function herdrSocketPath(): string | null {
  const configPath = process.env.HERDR_CONFIG_PATH;
  if (configPath) {
    const candidate = join(configPath, "herdr.sock");
    if (existsSync(candidate)) return candidate;
  }
  const home = homedir();
  const candidate = join(home, ".config", "herdr", "herdr.sock");
  return existsSync(candidate) ? candidate : null;
}

/** Format a Herdr event as a message for the coordinator.
 *  Returns null if the event is not in our workspace or not a watched type. */
function formatEvent(event: HerdrEvent, workspaceId: string): string | null {
  if ((event.data.workspace_id as string | undefined) !== workspaceId) return null;

  const paneId = (event.data.pane_id as string) || "unknown";
  const agent = (event.data.agent as string) || "";
  const label = (event.data.label as string) || "";

  switch (event.event) {
    case "pane_closed":
      return `[picode-system] Pane ${paneId} (${label || agent || "worker"}) was closed.`;
    case "pane_exited":
      return `[picode-system] Pane ${paneId} (${label || agent || "worker"}) process exited.`;
    default:
      return null;
  }
}

/** Steer (interrupt) on closed/exited panes — the worker is gone, so
 *  waiting for the next turn boundary wastes time. */
function deliverAsUrgent(eventName: string): boolean {
  return eventName === "pane_closed" || eventName === "pane_exited";
}

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
/** Ignore events for this many ms after startup — avoids flooding the
 *  coordinator with stale pane-close events from auto-purge/cleanup. */
const STARTUP_GRACE_MS = 5_000;

/** Start a persistent Herdr event subscription.
 *  Returns a stop function for shutdown cleanup.
 *
 *  Resilience features:
 *  - All state in closure (no module globals — safe with multiple instances)
 *  - Exponential backoff with cap, resets on successful subscribe
 *  - Max reconnect attempts before giving up (stops spinning if socket gone)
 *  - Heartbeat: if no data received within HEARTBEAT_INTERVAL_MS, force reconnect
 *  - Socket destroyed on error before close handler
 *  - Debug logging via HERDR_LISTENER_DEBUG env var (off by default) */
export function startHerdrListener(pi: ExtensionAPI, workspaceId: string): () => void {
  const debug = process.env.HERDR_LISTENER_DEBUG === "1";
  const log = (msg: string) => {
    if (debug) console.log(`[picode] herdr-listener: ${msg}`);
  };

  if (process.env.HERDR_ENV !== "1") {
    log("HERDR_ENV not set, skipping");
    return () => {};
  }

  const socketPath = herdrSocketPath();
  if (!socketPath) {
    log("socket not found, skipping");
    return () => {};
  }
  log(`socket at ${socketPath}`);

  let stopped = false;
  let socket: Socket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let reconnectAttempts = 0;
  let requestId = 0;
  let subscribed = false;
  const startTime = Date.now();

  /** True during the startup grace period — stale pane closes from
   *  auto-purge arrive here and should not flood the coordinator. */
  function inStartupGrace(): boolean {
    return Date.now() - startTime < STARTUP_GRACE_MS;
  }

  function clearTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function destroySocket() {
    clearTimers();
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
      socket = null;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log(`max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
      return;
    }

    reconnectAttempts++;
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (reconnectAttempts - 1), MAX_BACKOFF_MS);
    log(`reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSocket();
    }, delay);
  }

  function resetHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      log("heartbeat timeout — no data received, forcing reconnect");
      destroySocket();
      scheduleReconnect();
    }, HEARTBEAT_INTERVAL_MS);
  }

  function connectSocket() {
    if (stopped || socket) return;

    log("connecting...");
    const s = connect(socketPath!);
    socket = s;
    let buffer = "";

    s.on("connect", () => {
      log("connected, subscribing");
      requestId++;
      subscribed = false;
      const req = {
        jsonrpc: "2.0",
        method: "events.subscribe",
        params: {
          subscriptions: WATCHED_EVENTS.map(type => ({ type })),
        },
        id: `picode-${requestId}`,
      };
      s.write(JSON.stringify(req) + "\n");
      resetHeartbeat();
    });

    s.on("data", (chunk: Buffer) => {
      resetHeartbeat();
      buffer += chunk.toString("utf-8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line) as HerdrEvent | { result?: unknown; id?: string };
          if ("event" in msg) {
            log(`event=${msg.event} data=${JSON.stringify(msg.data)}`);
            if (inStartupGrace()) {
              log(`ignored (startup grace)`);
              continue;
            }
            const text = formatEvent(msg, workspaceId);
            if (text) {
              const steer = deliverAsUrgent(msg.event);
              log(`injecting deliverAs=${steer ? "steer" : "followUp"}`);
              pi.sendUserMessage(text, { deliverAs: steer ? "steer" : "followUp" });
            }
          } else if ("result" in msg) {
            // Subscribe succeeded — reset backoff
            subscribed = true;
            reconnectAttempts = 0;
            log("subscription confirmed");
          } else if ("error" in msg) {
            log(`subscribe error: ${JSON.stringify(msg)}`);
          }
        } catch {
          log(`parse error: ${line.slice(0, 100)}`);
        }
      }
    });

    s.on("error", (err: Error) => {
      log(`socket error: ${err.message}`);
      // Destroy here — close event may not fire after error
      destroySocket();
    });

    s.on("close", () => {
      if (socket === s) socket = null;
      clearTimers();
      if (!stopped) scheduleReconnect();
    });
  }

  connectSocket();

  return () => {
    stopped = true;
    destroySocket();
  };
}
