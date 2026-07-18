import { connect } from "@restatedev/restate-sdk-clients";
import type { StateFile, Envelope, PicodeSummary } from "../core/types";
import { toSummary } from "../core/types";
import type { StorageAdapter, JournalAdapter } from "../adapter/types";
import type { PicodeObjectApi, PicodeRegistryApi } from "./service";

const PicodeObjectRef = { name: "Picode" } as PicodeObjectApi;
const RegistryRef = { name: "PicodeRegistry" } as PicodeRegistryApi;

const POLL_MS = 2000;

/** Client-side adapter — the `pi` process is a Restate *ingress client*, not
 *  a hosted handler. All storage/mailbox operations become RPCs into the
 *  `Picode`/`PicodeRegistry` virtual objects defined in ./service.ts (run
 *  separately via `npm run restate:serve`, registered with a self-hosted
 *  `restate-server`). See README.md "Running with the Restate adapter".
 *
 *  deliverAfter needs no client-side machinery here: the service holds
 *  future envelopes out of drainInbox until due, and its own durable delayed
 *  self-invocation revives a stopped picode when one comes due. */
export function createRestateAdapter(opts: { url?: string }): StorageAdapter & JournalAdapter {
  const ingress = connect({ url: opts.url ?? "http://localhost:8080" });
  const picode = (id: string) => ingress.objectClient(PicodeObjectRef, id);

  return {
    async configure() {
      // No local root — each picode is addressed by id against the ingress
      // URL, not a cwd-scoped directory.
    },

    async loadPicodeState(picodeId: string): Promise<StateFile | undefined> {
      return (await picode(picodeId).loadPicodeState()) ?? undefined;
    },

    async savePicodeState(picodeId: string, state: StateFile) {
      await picode(picodeId).savePicodeState(state);
    },

    async appendJournal(picodeId: string, entry: string) {
      await this.acquireJournalLock(picodeId);
      try {
        await picode(picodeId).appendJournal(entry);
      } finally {
        await this.releaseJournalLock(picodeId);
      }
    },

    async readJournal(picodeId: string): Promise<string | undefined> {
      return (await picode(picodeId).readJournal()) ?? undefined;
    },

    async setJournal(picodeId: string, content: string) {
      await this.acquireJournalLock(picodeId);
      try {
        await picode(picodeId).setJournal(content);
      } finally {
        await this.releaseJournalLock(picodeId);
      }
    },

    async deleteJournal(picodeId: string) {
      await this.acquireJournalLock(picodeId);
      try {
        await picode(picodeId).setJournal("");
      } finally {
        await this.releaseJournalLock(picodeId);
      }
    },

    // Restate virtual object already serializes per-key — the journal
    // mutations are atomic in the service's own journal key, so no client-
    // side lock is needed (and none could be observed by the service anyway).
    async acquireJournalLock(_threadId: string) {
      // no-op: restate virtual object serializes per-key
    },

    async releaseJournalLock(_threadId: string) {
      // no-op
    },

    async listPcodes(): Promise<PicodeSummary[]> {
      const ids = await ingress.objectClient(RegistryRef, "all").list();
      const out: PicodeSummary[] = [];
      for (const id of ids) {
        const s = await picode(id).loadPicodeState();
        if (s) out.push(toSummary(s));
      }
      return out;
    },

    async threadExists(picodeId: string): Promise<boolean> {
      return (await picode(picodeId).loadPicodeState()) != null;
    },

    async enqueueMessage(message: Envelope) {
      await picode(message.to).enqueueMessage(message);
    },

    async drainInbox(picodeId: string): Promise<Envelope[]> {
      return picode(picodeId).drainInbox();
    },

    // Restate is transactional: drainInbox atomically removes messages from
    // the persistent queue, so a crash after drain is no worse than a crash
    // before — the RPC either committed or it didn't. No claimed/ staging needed.
    async finalizeDrain(_threadId: string) {
      // no-op: at-most-once is inherent in the RPC transaction boundary
    },

    watchInbox(_threadId: string, cb: () => void): () => void {
      // No push-based watch across a network boundary — poll instead. Worse
      // live-latency than local fs.watch, same durability guarantee (the
      // cold-start drain at session_start is what actually guarantees
      // delivery, same as the local backend).
      const timer = setInterval(cb, POLL_MS);
      return () => clearInterval(timer);
    },
  };
}
