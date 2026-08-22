import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PicodeStore, Envelope, Urgency } from "./core/types";
import { STALE_MS, DEFAULT_OBLIGATION_DEADLINE_MS } from "./core/types";
import { mintEnvelopeId } from "./core/ids";
import { nowIso } from "./core/time";

/** The messaging engine (PROTOCOL-FORMALISM.md §§6–9): envelope sends and
 *  their bookkeeping (obligations, owed replies), delivery of incoming
 *  envelopes with barrier resolution, and the heartbeat's deadline checks. */

/** How long after an idle-time injection we assume pi's prompt preflight is
 *  still running (it ends at turn_start, which clears the hold early). */
export const INJECTION_GRACE_MS = 3_000;

/** Grace period after a barrier/obligation deadline passes before we
 *  expire and drop it. checkDeadlines first nudges (one-time reminder) at
 *  the deadline; if still unresolved this long after the deadline, the
 *  record is removed from the store so it doesn't linger forever waiting
 *  for a reply that will never come. The coordinator gets one nudge to
 *  follow up; if it doesn't (or can't), the record is reaped rather than
 *  silently pinning state. Equal to the default obligation deadline so a
 *  standard 15m SLA gives ~15m to reply + ~15m to act on the nudge. */
export const DEADLINE_EXPIRY_GRACE_MS = DEFAULT_OBLIGATION_DEADLINE_MS;
/** How long a compaction may hold the inbox shut before we assume its end
 *  event was swallowed (compaction failures emit no extension event). */
export const COMPACTION_HOLD_MAX_MS = 180_000;

/** One unit of text bound for this picode's own session. */
export interface Injection {
  text: string;
  urgency: Urgency;
}

export interface SendResult {
  id: string;
  delivered: "queued" | "live";
}

export interface SendOptions {
  /** Reply correlation: discharges the debt on this envelope id (§9.1). */
  re?: string;
  /** Track a debt: the receiver owes a reply with re = this send's id. */
  expects?: boolean;
  urgency?: Urgency;
  /** Not deliverable before this instant — a self-addressed deliverAfter
   *  envelope is the protocol's scheduled wake (§12.2). */
  deliverAfter?: string;
  /** Not deliverable after this instant — discarded at drain (Rev 10 §6). */
  expiresAt?: string;
  /** Obligation deadline; defaults per §9.2 when expects is set. */
  deadline?: string;
}

export interface Inbox {
  sendEnvelope(to: string, body: string, opts?: SendOptions): Promise<SendResult>;
  /** sendEnvelope over a resolved target list, collecting per-target results.
   *  Each target gets its own minted id, so fan-out replies stay
   *  individually correlatable. */
  sendToMany(
    targets: string[],
    body: string,
    opts?: SendOptions,
  ): Promise<(SendResult & { to: string })[]>;
  /** Expand a `to` spec — "*", "role:<role>", or comma-separated ids — into picode ids. */
  resolveTargets(to: string): Promise<string[]>;
  /** Which of these ids have never run in this workspace (likely typos). */
  findMissingTargets(targets: string[]): Promise<string[]>;
  /** Bookkeeping for one envelope (debts, barriers) — returns the
   *  injection parts; the caller batches them into one inject(). */
  deliver(msg: Envelope, ctx: ExtensionContext): Promise<Injection[]>;
  /** Drain queued envelopes. Standalone (no `collect`) it injects its own
   *  batch; when the heartbeat passes a shared `collect` array it pushes its
   *  parts there instead, so both heartbeat sources ship in one inject(). */
  drainInbox(ctx: ExtensionContext, collect?: Injection[]): Promise<void>;
  isTargetLive(to: string): Promise<boolean>;
  /** Called from the heartbeat: a one-time reminder per overdue obligation
   *  or barrier. With `collect`, pushes parts into the shared batch. */
  checkDeadlines(ctx: ExtensionContext, collect?: Injection[]): Promise<void>;
  /** Push parts into this session as ONE user message (steer if any part is
   *  urgency=high). */
  inject(parts: Injection[], ctx: ExtensionContext): void;
  /** Commit staged messages from claimed/ to processed/ — call after the
   *  caller's inject() has safely queued the drained messages. */
  finalizeDrain(): Promise<void>;
  /** False while an idle-time injection is in preflight or a compaction is
   *  running — drains and nudges wait (messages stay durable on disk). This
   *  is the §7.7 declare-and-shrink gate: we only claim envelopes when we
   *  can deliver them in the same tick. */
  canInject(): boolean;
  noteCompactionStart(): void;
  noteCompactionEnd(): void;
  /** A turn started: pi is streaming, so injections queue safely again. */
  noteRunStarted(): void;
  /** Called after every inject() with the parts that were injected. */
  onInjected?: (parts: Injection[]) => void;
  /** Called after inject() with parts and ctx — used by current-task widget. */
  onInject?: (parts: Injection[], ctx: ExtensionContext) => void;
}

export function createInbox(store: PicodeStore, pi: ExtensionAPI): Inbox {
  // --- injection gate ----------------------------------------------------
  // pi.sendUserMessage during a run queues safely (pi drains its queues at
  // turn boundaries and after agent_end handlers). While idle it starts a
  // new run after an async preflight, and two of those in flight race — the
  // loser throws "Agent is already processing" and its message is dropped.
  // Worse, during auto-compaction the agent *looks* idle, so an injection
  // starts a run that races the compaction's context rewrite. The gate
  // serializes idle injections and holds the drain shut during compaction;
  // gated messages stay durable on disk and are retried from the watcher,
  // turn boundaries, and the heartbeat.
  let inFlightSince: number | null = null;
  let compactingSince: number | null = null;
  let _onInjected: ((parts: Injection[]) => void) | undefined;
  let _onInject: ((parts: Injection[], ctx: ExtensionContext) => void) | undefined;

  function canInject(): boolean {
    const now = Date.now();
    if (compactingSince !== null && now - compactingSince < COMPACTION_HOLD_MAX_MS) return false;
    if (inFlightSince !== null && now - inFlightSince < INJECTION_GRACE_MS) return false;
    return true;
  }

  function inject(parts: Injection[], ctx: ExtensionContext): void {
    if (parts.length === 0) return;
    // One coalesced message per batch (§7.5): a high-urgency part anywhere
    // makes the whole batch steer; low parts just arrive a little earlier
    // than they had to, which is harmless.
    const steer = parts.some(p => p.urgency === "high");
    if (ctx.isIdle?.() ?? false) inFlightSince = Date.now();
    const body = parts.map(p => p.text).join("\n\n");
    if (store.role === "coordinator" && store.promptDrivenTurnSeen) {
      // Coordinator sees only a one-line header per batch — the full envelope
      // bodies stay in LLM context (sendMessage content is always converted
      // to a user message for the model) but are hidden from the operator's
      // screen by the picode-envelope renderer. Workers keep the verbose
      // sendUserMessage path: their incoming envelope IS their task, and the
      // human watching a worker pane wants to see it. triggerTurn:true
      // mirrors sendUserMessage's always-wake semantics so an idle
      // coordinator still starts a turn on incoming mail.
      //
      // Before the first prompt()-driven run (promptDrivenTurnSeen), a
      // sendMessage-triggered turn would run with the base system prompt —
      // no picode thread-model rules — so fall back to sendUserMessage,
      // which routes through prompt() and assembles them.
      pi.sendMessage(
        {
          customType: "picode-envelope",
          content: body,
          display: true,
          details: { count: parts.length, highUrgency: steer },
        },
        { triggerTurn: true, deliverAs: steer ? "steer" : "followUp" },
      );
    } else {
      pi.sendUserMessage(body, {
        deliverAs: steer ? "steer" : "followUp",
      });
    }
    _onInjected?.(parts);
    _onInject?.(parts, ctx);
  }

  function noteCompactionStart(): void {
    compactingSince = Date.now();
  }

  function noteCompactionEnd(): void {
    compactingSince = null;
  }

  function noteRunStarted(): void {
    inFlightSince = null;
    compactingSince = null;
  }

  async function isTargetLive(to: string): Promise<boolean> {
    const s = await store.adapter.loadPicodeState(to);
    if (!s) return false;
    return s.status === "running" && Date.now() - new Date(s.lastSeen).getTime() < STALE_MS;
  }

  async function resolveTargets(to: string): Promise<string[]> {
    if (to !== "*" && !to.startsWith("role:") && !to.includes(",")) return [to];
    const all = (await store.listPcodes()).filter(t => t.id !== store.picodeId);
    if (to === "*") return all.map(t => t.id);
    if (to.startsWith("role:")) {
      const role = to.slice(5);
      return all.filter(t => t.role === role).map(t => t.id);
    }
    return to
      .split(",")
      .map(s => s.trim())
      .filter(s => s && s !== store.picodeId);
  }

  async function sendEnvelope(
    to: string,
    body: string,
    opts: SendOptions = {},
  ): Promise<SendResult> {
    if (!store.picodeId || !store.picodesRootDir) {
      // Without an identity the message would land at a cwd-relative path
      // nothing ever drains (observed in the wild as <cwd>/<to>/inbox/).
      throw new Error("Picode system not initialized yet — cannot send.");
    }
    const id = mintEnvelopeId(store.picodeId);
    const msg: Envelope = {
      id,
      from: store.picodeId,
      to,
      body,
      sentAt: nowIso(),
      ...(opts.re ? { re: opts.re } : {}),
      ...(opts.expects ? { expects: true as const } : {}),
      // Absence means "low" on the wire (§6) — only high is written.
      ...(opts.urgency === "high" ? { urgency: "high" as const } : {}),
      ...(opts.deliverAfter ? { deliverAfter: opts.deliverAfter } : {}),
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    };

    const delivered = (await isTargetLive(to)) ? "live" : "queued";
    await store.adapter.enqueueMessage(msg);

    if (opts.re) {
      // Sending the reply settles the durable owed-reply record made when the
      // expects envelope was delivered (see deliver()) — but ONLY when it
      // actually reaches the picode the debt is owed to (§9.1, Errata 1). A
      // misdirected or stale reply whose `re` merely collides with an
      // unrelated owed entry must not discharge it: the owed record stays put
      // so picode_status and the owed-reply nudge keep surfacing it.
      // (picode_send layers a soft warning on top; this is the real gate.)
      const owedMatch = store.owed.find(o => o.id === opts.re);
      if (owedMatch && owedMatch.from === to) {
        store.owed = store.owed.filter(o => o.id !== opts.re);
        await store.persist();
      }
    }

    if (opts.expects) {
      // deadlineFromSeconds already applies the default, so deadline is
      // always set for expects sends (§9.2).
      const deadline = opts.deadline!;
      store.obligations.push({
        id,
        to,
        summary: body.slice(0, 80),
        sentAt: msg.sentAt,
        deadline,
      });
      await store.persist();
    }
    return { id, delivered };
  }

  async function sendToMany(
    targets: string[],
    body: string,
    opts: SendOptions = {},
  ): Promise<(SendResult & { to: string })[]> {
    const sent: (SendResult & { to: string })[] = [];
    for (const to of targets) {
      sent.push({ to, ...(await sendEnvelope(to, body, opts)) });
    }
    return sent;
  }

  async function findMissingTargets(targets: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const t of targets) {
      if (!(await store.threadExists(t))) missing.push(t);
    }
    return missing;
  }

  /** Resolve any barriers waiting on this envelope id. Returns "resolved"
   *  notices (and any barrier payload messages, §12.1) to fold into the same
   *  wake-up as the envelope, rather than firing separate injections. */
  function resolveBarriers(re: string): { notes: string[]; payloads: Injection[] } {
    const remaining: typeof store.barriers = [];
    const notes: string[] = [];
    const payloads: Injection[] = [];
    for (const b of store.barriers) {
      if (!b.pending.includes(re)) {
        remaining.push(b);
        continue;
      }
      const pending = b.pending.filter(id => id !== re);
      const done = b.mode === "any" || pending.length === 0;
      if (done) {
        notes.push(
          `[barrier "${b.id}" resolved]: ${b.mode === "any" ? `first reply arrived (${re})` : "all awaited replies have arrived"}.`,
        );
        if (b.message) payloads.push({ text: b.message, urgency: "high" });
      } else {
        remaining.push({ ...b, pending });
      }
    }
    store.barriers = remaining;
    return { notes, payloads };
  }

  /** How the receiving agent sees an envelope. The id and the reply
   *  affordance must travel with the message — the model has no other way
   *  to learn the correlation id it must echo back. Kind is derived from
   *  field presence (§6.1), never a tag. */
  function renderEnvelope(msg: Envelope): string {
    const kind =
      msg.expects && msg.re ? "reply+request" : msg.expects ? "request" : msg.re ? "reply" : "note";
    const reTag = msg.re ? ` re #${msg.re}` : "";
    const header = `[${kind} from ${msg.from} #${msg.id}${reTag}]`;
    const hint = msg.expects
      ? `\n(this expects a reply — send it with: picode_send to="${msg.from}" re="${msg.id}")`
      : "";
    return `${header}\n${msg.body}${hint}`;
  }

  async function deliver(msg: Envelope, _ctx: ExtensionContext): Promise<Injection[]> {
    const parts: Injection[] = [];
    let barrierNotes: string[] = [];

    if (msg.re) {
      // A reply discharges the sender-side debt keyed by `re` (§9) — but the
      // Errata 1 gate applies to this ledger too: only a reply from the
      // picode the debt was recorded against may clear it (or resolve the
      // barriers armed over it, §12.1). A misdirected reply whose `re`
      // merely collides with someone else's obligation renders as a plain
      // note and leaves the ledger and barriers untouched.
      const obMatch = store.obligations.find(o => o.id === msg.re);
      if (!obMatch || obMatch.to === msg.from) {
        store.obligations = store.obligations.filter(o => o.id !== msg.re);
        const resolved = resolveBarriers(msg.re);
        barrierNotes = resolved.notes;
        parts.push(...resolved.payloads);
      }
    }

    if (msg.expects) {
      // Record the reply this picode now owes, durably: the envelope (and
      // its id, which the eventual reply must echo) exists only in the
      // receiving session's context — without this record, a picode revived
      // after a restart has no protocol-level way to recover the id.
      if (!store.owed.some(o => o.id === msg.id)) {
        store.owed.push({
          id: msg.id,
          from: msg.from,
          summary: msg.body.slice(0, 80),
          receivedAt: msg.sentAt,
        });
      }
    }

    const extra = barrierNotes.length ? "\n\n" + barrierNotes.join("\n") : "";
    parts.push({ text: renderEnvelope(msg) + extra, urgency: msg.urgency ?? "low" });
    await store.persist();
    return parts;
  }

  /** Ship a gathered batch: push into the heartbeat's shared array when one is
   *  given (so all sources coalesce into a single inject() per tick, §7.5),
   *  otherwise inject it now (the standalone watcher/turn/command call sites). */
  function emit(parts: Injection[], ctx: ExtensionContext, collect?: Injection[]): void {
    if (collect) collect.push(...parts);
    else inject(parts, ctx);
  }

  async function drainInbox(ctx: ExtensionContext, collect?: Injection[]): Promise<void> {
    // On Hold means "don't wake me": messages stay queued until resume.
    if (store.state === "on-hold") return;
    // §7.7 declare-and-shrink: never claim an envelope we can't deliver in
    // this same tick — while the gate is closed everything stays durable on
    // disk; watcher/turn-end/heartbeat retry.
    if (!canInject()) return;
    const messages = await store.adapter.drainInbox(store.picodeId);
    if (messages.length === 0) return;
    const parts: Injection[] = [];
    for (const msg of messages) {
      parts.push(...(await deliver(msg, ctx)));
    }
    emit(parts, ctx, collect);
    // Standalone path: inject() is synchronous (pi.sendUserMessage is queued
    // before this returns), so finalize here. Collect path: the heartbeat
    // caller finalizes after its own inject() — committing now would
    // archive messages that haven't been injected yet.
    if (!collect) await store.adapter.finalizeDrain(store.picodeId);
  }

  async function checkDeadlines(ctx: ExtensionContext, collect?: Injection[]): Promise<void> {
    if (!canInject()) return; // nudges re-arm on a later heartbeat tick
    const now = Date.now();
    const parts: Injection[] = [];
    let mutated = false;

    // Obligations: nudge once at the deadline, then expire + remove after
    // DEADLINE_EXPIRY_GRACE_MS so a forgotten request doesn't linger
    // forever. A late reply that arrives after expiry still discharges via
    // the owed-reply side; only the sender-side bookkeeping is reaped.
    const liveObligations: typeof store.obligations = [];
    for (const ob of store.obligations) {
      if (!ob.deadline) {
        liveObligations.push(ob);
        continue;
      }
      const dueAt = new Date(ob.deadline).getTime();
      if (dueAt > now) {
        liveObligations.push(ob);
        continue;
      }
      const expired = dueAt + DEADLINE_EXPIRY_GRACE_MS <= now;
      if (expired) {
        mutated = true;
        parts.push({
          text: `[obligation expired #${ob.id}]: your request to ${ob.to} ("${ob.summary}") is past its deadline by ${Math.round((now - dueAt) / 1000)}s with no reply. Dropping the obligation — if a reply still arrives, it will render as a plain note. Follow up with ${ob.to}${store.parent ? `, or escalate to ${store.parent}` : ""} if still needed.`,
          urgency: "high",
        });
        continue; // drop from liveObligations
      }
      if (!ob.nudged) {
        ob.nudged = true;
        mutated = true;
        parts.push({
          text: `[obligation overdue #${ob.id}]: your request to ${ob.to} ("${ob.summary}") passed its deadline with no reply. Follow up with ${ob.to}${store.parent ? `, or escalate to ${store.parent}` : ""}.`,
          urgency: "high",
        });
      }
      liveObligations.push(ob);
    }
    if (liveObligations.length !== store.obligations.length) store.obligations = liveObligations;

    // Barriers: same lifecycle — nudge at deadline, expire + remove after
    // the grace period. An expired barrier stops blocking the coordinator;
    // a late reply that would have resolved it still delivers as a note.
    const liveBarriers: typeof store.barriers = [];
    for (const b of store.barriers) {
      if (!b.deadline) {
        liveBarriers.push(b);
        continue;
      }
      const dueAt = new Date(b.deadline).getTime();
      if (dueAt > now) {
        liveBarriers.push(b);
        continue;
      }
      const expired = dueAt + DEADLINE_EXPIRY_GRACE_MS <= now;
      if (expired) {
        mutated = true;
        parts.push({
          text: `[barrier expired "${b.id}"]: waited on ${b.mode} of ${b.pending.length} repl${b.pending.length === 1 ? "y" : "ies"} (${b.pending.join(", ")}) past the deadline by ${Math.round((now - dueAt) / 1000)}s. Dropping the barrier — you're no longer blocked on it. If a reply still arrives, it will render as a plain note.`,
          urgency: "high",
        });
        continue; // drop from liveBarriers
      }
      if (!b.nudged) {
        b.nudged = true;
        mutated = true;
        parts.push({
          text: `[barrier overdue "${b.id}"]: still waiting on ${b.mode} of ${b.pending.length} repl${b.pending.length === 1 ? "y" : "ies"} (${b.pending.join(", ")}) — none arrived by the deadline. Check in with the target picode(s), or the barrier will keep waiting silently.`,
          urgency: "high",
        });
      }
      liveBarriers.push(b);
    }
    if (liveBarriers.length !== store.barriers.length) store.barriers = liveBarriers;

    if (parts.length === 0) return;
    if (mutated) await store.persist();
    emit(parts, ctx, collect);
  }

  return {
    sendEnvelope,
    sendToMany,
    resolveTargets,
    findMissingTargets,
    deliver,
    drainInbox,
    isTargetLive,
    checkDeadlines,
    /** Commit staged messages to processed/ — call after the heartbeat's
     *  inject() or any path that used a collect array. */
    finalizeDrain: () => store.adapter.finalizeDrain(store.picodeId),
    inject,
    canInject,
    noteCompactionStart,
    noteCompactionEnd,
    noteRunStarted,
    get onInjected() {
      return _onInjected;
    },
    set onInjected(fn: ((parts: Injection[]) => void) | undefined) {
      _onInjected = fn;
    },
    get onInject() {
      return _onInject;
    },
    set onInject(fn: ((parts: Injection[], ctx: ExtensionContext) => void) | undefined) {
      _onInject = fn;
    },
  };
}
