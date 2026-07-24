import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connect, Socket } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Event types we subscribe to from Herdr. */
const WATCHED_EVENTS = [
  "pane.closed",
  "pane.exited",
  "pane.agent_status_changed",
  "pane.agent_detected",
] as const;

type WatchedEvent = (typeof WATCHED_EVENTS)[number];

interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

interface EventHandler {
  pi: ExtensionAPI;
  workspaceId: string;
}

let activeSocket: Socket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let requestId = 0;

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

/** Format a Herdr event as a message for the coordinator. */
function formatEvent(event: HerdrEvent, workspaceId: string): string | null {
  if ((event.data.workspace_id as string | undefined) !== workspaceId) return null;

  const paneId = (event.data.pane_id as string) || "unknown";
  const agent = (event.data.agent as string) || "";
  const label = (event.data.label as string) || "";
  const agentStatus = (event.data.agent_status as string) || "";

  switch (event.event) {
    case "pane.closed":
      return `[picode-system] Pane ${paneId} (${label || agent || "worker"}) was closed.`;
    case "pane.exited":
      return `[picode-system] Pane ${paneId} (${label || agent || "worker"}) process exited.`;
    case "pane.agent_status_changed": {
      const display = label || agent || `pane ${paneId}`;
      return `[picode-system] ${display} is now ${agentStatus}.`;
    }
    case "pane.agent_detected": {
      const display = label || agent || paneId;
      return `[picode-system] Agent detected in ${display}.`;
    }
    default:
      return null;
  }
}

/** Steer (interrupt) on closed/exited panes — the worker is gone, so
 *  waiting for the next turn boundary wastes time. Other events followUp. */
function deliverAsUrgent(eventName: string): boolean {
  return eventName === "pane.closed" || eventName === "pane.exited";
}

/** Start a persistent Herdr event subscription.
 *  Returns a stop function for shutdown cleanup. */
export function startHerdrListener(pi: ExtensionAPI, workspaceId: string): () => void {
  if (process.env.HERDR_ENV !== "1") {
    console.log("[picode] HERDR_ENV not set, skipping Herdr event listener");
    return () => {};
  }

  const socketPath = herdrSocketPath();
  if (!socketPath) {
    console.log("[picode] Herdr socket not found, skipping event listener");
    return () => {};
  }

  let stopped = false;

  function connectSocket() {
    if (stopped || activeSocket) return;

    const socket = connect(socketPath!);
    activeSocket = socket;

    let buffer = "";

    socket.on("connect", () => {
      requestId++;
      const req = {
        jsonrpc: "2.0",
        method: "events.subscribe",
        params: {
          subscriptions: WATCHED_EVENTS.map(type => ({ type })),
        },
        id: `picode-${requestId}`,
      };
      socket.write(JSON.stringify(req) + "\n");
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line) as HerdrEvent | { result?: unknown; id?: string };
          if ("event" in msg) {
            const text = formatEvent(msg, workspaceId);
            if (text) {
              const steer = deliverAsUrgent(msg.event);
              pi.sendUserMessage(text, { deliverAs: steer ? "steer" : "followUp" });
            }
          }
        } catch {
          // Ignore malformed lines
        }
      }
    });

    socket.on("error", (err: Error) => {
      console.log(`[picode] Herdr event socket error: ${err.message}`);
      activeSocket = null;
    });

    socket.on("close", () => {
      if (activeSocket === socket) activeSocket = null;
      if (!stopped && !reconnectTimer) {
        // Exponential backoff: 1s, 2s, 4s, max 30s
        const delay = Math.min(1000 * 2 ** Math.min(requestId, 5), 30_000);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectSocket();
        }, delay);
      }
    });
  }

  connectSocket();

  return () => {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (activeSocket) {
      activeSocket.destroy();
      activeSocket = null;
    }
  };
}
