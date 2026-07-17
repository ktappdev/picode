import * as fs from "node:fs";
import * as path from "node:path";
import type { StateFile, Envelope, ThreadSummary } from "../core/types";
import { PROCESSED_TTL_MS, toSummary } from "../core/types";
import { ulid } from "../core/ids";
import type { StorageAdapter, JournalAdapter } from "./types";

/** Keep processed/ from growing forever — messages are audit trail, not archive. */
function pruneProcessed(dir: string) {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - PROCESSED_TTL_MS;
  for (const f of files) {
    try {
      if (fs.statSync(path.join(dir, f)).mtimeMs < cutoff) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch {
      // ignore — GC is best-effort
    }
  }
}

/** Envelope ids are `<from>/<ulid>` (§6.2); the filename is the ULID tail —
 *  time-sortable, so a sorted readdir IS FIFO order (Appendix B). Ids in a
 *  different (conforming) form are sanitized whole. */
function envelopeFileName(id: string): string {
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const safe = tail.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe || ulid()}.json`;
}

/** The local-fs binding (PROTOCOL-FORMALISM.md Appendix B):
 *
 *  .thread/threads/<threadId>/
 *    state.json        presence + client state
 *    journal.md        journal stream (JournalAdapter extension)
 *    inbox/            one envelope per file, filename = sortable id
 *    inbox.tmp/        enqueue staging (same filesystem)
 *
 *  Enqueue is write-to-staging + rename — atomic on POSIX, so a reader never
 *  sees a partial envelope. Drain is sorted readdir → filter due → rename to
 *  processed/ → return. No internal awaits: every method runs its fs calls
 *  synchronously before returning. */
/** How often drainInbox re-runs the processed/ GC per thread. A one-shot
 *  flag would let a long-lived process outgrow PROCESSED_TTL_MS forever. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export function createLocalFsAdapter(): StorageAdapter & JournalAdapter {
  let root = "";
  const lastPruned = new Map<string, number>();

  function threadDir(id: string): string {
    return path.join(root, id);
  }
  function statePath(id: string): string {
    return path.join(threadDir(id), "state.json");
  }
  function journalPath(id: string): string {
    return path.join(threadDir(id), "journal.md");
  }
  function journalLockPath(id: string): string {
    return path.join(threadDir(id), "journal.lock");
  }
  function inboxDir(id: string): string {
    return path.join(threadDir(id), "inbox");
  }
  function stagingDir(id: string): string {
    return path.join(threadDir(id), "inbox.tmp");
  }

  return {
    async configure(baseDir: string) {
      root = path.join(baseDir, ".thread", "threads");
      fs.mkdirSync(root, { recursive: true });
      // Recover claimed/ messages left by a crashed process (§7.6 at-most-once):
      // move them back to inbox so the next drain re-claims them.
      if (fs.existsSync(root)) {
        for (const d of fs.readdirSync(root, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const claimedDir = path.join(root, d.name, "inbox", "claimed");
          if (!fs.existsSync(claimedDir)) continue;
          const inbox = path.join(root, d.name, "inbox");
          for (const f of fs.readdirSync(claimedDir)) {
            if (!f.endsWith(".json")) continue;
            try {
              fs.renameSync(path.join(claimedDir, f), path.join(inbox, f));
            } catch {
              // race — harmless
            }
          }
        }
      }
    },

    async loadState(threadId: string): Promise<StateFile | undefined> {
      const f = statePath(threadId);
      if (!fs.existsSync(f)) return undefined;
      try {
        return JSON.parse(fs.readFileSync(f, "utf8")) as StateFile;
      } catch (err) {
        console.error("[thread] failed to read state.json:", err);
        return undefined;
      }
    },

    async saveState(threadId: string, state: StateFile) {
      fs.mkdirSync(threadDir(threadId), { recursive: true });
      // Write-temp + rename: presence readers (§8.1) never see a torn file.
      const tmp = statePath(threadId) + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, statePath(threadId));
    },

    async appendJournal(threadId: string, entry: string) {
      fs.mkdirSync(threadDir(threadId), { recursive: true });
      await this.acquireJournalLock(threadId);
      try {
        fs.appendFileSync(journalPath(threadId), entry);
      } finally {
        await this.releaseJournalLock(threadId);
      }
    },

    async setJournal(threadId: string, content: string) {
      fs.mkdirSync(threadDir(threadId), { recursive: true });
      await this.acquireJournalLock(threadId);
      try {
        const target = journalPath(threadId);
        const tmp = target + ".tmp";
        fs.writeFileSync(tmp, content);
        fs.renameSync(tmp, target);
      } finally {
        await this.releaseJournalLock(threadId);
      }
    },

    async deleteJournal(threadId: string) {
      fs.mkdirSync(threadDir(threadId), { recursive: true });
      await this.acquireJournalLock(threadId);
      try {
        try {
          fs.unlinkSync(journalPath(threadId));
        } catch {
          // Already gone — fine.
        }
      } finally {
        await this.releaseJournalLock(threadId);
      }
    },

    async acquireJournalLock(threadId: string) {
      const lockPath = journalLockPath(threadId);
      fs.mkdirSync(threadDir(threadId), { recursive: true });
      const STALE_MS = 10_000;
      const MAX_RETRIES = 40; // ~2s at 50ms each
      for (let i = 0; i < MAX_RETRIES; i++) {
        try {
          const fd = fs.openSync(lockPath, "wx");
          // Hold the fd until release — keeps the file from disappearing
          // and signals to other processes we're alive.
          fs.closeSync(fd);
          return;
        } catch (e: unknown) {
          if (e instanceof Error && (e as NodeJS.ErrnoException).code === "EEXIST") {
            // Check mtime — stale if older than STALE_MS.
            try {
              const stat = fs.statSync(lockPath);
              if (Date.now() - stat.mtimeMs > STALE_MS) {
                // Stale — unlink and retry.
                try {
                  fs.unlinkSync(lockPath);
                } catch {
                  // Race — another process also detected stale and unlinked.
                }
                continue;
              }
            } catch {
              // Lock vanished between EEXIST and stat — retry the open.
              continue;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
            continue;
          }
          throw e;
        }
      }
      throw new Error(
        `Failed to acquire journal lock for thread "${threadId}" after ${MAX_RETRIES} retries.`,
      );
    },

    async releaseJournalLock(threadId: string) {
      const lockPath = journalLockPath(threadId);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Best-effort — lock may already be gone.
      }
    },

    async readJournal(threadId: string): Promise<string | undefined> {
      const f = journalPath(threadId);
      if (!fs.existsSync(f)) return undefined;
      const content = fs.readFileSync(f, "utf8").trim();
      return content || undefined;
    },

    async listThreads(): Promise<ThreadSummary[]> {
      if (!fs.existsSync(root)) return [];
      const ids = fs
        .readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      const out: ThreadSummary[] = [];
      for (const id of ids) {
        const f = statePath(id);
        if (!fs.existsSync(f)) continue;
        try {
          const s: StateFile = JSON.parse(fs.readFileSync(f, "utf8"));
          out.push(toSummary(s));
        } catch {
          // corrupt/partial — skip.
        }
      }
      return out;
    },

    async threadExists(threadId: string): Promise<boolean> {
      return fs.existsSync(statePath(threadId));
    },

    async enqueueMessage(message: Envelope) {
      const dir = inboxDir(message.to);
      const staging = stagingDir(message.to);
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(staging, { recursive: true });
      // Filename = the id's ULID tail: unique per sender by construction,
      // and a retry with the same id overwrites its own file — enqueue
      // idempotence (§7.6) for free.
      const fname = envelopeFileName(message.id);
      const tmp = path.join(staging, fname);
      fs.writeFileSync(tmp, JSON.stringify(message, null, 2));
      fs.renameSync(tmp, path.join(dir, fname));
    },

    async drainInbox(threadId: string): Promise<Envelope[]> {
      const dir = inboxDir(threadId);
      const claimedDir = path.join(dir, "claimed");
      const processedDir = path.join(dir, "processed");
      let files: string[];
      try {
        files = fs
          .readdirSync(dir)
          .filter(f => f.endsWith(".json"))
          .sort();
      } catch {
        return [];
      }
      fs.mkdirSync(claimedDir, { recursive: true });
      fs.mkdirSync(processedDir, { recursive: true });
      // Best-effort GC of the expired backlog, at most once per
      // PRUNE_INTERVAL_MS per thread, done *before* anything from this
      // drain is moved in.
      const last = lastPruned.get(threadId) ?? 0;
      if (Date.now() - last >= PRUNE_INTERVAL_MS) {
        lastPruned.set(threadId, Date.now());
        pruneProcessed(processedDir);
      }
      const now = Date.now();
      const claimed: Envelope[] = [];
      for (const f of files) {
        const full = path.join(dir, f);
        let msg: Envelope;
        try {
          msg = JSON.parse(fs.readFileSync(full, "utf8"));
        } catch {
          continue; // malformed — left in place, retried every drain, never dropped
        }
        // Not due yet (§6 deliverAfter): stays queued; a later drain
        // (heartbeat, boot) picks it up once the instant passes.
        if (msg.deliverAfter && new Date(msg.deliverAfter).getTime() > now) continue;
        // Expired (Rev 10 §6 expiresAt): never delivered — moved directly
        // to processed/ as audit trail without being returned.
        if (msg.expiresAt && new Date(msg.expiresAt).getTime() <= now) {
          try {
            fs.renameSync(full, path.join(processedDir, f));
          } catch {
            // claim race — theirs now
          }
          continue;
        }
        // Move to claimed/ first — at-most-once: if the caller crashes
        // before finalizeDrain, configure() recovers these back to inbox.
        try {
          fs.renameSync(full, path.join(claimedDir, f));
        } catch {
          continue; // already claimed — shouldn't happen (single reader)
        }
        claimed.push(msg);
      }
      return claimed;
    },

    async finalizeDrain(threadId: string) {
      const dir = inboxDir(threadId);
      const claimedDir = path.join(dir, "claimed");
      const processedDir = path.join(dir, "processed");
      if (!fs.existsSync(claimedDir)) return;
      fs.mkdirSync(processedDir, { recursive: true });
      for (const f of fs.readdirSync(claimedDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          fs.renameSync(path.join(claimedDir, f), path.join(processedDir, f));
        } catch {
          // race — harmless
        }
      }
    },

    watchInbox(threadId: string, cb: () => void): () => void {
      try {
        // A thread that has never received a message has no inbox/ dir yet —
        // fs.watch throws ENOENT on a path that doesn't exist, so create it
        // first rather than leaving this thread with a silently no-op watch
        // (the returned disposer) until its next process restart.
        fs.mkdirSync(inboxDir(threadId), { recursive: true });
        const watcher = fs.watch(inboxDir(threadId), cb);
        return () => watcher.close();
      } catch (err) {
        console.error("[thread] failed to watch inbox:", err);
        return () => {};
      }
    },
  };
}
