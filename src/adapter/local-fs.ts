import * as fs from "node:fs";
import * as path from "node:path";
import type { StateFile, Envelope, PicodeSummary } from "../core/types";
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
 *  .picode/picodes/<picodeId>/
 *    state.json        presence + client state
 *    journal.md        journal stream (JournalAdapter extension)
 *    inbox/            one envelope per file, filename = sortable id
 *    inbox.tmp/        enqueue staging (same filesystem)
 *
 *  Enqueue is write-to-staging + rename — atomic on POSIX, so a reader never
 *  sees a partial envelope. Drain is sorted readdir → filter due → rename to
 *  processed/ → return. No internal awaits: every method runs its fs calls
 *  synchronously before returning. */
/** How often drainInbox re-runs the processed/ GC per picode. A one-shot
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
      root = path.join(baseDir, ".picode", "picodes");
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

    async loadPicodeState(picodeId: string): Promise<StateFile | undefined> {
      const f = statePath(picodeId);
      if (!fs.existsSync(f)) return undefined;
      try {
        return JSON.parse(fs.readFileSync(f, "utf8")) as StateFile;
      } catch (err) {
        console.error("[picode] failed to read state.json:", err);
        return undefined;
      }
    },

    async savePicodeState(picodeId: string, state: StateFile) {
      fs.mkdirSync(threadDir(picodeId), { recursive: true });
      // Write-temp + rename: presence readers (§8.1) never see a torn file.
      const tmp = statePath(picodeId) + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, statePath(picodeId));
    },

    async appendJournal(picodeId: string, entry: string) {
      fs.mkdirSync(threadDir(picodeId), { recursive: true });
      await this.acquireJournalLock(picodeId);
      try {
        fs.appendFileSync(journalPath(picodeId), entry);
      } finally {
        await this.releaseJournalLock(picodeId);
      }
    },

    async setJournal(picodeId: string, content: string) {
      fs.mkdirSync(threadDir(picodeId), { recursive: true });
      await this.acquireJournalLock(picodeId);
      try {
        const target = journalPath(picodeId);
        const tmp = target + ".tmp";
        fs.writeFileSync(tmp, content);
        fs.renameSync(tmp, target);
      } finally {
        await this.releaseJournalLock(picodeId);
      }
    },

    async deleteJournal(picodeId: string) {
      fs.mkdirSync(threadDir(picodeId), { recursive: true });
      await this.acquireJournalLock(picodeId);
      try {
        try {
          fs.unlinkSync(journalPath(picodeId));
        } catch {
          // Already gone — fine.
        }
      } finally {
        await this.releaseJournalLock(picodeId);
      }
    },

    async acquireJournalLock(picodeId: string) {
      const lockPath = journalLockPath(picodeId);
      fs.mkdirSync(threadDir(picodeId), { recursive: true });
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
        `Failed to acquire journal lock for picode "${picodeId}" after ${MAX_RETRIES} retries.`,
      );
    },

    async releaseJournalLock(picodeId: string) {
      const lockPath = journalLockPath(picodeId);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Best-effort — lock may already be gone.
      }
    },

    async readJournal(picodeId: string): Promise<string | undefined> {
      const f = journalPath(picodeId);
      if (!fs.existsSync(f)) return undefined;
      const content = fs.readFileSync(f, "utf8").trim();
      return content || undefined;
    },

    async listPcodes(): Promise<PicodeSummary[]> {
      if (!fs.existsSync(root)) return [];
      const ids = fs
        .readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      const out: PicodeSummary[] = [];
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

    async threadExists(picodeId: string): Promise<boolean> {
      return fs.existsSync(statePath(picodeId));
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

    async drainInbox(picodeId: string): Promise<Envelope[]> {
      const dir = inboxDir(picodeId);
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
      // PRUNE_INTERVAL_MS per picode, done *before* anything from this
      // drain is moved in.
      const last = lastPruned.get(picodeId) ?? 0;
      if (Date.now() - last >= PRUNE_INTERVAL_MS) {
        lastPruned.set(picodeId, Date.now());
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

    async finalizeDrain(picodeId: string) {
      const dir = inboxDir(picodeId);
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

    watchInbox(picodeId: string, cb: () => void): () => void {
      try {
        // A picode that has never received a message has no inbox/ dir yet —
        // fs.watch throws ENOENT on a path that doesn't exist, so create it
        // first rather than leaving this picode with a silently no-op watch
        // (the returned disposer) until its next process restart.
        fs.mkdirSync(inboxDir(picodeId), { recursive: true });
        const watcher = fs.watch(inboxDir(picodeId), cb);
        return () => watcher.close();
      } catch (err) {
        console.error("[picode] failed to watch inbox:", err);
        return () => {};
      }
    },
  };
}
