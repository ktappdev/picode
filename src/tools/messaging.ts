import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Barrier, PicodeStore, Urgency } from "../core/types";
import { mintId, sameEnvelopeId } from "../core/ids";
import { deadlineFromSeconds, nowIso } from "../core/time";
import type { Inbox } from "../inbox";
import { err, quietCallRenderer, quietToolResult } from "./shared";

/** Hard upper bound on the UTF-8 byte length of a `picode_send` body.
 *  Covers the realistic upper bound for a structured reply (multiple
 *  paragraphs, fenced code blocks, file:line refs) without inviting
 *  accidental paste of a base64'd binary blob, a 1MB JSON dump, or a
 *  whole-file excerpt. Rejecting the whole message is safer than
 *  silently truncating — a partial reply is worse than no reply, and
 *  the caller can always split into multiple sends or use file refs. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Check a candidate body against MAX_BODY_BYTES. Returns the error
 *  message string when the body is too large, or null when it's OK.
 *  Pulled out of the tool executor so the rule is unit-testable without
 *  standing up pi's full ExtensionContext. */
export function checkBodySize(body: string): string | null {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_BODY_BYTES) {
    return (
      `picode_send body too large: ${bytes} bytes (limit is ${MAX_BODY_BYTES} / ${MAX_BODY_BYTES / 1024} KB). ` +
      `Split into multiple sends, or use file refs (read the file, send the path) for large content.`
    );
  }
  return null;
}

/** Shared by picode_send(wait=true) and picode_wait — arm a barrier that
 *  wakes this picode (passively, at next Open) once its envelope ids
 *  resolve. An optional message payload is injected on resolution (§12.1). */
async function armBarrier(
  store: PicodeStore,
  ids: string[],
  mode: "all" | "any",
  deadline?: string,
  message?: string,
): Promise<Barrier> {
  const barrier: Barrier = {
    id: mintId(`barrier.${store.picodeId}`),
    pending: [...ids],
    mode,
    createdAt: nowIso(),
    ...(deadline ? { deadline } : {}),
    ...(message ? { message } : {}),
  };
  store.barriers.push(barrier);
  await store.persist();
  return barrier;
}

/** Envelope messaging (PROTOCOL-FORMALISM.md §6): one send tool, one wait
 *  tool. Kind is structural — expects/re — never a type tag. */
export function registerMessagingTools(pi: ExtensionAPI, store: PicodeStore, inbox: Inbox) {
  pi.registerTool({
    name: "picode_send",
    label: "Picode Send",
    description:
      'Send a message to other picode(s). `to` accepts a picode id, a comma-separated list, `*` (all known threads), or `role:<role>` — see picode_list. Set expects=true when you need a reply (a "request" — tracked as an obligation until the reply lands). Set re=<id> to reply to a message you received (this discharges the debt). Both together = a reply that asks a follow-up. Neither = a plain note. To your parent with expects=true and urgency="high" = an escalation. urgency="interrupt" = a course correction: it preempts the receiver mid-task so it reads your new direction before its next model request. A future-dated send to your OWN id (deliverAfterSeconds) is a scheduled self-wake.',
    promptSnippet:
      'Send a message to other picode(s); expects=true for a request, re=<id> to reply, to parent+high=escalation, urgency="interrupt" to redirect a task mid-flight.',
    parameters: Type.Object({
      to: Type.String({
        description: 'Target: picode id, "a,b,c", "*", or "role:<role>".',
      }),
      body: Type.String({ description: "Message content" }),
      re: Type.Optional(
        Type.String({
          description:
            "Reply correlation: the envelope id you received (from the [#id] header or picode_status owed list). Discharges the owed reply.",
        }),
      ),
      expects: Type.Optional(
        Type.Boolean({
          description:
            "You need a reply: the receiver records an owed reply keyed by this send's id, and you get an obligation with a deadline (default 15m).",
        }),
      ),
      urgency: Type.Optional(
        Type.Union([Type.Literal("interrupt"), Type.Literal("high"), Type.Literal("low")], {
          description:
            'Delivery priority. "interrupt": a course correction — the receiver\'s tool calls that have not started yet are cancelled and it reads you before its next model request (a tool call already running still finishes). "high": steers — read at the receiver\'s next opening. "low" (default): waits until the receiver is idle.',
        }),
      ),
      deliverAfterSeconds: Type.Optional(
        Type.Number({
          description:
            "Hold the envelope until N seconds from now. To your own id, this is a scheduled self-wake.",
        }),
      ),
      expiresAfterSeconds: Type.Optional(
        Type.Number({
          description:
            'Discard the envelope undelivered if not drained within N seconds — for time-sensitive notes ("standup in 5 min") that would only confuse a receiver who wakes later.',
        }),
      ),
      deadlineSeconds: Type.Optional(
        Type.Number({
          description:
            "With expects=true: seconds until the obligation counts as overdue — you get a one-time reminder to follow up. Default: 15 minutes.",
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({
          description:
            "With expects=true: arm a barrier for the reply right after sending, so you get a passive wake-up when it lands — merges picode_wait into this call. End your turn after calling this.",
        }),
      ),
      waitMode: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("any")], {
          description:
            'With wait=true and multiple targets: wake on "all" replies (default) or the first ("any").',
        }),
      ),
    }),
    async execute(_id, params) {
      const toSpec = params.to;
      const expects = params.expects === true;

      // Size guard: reject oversized bodies BEFORE any inbox work so we
      // never persist a giant envelope to disk. The caller gets a clear
      // error with the actual size and the limit.
      const sizeError = checkBodySize(params.body);
      if (sizeError) return err(sizeError);

      const deliverAfter = params.deliverAfterSeconds
        ? new Date(Date.now() + params.deliverAfterSeconds * 1000).toISOString()
        : undefined;
      const expiresAt = params.expiresAfterSeconds
        ? new Date(Date.now() + params.expiresAfterSeconds * 1000).toISOString()
        : undefined;

      // Self-sends are only meaningful with a future delivery time (§12.2 —
      // a scheduled wake); an immediate self-send is noise.
      const selfWake = toSpec === store.picodeId && Boolean(deliverAfter);
      const targets = selfWake
        ? [store.picodeId]
        : (await inbox.resolveTargets(toSpec)).filter(t => t !== store.picodeId);
      if (targets.length === 0) {
        return err(
          toSpec === store.picodeId
            ? "Self-sends need deliverAfterSeconds (a scheduled wake) — an immediate send to yourself is a no-op."
            : `No matching targets for "${toSpec}" (self-sends are excluded).`,
        );
      }

      // Coordinator hierarchy: workers cannot send NEW requests to coordinator
      // (replies with re=<id> are allowed, even with expects=true for follow-ups)
      if (expects && !params.re) {
        const threads = await store.listPcodes();
        const coordTargets = targets.filter(t => {
          const th = threads.find(x => x.id === t);
          return th?.role === "coordinator";
        });
        if (coordTargets.length > 0 && store.role !== "coordinator") {
          return err(
            `Workers cannot direct the coordinator. Only the coordinator delegates work. ` +
              `Reply to the coordinator with re=<id>, or send a plain note instead of setting expects=true.`,
          );
        }
      }

      // Soft warnings, not hard failures: the discharge gate in the engine
      // is what actually protects the ledger. These catch likely mistakes
      // before the send goes out.
      const warnings: string[] = [];
      const reId = params.re;
      if (reId) {
        const owedMatch = store.owed.find(o => sameEnvelopeId(o.id, reId));
        if (!owedMatch) {
          warnings.push(
            `Warning: no owed reply matches re "${reId}" — check picode_status before sending, in case this reply is misdirected or stale.`,
          );
        } else if (!targets.includes(owedMatch.from)) {
          warnings.push(
            `Warning: re "${reId}" is owed to ${owedMatch.from}, not "${toSpec}" — double check the target.`,
          );
        }
      }

      // "*"/role: targets come from listPcodes and exist by construction; a
      // direct id may be a typo. Queueing is a durable dead-drop (§7.1), so
      // this is a warning, never a refusal.
      const missing = selfWake ? [] : await inbox.findMissingTargets(targets);
      const queued = selfWake
        ? []
        : (
            await Promise.all(
              targets.map(async to => ({ to, count: await store.adapter.countQueued(to) })),
            )
          ).filter(x => x.count > 0);
      for (const q of queued) {
        warnings.push(
          `Warning: "${q.to}" already has ${q.count} queued message${q.count === 1 ? "" : "s"} waiting. If this is duplicate task resend, receiver may reply to earlier envelope, leaving this send's obligation stale.`,
        );
      }

      const deadline = deadlineFromSeconds(params.deadlineSeconds);

      let sent: Awaited<ReturnType<Inbox["sendToMany"]>>;
      try {
        // sendEnvelope mints a unique id per target, so fan-out replies stay
        // individually correlatable.
        sent = await inbox.sendToMany(targets, params.body, {
          re: params.re,
          expects,
          urgency: params.urgency as Urgency | undefined,
          deliverAfter,
          expiresAt,
          deadline,
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      const lines = sent.map(
        s =>
          `Sent to ${s.to}. id=${s.id} (${s.delivered}${deliverAfter ? `, holds until ${deliverAfter}` : ""}).`,
      );
      lines.push(...warnings);
      if (missing.length) {
        lines.push(
          `(note: ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} never been seen in this workspace — the message is queued durably and delivers if a picode with that id starts. If this was a typo, check picode_list.)`,
        );
      }

      let waitNote = "";
      if (params.wait) {
        if (!expects) {
          waitNote =
            "\n(wait=true ignored — nothing expects a reply. Set expects=true if you need a tracked reply to wait on.)";
        } else {
          const barrier = await armBarrier(
            store,
            sent.map(s => s.id),
            (params.waitMode as "all" | "any") ?? "all",
            deadline,
          );
          waitNote = `\nWaiting (barrier ${barrier.id}) for ${barrier.mode} of ${barrier.pending.length} repl${barrier.pending.length === 1 ? "y" : "ies"}. You'll be woken when it resolves — end your turn now.`;
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") + waitNote }],
        details: { ok: true, sent, queued },
      };
    },
    renderCall: quietCallRenderer("picode_send"),
    renderResult: quietToolResult,
  });

  pi.registerTool({
    name: "picode_wait",
    label: "Picode Wait",
    description:
      'Wait for replies to outstanding requests (envelope ids from picode_send results / picode_status). When all (or any) of them receive a reply, you get a wake-up message — optionally with your own `message` payload injected alongside it. Non-blocking: end your turn after calling this. To undo a bad barrier (e.g. a mistyped id that will never resolve), call again with action="cancel" — ids may be barrier ids (from picode_status) or the awaited envelope ids.',
    promptSnippet:
      'Wait for replies to outstanding requests (non-blocking: end turn after calling). action="cancel" drops a barrier armed on a bad id.',
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description:
          'For action="wait": the envelope ids to wait on (from picode_send results / picode_status). For action="cancel": barrier ids (from picode_status) or awaited envelope ids.',
        minItems: 1,
      }),
      action: Type.Optional(
        Type.Union([Type.Literal("wait"), Type.Literal("cancel")], {
          description:
            '"wait" (default) arms a barrier; "cancel" drops pending barriers instead — use it when a barrier was armed on a wrong or stale id.',
        }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("any")], {
          description: 'Wake when "all" replies arrived (default) or on the first ("any")',
        }),
      ),
      deadlineSeconds: Type.Optional(
        Type.Number({
          description:
            "Seconds until this barrier counts as overdue — you get a one-time reminder if it hasn't resolved by then.",
        }),
      ),
      message: Type.Optional(
        Type.String({
          description:
            "Injected back to you when the barrier resolves — a note-to-self about what to do next.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (params.action === "cancel") {
        const lines: string[] = [];
        const matched = new Set<string>();
        const remaining: typeof store.barriers = [];
        for (const b of store.barriers) {
          if (params.ids.some(x => x === b.id)) {
            matched.add(b.id);
            for (const p of b.pending) matched.add(p);
            lines.push(`Cancelled barrier ${b.id} (was waiting on ${b.pending.join(", ")}).`);
            continue;
          }
          const pending = b.pending.filter(p => !params.ids.some(x => sameEnvelopeId(x, p)));
          if (pending.length === b.pending.length) {
            remaining.push(b);
            continue;
          }
          const dropped = b.pending.filter(p => !pending.includes(p));
          for (const p of dropped) matched.add(p);
          if (pending.length === 0) {
            lines.push(`Cancelled barrier ${b.id} — nothing left to wait for.`);
          } else {
            lines.push(
              `Removed ${dropped.join(", ")} from barrier ${b.id} — still waiting on ${b.mode} of ${pending.length}: ${pending.join(", ")}.`,
            );
            remaining.push({ ...b, pending });
          }
        }
        const notFound = params.ids.filter(x => !matched.has(x));
        if (notFound.length) {
          lines.push(
            `No barrier was waiting on ${notFound.join(", ")} — nothing to cancel for ${notFound.length === 1 ? "it" : "them"} (picode_status lists barrier ids and what they await).`,
          );
        }
        store.barriers = remaining;
        await store.persist();
        return {
          content: [
            {
              type: "text" as const,
              text: lines.length ? lines.join("\n") : "No barriers are armed — nothing to cancel.",
            },
          ],
          details: { ok: true, barriers: store.barriers },
        };
      }

      const isOpen = (id: string) => store.obligations.some(o => sameEnvelopeId(o.id, id));
      const answered = params.ids.filter(
        id => !isOpen(id) && store.settled.some(s => sameEnvelopeId(s.id, id)),
      );
      const unknown = params.ids.filter(
        id => !isOpen(id) && !store.settled.some(s => sameEnvelopeId(s.id, id)),
      );
      const deadline = deadlineFromSeconds(params.deadlineSeconds);
      const barrier = await armBarrier(
        store,
        params.ids,
        (params.mode as "all" | "any") ?? "all",
        deadline,
        params.message,
      );
      const warn: string[] = [];
      if (answered.length) {
        const stamped = answered.map(id => {
          const s = store.settled.find(x => sameEnvelopeId(x.id, id));
          return s ? `${id} (at ${s.settledAt})` : id;
        });
        warn.push(
          `\nWarning: a reply for ${stamped.join(", ")} already arrived — it is already in (or arriving to) your context; do NOT re-arm on ${answered.length === 1 ? "it" : "them"}. This barrier resolves only if ANOTHER reply echoes that id — end your turn to read the reply, or drop ${answered.length === 1 ? "it" : "them"} with picode_wait action="cancel".`,
        );
      }
      if (unknown.length) {
        warn.push(
          `\nWarning: no open obligation matches ${unknown.join(", ")} — ${unknown.length === 1 ? "it" : "they"} may be mistyped, or that send never set expects=true (a plain note gets no tracked reply). If no reply ever carries ${unknown.length === 1 ? "it" : "them"}, the barrier never resolves — fix the id, or cancel with picode_wait action="cancel".`,
        );
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Barrier ${barrier.id} armed: waiting for ${barrier.mode} of ${barrier.pending.length} replies. You'll be woken when it resolves.${warn.join("")}`,
          },
        ],
        details: { ok: true, barrier },
      };
    },
    renderCall: quietCallRenderer("picode_wait"),
    renderResult: quietToolResult,
  });
}
