import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Inbox } from "../inbox";
import type { HerdrListenerHandle } from "../herdr/listener";
import type { JsonRecord } from "./tuios-client";
import type { TuiosRuntime } from "./tuios";

const STARTUP_GRACE_MS = 5_000;
const RECONNECT_MS = 1_000;

let activeHandle: HerdrListenerHandle | null = null;
export function setTuiosListenerHandle(handle: HerdrListenerHandle | null): void {
  activeHandle = handle;
}
export function getTuiosListenerHandle(): HerdrListenerHandle | null {
  return activeHandle;
}
export function trackTuiosPane(id: string): void {
  activeHandle?.trackPane(id);
}
export function untrackTuiosPane(id: string): void {
  activeHandle?.untrackPane(id);
}
export function getTuiosTrackedPaneCount(): number {
  return activeHandle?.trackedPaneCount() ?? 0;
}

/** Subscribe only to the current session's death events. A dropped event ring
 * cannot be interpreted as "nothing happened": reconcile tracked IDs against
 * a fresh snapshot before processing more events. */
export function startTuiosListener(
  runtime: TuiosRuntime,
  inbox: Inbox,
  ctx: ExtensionContext,
): HerdrListenerHandle {
  const tracked = new Map<string, string>();
  const start = Date.now();
  let stopped = false;
  let stopSocket: (() => void) | null = null;
  let retry: NodeJS.Timeout | null = null;
  let lastSeq: number | undefined;
  let bootId: string | undefined;
  let failures = 0;
  let reconciling = false;

  const notice = (id: string, kind: string, label: string) => {
    if (!tracked.has(id)) return;
    tracked.delete(id);
    if (Date.now() - start < STARTUP_GRACE_MS) return;
    inbox.inject(
      [{ text: `[picode-system] Pane ${id} (${label || "worker"}) ${kind}.`, urgency: "high" }],
      ctx,
    );
  };
  const reconcile = async () => {
    if (reconciling || stopped) return;
    reconciling = true;
    try {
      await runtime.refresh();
      const current = new Set(runtime.panes.map(pane => pane.id));
      for (const [id, label] of tracked) {
        if (!current.has(id)) notice(id, "was closed while TUIOS was disconnected", label);
      }
    } catch (error) {
      console.error(`[picode] TUIOS listener resync failed: ${String(error)}`);
    } finally {
      reconciling = false;
    }
  };
  const schedule = () => {
    if (stopped || retry) return;
    const delay = Math.min(RECONNECT_MS * 2 ** failures++, 30_000);
    retry = setTimeout(() => {
      retry = null;
      void reconcile().then(connect);
    }, delay);
  };
  const connect = () => {
    if (stopped) return;
    const params: JsonRecord = {
      session: runtime.session,
      types: ["window-closed", "window-exit"],
    };
    if (lastSeq !== undefined && bootId) {
      params.after_seq = lastSeq;
      params.boot_id = bootId;
    }
    stopSocket = runtime.client.subscribe(
      params,
      event => {
        // A gap marker, or an event stamped with a different boot id than the
        // ack (daemon restarted mid-stream). Events that simply omit boot_id
        // are not a restart signal — only a present, different id is.
        if (
          event.type === "gap" ||
          (bootId && typeof event.boot_id === "string" && event.boot_id !== bootId)
        ) {
          void reconcile();
          if (typeof event.boot_id === "string") bootId = event.boot_id;
          return;
        }
        if (typeof event.seq === "number") lastSeq = event.seq;
        if (event.session !== runtime.session) return;
        const id = event.window;
        if (typeof id !== "string" || !tracked.has(id)) return;
        if (event.type === "window-closed" || event.type === "window-exit") {
          notice(
            id,
            event.type === "window-exit" ? "process exited" : "was closed",
            tracked.get(id) || "",
          );
        }
      },
      error => {
        console.error(`[picode] TUIOS listener disconnected: ${error.message}`);
        stopSocket = null;
        schedule();
      },
      ack => {
        failures = 0;
        if (typeof ack.boot_id === "string") bootId = ack.boot_id;
        if (lastSeq === undefined && typeof ack.seq === "number") lastSeq = ack.seq;
      },
    );
  };
  connect();
  return {
    stop() {
      stopped = true;
      stopSocket?.();
      stopSocket = null;
      if (retry) clearTimeout(retry);
      retry = null;
    },
    trackPane(id) {
      // A newly created window may not yet appear in this instance's last
      // snapshot; the caller obtained its exact ID from new-window.
      tracked.set(id, runtime.panes.find(pane => pane.id === id)?.label || "worker");
    },
    untrackPane(id) {
      tracked.delete(id);
    },
    trackedPaneCount() {
      return tracked.size;
    },
  };
}
