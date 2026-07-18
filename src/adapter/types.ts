import type { StateFile, Envelope, PicodeSummary } from "../core/types";

/**
 * Storage backend for picode (PROTOCOL-FORMALISM.md §5). Domain-shaped
 * (not a generic fs shim) so it maps cleanly onto both a local filesystem and
 * an RPC-based backend like Restate, whose durable state is per-key get/set
 * on a virtual object rather than a file tree.
 *
 * Pure storage: there is no wake/timer member. A future self-wake is a
 * self-addressed envelope with `deliverAfter`, held by the store until due.
 */
export interface StorageAdapter {
  /** One-time setup, called from PicodeStore.init() with the resolved cwd.
   *  For LocalFsAdapter this ensures `.picode/threads` exists. No-op for
   *  backends with no local root. */
  configure(baseDir: string): Promise<void>;

  loadPicodeState(picodeId: string): Promise<StateFile | undefined>;
  savePicodeState(picodeId: string, state: StateFile): Promise<void>;

  listPcodes(): Promise<PicodeSummary[]>;
  threadExists(picodeId: string): Promise<boolean>;

  /** Deliver a message into the mailbox `message.to` names. The envelope is
   *  self-contained (§6) — there is no separate target parameter. MUST be
   *  durable before it returns; MUST NOT make the envelope drainable before
   *  its `deliverAfter` (if present) has passed. */
  enqueueMessage(message: Envelope): Promise<void>;
  /** Claim and return all *due* pending messages for this picode (FIFO
   *  order). Claimed messages move to a "claimed/" staging area — if the
   *  process crashes after drain but before the caller processes them,
   *  the next configure() drains claimed/ back to inbox (no at-most-once loss).
   *  Envelopes whose `deliverAfter` is still in the future stay queued. */
  drainInbox(picodeId: string): Promise<Envelope[]>;
  /** Called after caller successfully processes and injects all drained
   *  messages — moves them from claimed/ to processed/ (audit trail).
   *  Messages not finalized before a crash are recovered at next configure(). */
  finalizeDrain(picodeId: string): Promise<void>;
  /** Live-drain trigger. Not a durability guarantee — cold-start drain via
   *  drainInbox() at session_start is what makes delivery durable. Returns
   *  a disposer. */
  watchInbox(picodeId: string, cb: () => void): () => void;
}

/** Optional extension (§5): the journal channel. Not part of the message
 *  world proper — a union over it (§8.3). Backends that omit it simply have
 *  no journal channel, and readers degrade gracefully. */
export interface JournalAdapter {
  appendJournal(picodeId: string, entry: string): Promise<void>;
  readJournal(picodeId: string): Promise<string | undefined>;
  /** Replace journal content atomically (write-tmp + rename). Used by
   *  compaction. Must acquire the same lock as appendJournal. */
  setJournal(picodeId: string, content: string): Promise<void>;
  /** Remove the journal entirely. After this, readJournal returns undefined. */
  deleteJournal(picodeId: string): Promise<void>;
  /** Acquire journal.lock for the picode. Returns when held. Throws on
   *  giveup after retries. Stale detection by mtime (no PID tracking). */
  acquireJournalLock(picodeId: string): Promise<void>;
  releaseJournalLock(picodeId: string): Promise<void>;
}

/** What the client stack actually holds: core storage plus whatever
 *  extensions the backend implements. */
export type PicodeAdapter = StorageAdapter & Partial<JournalAdapter>;
