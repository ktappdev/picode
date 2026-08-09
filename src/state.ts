import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PicodeStore, PicodeState, PicodeSummary, StateFile } from "./core/types";
import { HEARTBEAT_MS, CLIENT_CAPABILITIES } from "./core/types";
import { nowIso } from "./core/time";
import { forkJournalEntry, compactJournal as compactJournalFn } from "./journal";
import { detectWorkerRole, roleEmoji } from "./core/roles";
import type { PicodeAdapter } from "./adapter/types";
import { createLocalFsAdapter } from "./adapter/local-fs";
import { loadModelsJson } from "./tools/spawn";

/** The PicodeStore: this picode's identity and mutable coordination state,
 *  restored from the storage adapter at init, persisted on every change, kept
 *  fresh by the heartbeat, and live-drained by the inbox watcher. */

/** Check whether a process with the given PID is still alive on this machine.
 *  Signal 0 is a null signal — doesn't actually send anything, just checks
 *  existence and permission.  Returns false for dead processes (ESRCH) and
 *  for permission-denied processes (EPERM — likely a different user's, so
 *  we can't claim it's stale). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    // EPERM or other — process exists but we can't signal it; treat as alive
    return true;
  }
}

const KNOWN_STATES: readonly PicodeState[] = [
  "idle",
  "thinking",
  "working",
  "open",
  "on-hold",
  "stopped",
  "done",
];

export function createPicodeStore(
  pi: ExtensionAPI,
  adapter: PicodeAdapter = createLocalFsAdapter(),
): PicodeStore {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let stopWatching: (() => void) | null = null;

  const store: PicodeStore = {
    // --- mutable data ---
    adapter,
    picodeId: "",
    picodeDir: "",
    picodesRootDir: "",
    parent: null,
    role: "worker",
    sessionFile: null,
    startedAt: "",
    state: "idle",
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

    // --- operations ---

    async transition(next: PicodeState, ctx?: ExtensionContext) {
      store.state = next;
      await store.persist();
      ctx?.ui.setStatus(
        "picode",
        `${roleEmoji(store.role)} ${store.role ?? "worker"}: ${store.state}`,
      );
    },

    async persist() {
      if (!store.picodeId) return; // init() hasn't resolved an identity yet
      const payload: StateFile = {
        id: store.picodeId,
        pid: process.pid,
        cwd: process.cwd(),
        parent: store.parent,
        role: store.role,
        sessionFile: store.sessionFile,
        state: store.state,
        status: store.status,
        holdReason: store.holdReason,
        obligations: store.obligations,
        owed: store.owed,
        barriers: store.barriers,
        startedAt: store.startedAt,
        lastSeen: nowIso(),
        updatedAt: nowIso(),
        capabilities: [...CLIENT_CAPABILITIES],
        // Advisory revive recipe (Rev 10 §8.1) — published only when the
        // operator provides one: the extension can't guess a correct launch
        // incantation across machines and process managers.
        ...(process.env.PI_THREAD_WAKE ? { wake: process.env.PI_THREAD_WAKE } : {}),
      };
      await store.adapter.savePicodeState(store.picodeId, payload);
    },

    async init(cwd: string, ctx: ExtensionContext) {
      await store.adapter.configure(cwd);
      store.picodesRootDir = path.join(cwd, ".picode", "picodes");

      // Resolve picode identity.
      const flagId = pi.getFlag("picode-id");
      const picodeShorthand = pi.getFlag("picode");
      // --picode (boolean) defaults to coordinator when no --picode-id given
      const resolvedId =
        typeof flagId === "string" && flagId
          ? flagId
          : picodeShorthand === true
            ? "coordinator"
            : undefined;
      if (typeof resolvedId === "string") {
        store.picodeId = resolvedId;
      } else {
        let existingId: string | undefined;
        try {
          const entries = ctx.sessionManager.getEntries();
          for (const e of entries) {
            if (e.type === "custom" && e.customType === "picode-identity") {
              const entry = e as { data?: { id?: string } };
              if (entry.data?.id) existingId = entry.data.id;
            }
          }
        } catch {
          // --no-session or unreadable session — generate a new id.
        }
        store.picodeId = existingId ?? `picode-${crypto.randomUUID().slice(0, 8)}`;
        if (!existingId) pi.appendEntry("picode-identity", { id: store.picodeId });
      }

      const flagParent = pi.getFlag("picode-parent");
      store.parent =
        typeof flagParent === "string" && flagParent
          ? flagParent
          : store.picodeId !== "coordinator"
            ? "coordinator"
            : null;
      const flagRole = pi.getFlag("picode-role");
      if (typeof flagRole === "string" && flagRole) {
        store.role = flagRole;
      } else if (store.picodeId === "coordinator") {
        store.role = "coordinator";
      } else {
        // Auto-detect canonical worker role from picode-id. Explorer is a
        // legacy alias for scout; planner/runner must also work when the
        // zshrc `picode` helper passes only --picode-id.
        store.role = detectWorkerRole(store.picodeId);
      }

      // Auto-create default models config for coordinator
      if (store.role === "coordinator") {
        const modelsPath = path.join(cwd, ".picode", "models.json");
        if (!fs.existsSync(modelsPath)) {
          const defaultModels = {
            builder: "deepseek/deepseek-v4-pro",
            reviewer: "deepseek/deepseek-v4-pro",
            tester: "deepseek/deepseek-v4-pro",
            designer: "deepseek/deepseek-v4-pro",
            visionary: "opencode-go/mimo-v2.5",
            "bug-hunter": "deepseek/deepseek-v4-pro",
            scout: "deepseek/deepseek-v4-flash",
            default: "deepseek/deepseek-v4-flash",
            journal: "deepseek/deepseek-v4-flash",
            "journal-cadence": "done",
          };
          fs.writeFileSync(modelsPath, JSON.stringify(defaultModels, null, 2) + "\n");
        }
      }

      store.picodeDir = path.join(store.picodesRootDir, store.picodeId);

      // Restore previous state if present. Debts and barriers are durable
      // waits — restored unconditionally (§13.2): a reply may arrive while
      // we're down, and the id a reply must echo has to survive the session
      // that received the envelope. No state encodes a wait anymore (§11.2),
      // so the only boot repair is done/stopped → idle; states this revision
      // no longer knows (old files) settle to open.
      const s = await store.adapter.loadPicodeState(store.picodeId);
      if (s) {
        store.obligations = s.obligations ?? [];
        store.owed = s.owed ?? [];
        store.barriers = s.barriers ?? [];
        store.state =
          s.state === "done" || s.state === "stopped"
            ? "idle"
            : KNOWN_STATES.includes(s.state)
              ? s.state
              : "open";
        store.holdReason = store.state === "on-hold" ? (s.holdReason ?? null) : null;
        store.parent = store.parent ?? s.parent ?? null;
        store.role = store.role ?? s.role ?? "worker";
      }

      // Acquire init lock BEFORE checks to close the TOCTOU window between
      // checking and persisting. We write our PID into the lock file so a
      // later process can detect a stale lock (process killed mid-init) and
      // recover instead of leaving the workspace bricked.
      fs.mkdirSync(store.picodeDir, { recursive: true });
      const lockPath = path.join(store.picodeDir, "init.lock");
      let lockFd: number | null = null;
      try {
        lockFd = fs.openSync(lockPath, "wx");
        // Write PID so stale-lock detection can verify liveness.
        fs.writeSync(lockFd, String(process.pid));
      } catch (e: unknown) {
        if (e instanceof Error && (e as NodeJS.ErrnoException).code === "EEXIST") {
          // Lock file exists — check if it's stale (holder process died).
          let stale = false;
          try {
            const content = fs.readFileSync(lockPath, "utf-8").trim();
            const holderPid = parseInt(content, 10);
            if (!Number.isNaN(holderPid) && !isPidAlive(holderPid)) {
              stale = true;
            }
          } catch {
            // Can't read lock file — treat as stale (malformed/unreadable).
            stale = true;
          }
          if (stale) {
            try {
              fs.unlinkSync(lockPath);
            } catch {
              /* best-effort */
            }
            // Retry: the lock was stale, now try to acquire it fresh.
            lockFd = fs.openSync(lockPath, "wx");
            fs.writeSync(lockFd, String(process.pid));
          } else {
            throw new Error(
              `Picode "${store.picodeId}" is already starting (init.lock held). ` +
                `Wait a moment and retry, or use a different --picode-id.`,
            );
          }
        } else {
          throw new Error(
            `Failed to acquire init lock for picode "${store.picodeId}": ${String(e)}`,
          );
        }
      }

      try {
        // Duplicate picode ID enforcement: IDs must be unique across running threads.
        // Check before first persist — if another picode with our ID is already running,
        // block startup to prevent shared state file corruption.
        // BUT also verify the PID is actually alive: a crashed process left behind
        // "running" status in state.json is a stale artifact, not a real conflict.
        {
          const all = await store.listPcodes();
          const dup = all.find(t => t.id === store.picodeId && t.status === "running");
          if (dup) {
            // If state.json includes the PID (Rev 10+), verify it's still alive.
            // Dead PID + stale status → treat as dead, allow startup.
            if (typeof dup.pid === "number" && !isPidAlive(dup.pid)) {
              // Stale — the previous instance crashed. Proceed.
            } else {
              throw new Error(
                `Picode "${store.picodeId}" already exists and is running. ` +
                  `Use a unique --picode-id (e.g. --picode-id ${store.picodeId}-2).`,
              );
            }
          }
        }

        // Coordinator singleton enforcement: only one active coordinator per workspace
        if (store.role === "coordinator") {
          const threads = await store.listPcodes();
          const activeCoord = threads.find(
            t => t.id !== store.picodeId && t.role === "coordinator" && t.status === "running",
          );
          if (activeCoord) {
            // Stale check: if the coordinator PID is dead, it's not really running.
            if (typeof activeCoord.pid === "number" && !isPidAlive(activeCoord.pid)) {
              // Stale — the previous coordinator crashed. Proceed.
            } else {
              throw new Error(
                `Coordinator "${activeCoord.id}" already exists. Cannot start another coordinator. ` +
                  `Use a different role (e.g. --picode-role worker).`,
              );
            }
          }
        }

        try {
          store.sessionFile = ctx.sessionManager.getSessionFile() ?? null;
        } catch {
          store.sessionFile = null;
        }
        store.startedAt = nowIso();
        store.status = "running";
        await store.persist();
        ctx.ui.setStatus(
          "picode",
          `${roleEmoji(store.role)} ${store.role ?? "worker"}: ${store.state}`,
        );
      } finally {
        // Always release the init lock, even if persist or checks threw.
        if (lockFd !== null) {
          fs.closeSync(lockFd);
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* best-effort */
          }
        }
      }
    },

    async shutdown(reason: string) {
      store.stopHeartbeat();
      store.stopWatcher();
      // Always mark as stopped — a stale "running" status from a crashed or
      // killed process blocks restart until STALE_MS elapses or the PID
      // check fires. The PID check handles crashes, but the first new launch
      // after a clean exit (reason: "quit") needs the status updated too.
      // Only deliberate resting states (done, on-hold) survive a clean exit.
      if (reason !== "quit") {
        store.state = "stopped";
      } else {
        const preserved = new Set(["done", "on-hold"]);
        if (!preserved.has(store.state)) store.state = "stopped";
      }
      store.status = "stopped";
      await store.persist();
    },

    async listPcodes(): Promise<PicodeSummary[]> {
      return store.adapter.listPcodes();
    },

    async threadExists(picodeId: string): Promise<boolean> {
      return store.adapter.threadExists(picodeId);
    },

    async readJournal(picodeId: string): Promise<string | undefined> {
      // The journal channel is an optional backend extension (§5) —
      // undefined on backends without it.
      return store.adapter.readJournal?.(picodeId);
    },

    forkJournal(sessionFile: string) {
      const flag = pi.getFlag("picode-journal-model");
      const m = (typeof flag === "string" && flag) || loadModelsJson()["journal"] || undefined;
      forkJournalEntry(store, sessionFile, m);
    },

    compactJournal(sessionFile: string) {
      if (!store.sessionFile) return;
      const flag = pi.getFlag("picode-journal-model");
      const m = (typeof flag === "string" && flag) || loadModelsJson()["journal"] || undefined;
      compactJournalFn(store, sessionFile, m);
    },

    startHeartbeat(onTick?: () => void | Promise<void>) {
      // session_start can fire more than once in a process lifetime (e.g. a
      // session reload) — dispose the previous interval or it leaks and
      // double-fires every deadline check.
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        void (async () => {
          await store.persist();
          await onTick?.();
        })().catch(err => console.error("[picode] heartbeat tick failed:", err));
      }, HEARTBEAT_MS);
    },

    stopHeartbeat() {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    },

    startWatcher(drainInbox, ctx) {
      stopWatching?.();
      stopWatching = store.adapter.watchInbox(store.picodeId, () => drainInbox(ctx));
    },

    stopWatcher() {
      if (stopWatching) stopWatching();
      stopWatching = null;
    },
  };

  return store;
}
