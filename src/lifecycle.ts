import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThreadStore, ThreadState } from "./core/types";
import type { Inbox, Injection } from "./inbox";
import { threadModelPrompt } from "./core/system-prompt";
import { journalMode, shouldJournal } from "./journal";
import { roleEmoji } from "./core/roles";
import { execSync } from "node:child_process";
import { basename } from "node:path";

/** Wiring into pi's event stream: state transitions across the turn cycle,
 *  the silent-debtor nudge, journal cadence triggers, and the thread-model
 *  system prompt. */

/** Where a thread settles between turns: On Hold must survive the turn
 *  boundary instead of being stomped to open/done (§11.1). */
function restingState(store: ThreadStore, whenFree: ThreadState): ThreadState {
  if (store.state === "on-hold") return "on-hold";
  return whenFree;
}

/** Rename this pane in herdr so the label shows role emoji + name
 *  (e.g. 🧭 coordinator). Uses $HERDR_PANE_ID — never rely on focused pane.
 *  Startup-only, so execSync is fine. Errors logged, not fatal. */
function setHerdrPaneLabel(store: ThreadStore): void {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return;
  const label = `${roleEmoji(store.role)} ${store.role ?? "worker"}`;
  try {
    execSync(`herdr pane rename "${process.env.HERDR_PANE_ID}" "${label}"`, {
      stdio: "pipe",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[thread] Failed to set herdr pane label: ${msg}`);
  }
}

/** True once this session has stamped its own thread-identity entry — the
 *  signal that lets a later launch of the *same* session stay a thread
 *  without repassing --thread-id. Mirrors the lookup in state.ts's init(). */
function hasThreadIdentity(ctx: ExtensionContext): boolean {
  try {
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type === "custom" && e.customType === "thread-identity") return true;
    }
  } catch {
    // --no-session or unreadable session — nothing to recover.
  }
  return false;
}

/** Compact token-count formatter (1.5k / 12k / 1.5M) — mirrors the
 *  built-in `formatTokens` from pi's default footer so the picode footer
 *  reads consistently with what users already know. */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** Strip CSI SGR (`ESC[...m`) sequences for width measurement. The footer
 *  only emits SGR codes (theme.fg / theme.fg error / warning), so this
 *  regex covers everything we produce. No support for OSC, cursor moves,
 *  or CJK wide-width — the footer text is short and ASCII-only. */
const ANSI_SGR = /\x1b\[[0-9;]*m/g;
function visibleWidth(s: string): number {
  return s.replace(ANSI_SGR, "").length;
}

/** ANSI-aware truncation: walks code points (so surrogate-pair emoji stay
 *  intact), preserves embedded SGR sequences, and stops once visible
 *  width hits `maxWidth - ellipsisWidth`. If the input already fits,
 *  returns it unchanged. Trailing `…` is added only when the visible
 *  content was actually cut. */
function truncateToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  const ellipsisW = visibleWidth(ellipsis);
  const targetW = Math.max(0, maxWidth - ellipsisW);
  let out = "";
  let pending = "";
  let width = 0;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const m = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        pending += m[0];
        i += m[0].length;
        continue;
      }
    }
    const code = text.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    const w = ch.length; // ASCII-only footer text; 1 code unit = 1 cell
    if (width + w > targetW) break;
    if (pending) {
      out += pending;
      pending = "";
    }
    out += ch;
    width += w;
    i += ch.length;
  }
  out += pending;
  return out + ellipsis;
}

/** Tokens-per-second for the just-completed turn.
 *
 *  `outputAtTurnStart` is the cumulative output across all assistant
 *  messages on the current branch at the moment turn_start fired;
 *  `lastAssistantOutput` is the same cumulative total at render time.
 *  Their difference is therefore the output produced by THIS turn's
 *  final assistant response (or, for a multi-step turn, the sum of all
 *  assistant outputs in the turn — acceptable since the denominator is
 *  also the full turn wall time).
 *
 *  `lastTurnStart` anchors the start; `lastMessageEndTime` is captured
 *  in the `message_end` event handler (NOT message timestamp — that is
 *  set at partial creation, ~50ms after turn_start, which inflated the
 *  old tps by 1000x).
 *
 *  Returns "" until both anchors are set AND the turn actually produced
 *  output, so a fresh session or a tool-only turn shows nothing rather
 *  than a misleading zero or negative. */
export function computeTps(
  lastTurnStart: number,
  lastMessageEndTime: number,
  outputAtTurnStart: number,
  lastAssistantOutput: number,
): string {
  if (lastTurnStart === 0 || lastMessageEndTime === 0) return "";
  const elapsedMs = lastMessageEndTime - lastTurnStart;
  if (elapsedMs <= 0) return "";
  const turnOutput = lastAssistantOutput - outputAtTurnStart;
  if (turnOutput <= 0) return "";
  const tps = turnOutput / (elapsedMs / 1000);
  if (tps <= 0) return "";
  return ` ${Math.round(tps)}t/s`;
}

export function registerLifecycle(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
  let toolUsedThisTurn = false;
  // Footer reactivity state: the factory passed to `setFooter` is invoked
  // once with the TUI handle, which we stash so the turn/thinking handlers
  // below can ask the TUI to repaint. lastTurnStart + lastMessageEndTime
  // bound the t/s window; outputAtTurnStart isolates THIS turn's output
  // from the cumulative branch total.
  let lastTurnStart = 0;
  let lastMessageEndTime = 0;
  let outputAtTurnStart = 0;
  let footerRequestRender: () => void = () => {};
  // Opt-in gate (§2.3 — participation is opt-in): this extension only turns
  // a directory into a picode workspace when explicitly asked —
  // --thread-id on this launch, or a thread-identity entry already stamped
  // into this session's own history from an earlier one. Every handler below
  // no-ops while this is false, so an unrelated session (including forked
  // children, which never inherit participation) never gets a .thread/ dir,
  // a random identity, the thread_* tools, or the thread-model system prompt.
  let active = false;

  pi.on("session_start", async (_event, ctx) => {
    const flagId = pi.getFlag("thread-id");
    active = (typeof flagId === "string" && flagId.length > 0) || hasThreadIdentity(ctx);
    if (!active) {
      // Keep the thread_* tools out of this session's active set entirely —
      // an unrelated session shouldn't see them offered, let alone have the
      // model attempt one against an uninitialized store.
      pi.setActiveTools(pi.getActiveTools().filter(name => !name.startsWith("thread_")));
      return;
    }

    try {
      await store.init(ctx.cwd, ctx);
    } catch (e) {
      if (e instanceof Error) {
        ctx.ui.notify(e.message, "error");
        ctx.shutdown();
        return;
      }
      // Non-Error throwable (string, number, etc.) — notify and shutdown
      // instead of re-throwing, which would crash pi.
      ctx.ui.notify(String(e), "error");
      ctx.shutdown();
      return;
    }

    // Coordinator must run inside herdr
    if (store.role === "coordinator" && process.env.HERDR_ENV !== "1") {
      ctx.ui.notify("Coordinator must run inside herdr (HERDR_ENV=1). Shutting down.", "error");
      ctx.shutdown();
      return;
    }



    // Set the terminal title so the role is visible in window lists and tmux
    // status bars, even when the user is not in herdr.
    ctx.ui.setTitle(
      `pi · ${roleEmoji(store.role)} ${store.role ?? "worker"} · ${basename(ctx.cwd)}`,
    );
    setHerdrPaneLabel(store);

    // Read-only roles: coordinator + read-only subtypes (reviewer, scout,
    // designer). Builder and generic worker keep full tools.
    const READ_ONLY_ROLES = new Set(["coordinator", "reviewer", "scout", "designer"]);
    if (READ_ONLY_ROLES.has(store.role)) {
      const active = pi.getActiveTools();
      const ALLOWED = new Set([
        "read",
        "bash",
        "thread_send",
        "thread_wait",
        "thread_list",
        "thread_status",
        "thread_journal",
        "thread_suspend",
        "thread_resume",
      ]);
      const filtered = active.filter(name => ALLOWED.has(name));
      pi.setActiveTools(filtered);
    }

    // Custom picode footer: two lines — cwd(branch) on top, model+thinking,
    // context usage, cumulative ↑/↓ tokens, and a live t/s readout. The
    // built-in footer is replaced because its symbols obscure what we care
    // about most in a coordinated workspace. Re-render triggers come from
    // turn_start (reset t/s clock), turn_end (tokens changed), and
    // thinking_level_select (model/thinking changed). Branch changes are
    // pushed by footerData's own subscription.
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
      footerRequestRender = () => tui.requestRender();
      return {
        invalidate() {
          // No-op: render reads fresh state on every frame.
        },
        dispose() {
          unsubBranch();
          footerRequestRender = () => {};
        },
        render(width: number): string[] {
          // Line 1: dirname (branch) — dimmed
          const dirName = basename(ctx.cwd);
          const branch = footerData.getGitBranch();
          const cwdStr = branch ? `${dirName} (${branch})` : dirName;
          const pwdLine = truncateToWidth(theme.fg("dim", cwdStr), width, theme.fg("dim", "..."));

          // Cumulative input/output from every assistant message on the
          // CURRENT BRANCH — getBranch() excludes entries on abandoned
          // forks, so stale sub-agent edits can't inflate the totals.
          // lastAssistantOutput is the cumulative total at the end of the
          // branch (i.e., the most recent assistant message's running
          // total), used by computeTps to derive THIS turn's delta.
          let input = 0;
          let output = 0;
          let lastAssistantOutput = 0;
          try {
            for (const e of ctx.sessionManager.getBranch()) {
              if (e.type === "message" && e.message.role === "assistant") {
                const m = e.message as {
                  usage: { input: number; output: number };
                  timestamp: number;
                };
                input += m.usage.input;
                output += m.usage.output;
                lastAssistantOutput = m.usage.output;
              }
            }
          } catch {
            // getBranch can throw on uninitialized session — show no
            // cumulative numbers rather than crash the footer.
          }

          // Line 2: model • thinking:L  ctx: X/Y (Z%)  ↑I ↓O  Rt/s
          const modelId = ctx.model?.id ?? "no-model";
          // getThinkingLevel lives on ExtensionAPI (pi), not ExtensionContext (ctx).
          const thinking = pi.getThinkingLevel();
          const modelPart = `${modelId} • thinking:${thinking}`;

          const usage = ctx.getContextUsage();
          const contextWindow = usage?.contextWindow ?? 0;
          const contextTokens = usage?.tokens ?? null;
          const percent = usage?.percent ?? null;
          const ctxStr =
            contextTokens === null
              ? `?/${formatTokens(contextWindow)}`
              : `${formatTokens(contextTokens)}/${formatTokens(contextWindow)} (${percent !== null ? percent.toFixed(1) : "?"}%)`;
          let ctxColored: string = ctxStr;
          if (percent !== null) {
            if (percent > 90) ctxColored = theme.fg("error", ctxStr);
            else if (percent > 70) ctxColored = theme.fg("warning", ctxStr);
          }

          const ioStr = `↑${formatTokens(input)} ↓${formatTokens(output)}`;

          // t/s = output tokens produced by the just-completed turn
          // divided by the wall-clock duration of that turn. The end
          // time is captured by the message_end handler (not message
          // .timestamp, which is set at partial creation, ~50ms after
          // turn_start — using that produced values like 430000 t/s).
          const rateStr = computeTps(
            lastTurnStart,
            lastMessageEndTime,
            outputAtTurnStart,
            lastAssistantOutput,
          );

          const statsLine = `${modelPart}  ${ctxColored}  ${ioStr}${rateStr}`;
          const statsOut = truncateToWidth(theme.fg("dim", statsLine), width, theme.fg("dim", "..."));

          return [pwdLine, statsOut];
        },
      };
    });

    // Defer initial drain to next tick — calling pi.sendUserMessage
    // synchronously from session_start deadlocks turn scheduling.
    setImmediate(() => void inbox.drainInbox(ctx));
    store.startWatcher(inbox.drainInbox, ctx);
    // The heartbeat also re-attempts the drain: it is the retry path for
    // messages the injection gate left on disk (compaction, idle preflight)
    // and for deliverAfter envelopes that have come due.
    store.startHeartbeat(async () => {
      // Coalesce both heartbeat-driven sources into ONE inject() per tick
      // (§7.5, Errata 3): if drainInbox injected on its own here, its
      // idle-time inFlightSince write would gate out the deadline check for
      // a full heartbeat interval.
      const parts: Injection[] = [];
      await inbox.drainInbox(ctx, parts);
      await inbox.checkDeadlines(ctx, parts);
      inbox.inject(parts, ctx);
      // Commit the drain's claimed/ → processed/ now that inject() has
      // safely queued the messages — if we crash after inject(), pi
      // handles its own internal queue; the adapter-level concern is the
      // file move from claimed/ to processed/.
      await inbox.finalizeDrain();
    });
  });

  // The TUI holds user input while a compaction runs; extension-initiated
  // prompts get no such guard, and one injected mid-compaction starts an
  // agent run that races the context rewrite. Mirror the TUI: hold the
  // inbox during compaction, flush as soon as it ends.
  pi.on("session_before_compact", async () => {
    if (active) inbox.noteCompactionStart();
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (!active) return;
    inbox.noteCompactionEnd();
    await inbox.drainInbox(ctx);
  });

  pi.on("session_shutdown", async event => {
    if (active) await store.shutdown(event.reason);
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!active) return;
    inbox.noteRunStarted();
    const wasOnHold = store.state === "on-hold";
    toolUsedThisTurn = false;
    // Anchor the t/s clock: footer's render() pairs lastTurnStart with
    // the matching lastMessageEndTime (captured in the message_end handler)
    // to compute tokens-per-second for this turn.
    lastTurnStart = Date.now();
    // Snapshot the cumulative output BEFORE this turn starts so render()
    // can subtract to get THIS turn's output alone (not lifetime total).
    // getBranch() keeps the tps branch-safe — stale fork messages don't
    // pollute the delta.
    outputAtTurnStart = 0;
    try {
      for (const e of ctx.sessionManager.getBranch()) {
        if (e.type === "message" && e.message.role === "assistant") {
          outputAtTurnStart += e.message.usage.output;
        }
      }
    } catch {
      // getBranch can throw on uninitialized session — fall back to 0
      // (the renderer will hide tps until a real end time lands).
    }
    footerRequestRender();
    await store.transition("thinking", ctx);
    if (wasOnHold) {
      // A prompt landing on a suspended thread is an implicit resume.
      store.holdReason = null;
      await store.persist();
      await inbox.drainInbox(ctx);
    }
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    if (!active) return;
    toolUsedThisTurn = true;
    await store.transition("working", ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!active) return;
    await store.transition(restingState(store, "open"), ctx);

    // Silent-debtor nudge (§9.4): a thread holding owed replies that ends a
    // pure-text turn instead of replying via thread_send — the classic
    // channel confusion, where the model "answers" but only the human sees
    // it. Inject a passive reminder (no turn trigger — a forced turn goads
    // the model into acting just to have something to do). Gated by
    // owedNudgePending so a long run of consecutive silent+owed turns queues
    // exactly one reminder, not one per turn; agent_end re-arms the gate so
    // a persistently silent thread still gets one fresh, escalating nudge
    // per run rather than exactly one ever. The reminder solicits the
    // "Standing by" canary — an acknowledged hold is conforming (§9.4/§9.5).
    if (toolUsedThisTurn) {
      store.owedSilentStreak = 0;
      store.owedNudgePending = false;
    } else if (store.owed.length > 0) {
      store.owedSilentStreak = Math.min(store.owedSilentStreak + 1, 3);
      if (!store.owedNudgePending) {
        store.owedNudgePending = true;
        const items = store.owed.map(o => `${o.from} (re #${o.id})`).join(", ");
        const escalation =
          store.owedSilentStreak >= 2
            ? ` This is turn ${store.owedSilentStreak} with no reply — restating it as plain text is invisible to them.`
            : "";
        pi.sendMessage(
          {
            customType: "thread-owed-reminder",
            content: `[thread-system] Automated reminder (not from the human): you still owe a reply to ${items}. Plain text reaches only the human — never them. Reply for real via thread_send with the re id.${escalation} Still working on it? Acknowledge with "Standing by". Missing information from the requester? Pass the ball: reply with what you need and expects=true.`,
            display: true,
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
      }
    }

    if (journalMode(pi) === "turn" && shouldJournal(store, toolUsedThisTurn, "turn")) {
      const sf = ctx.sessionManager.getSessionFile();
      if (sf) store.forkJournal(sf);
    }

    // The turn boundary is the documented "Open" moment — pick up anything
    // the watcher couldn't deliver while the injection gate was closed.
    await inbox.drainInbox(ctx);
    // Footer reactivity: cumulative ↑/↓ and t/s only change when an
    // assistant message has landed, which has happened by turn_end.
    footerRequestRender();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!active) return;
    await store.transition(restingState(store, "done"), ctx);
    // Re-arm the owed-reply nudge gate: each new run gets one fresh chance to
    // remind, while owedSilentStreak (untouched here) keeps climbing across
    // consecutive silent runs — that's what makes the streak>=2 escalation
    // in turn_end's guard reachable at all.
    store.owedNudgePending = false;
    const mode = journalMode(pi);
    const write =
      mode === "done"
        ? shouldJournal(store, toolUsedThisTurn, "done")
        : mode === "turn" && shouldJournal(store, toolUsedThisTurn, "run-end");
    if (write) {
      const sf = ctx.sessionManager.getSessionFile();
      if (sf) store.forkJournal(sf);
    }

    // Auto-compact if journal grew past threshold. Fire-and-forget. Only
    // at run end — not per turn — to avoid racing the normal journal writes.
    if (journalMode(pi) !== "off") {
      const sf = ctx.sessionManager.getSessionFile();
      if (sf) store.compactJournal(sf);
    }

    // Messages steered from agent_end handlers are still consumed: pi checks
    // its queues once more after these handlers settle and continues the run.
    await inbox.drainInbox(ctx);
  });

  pi.on("before_agent_start", async event => {
    if (!active) return;
    return {
      systemPrompt: event.systemPrompt + "\n\n" + threadModelPrompt(store),
    };
  });

  // Footer reactivity: thinking level appears on line 2 next to the model
  // name, so a level change must trigger a re-render. The event is
  // dispatched by pi's own UI when the user picks a new level — it does
  // NOT fire on session_start, which is why we capture the initial level
  // implicitly via pi.getThinkingLevel() inside render().
  pi.on("thinking_level_select", () => {
    if (!active) return;
    footerRequestRender();
  });

  // Footer reactivity: t/s needs the REAL end time of the most recent
  // assistant message. message.timestamp is the partial-creation time
  // (set at stream start, ~50ms after turn_start), so using it as the
  // end of the message produces wildly inflated tps. message_end fires
  // after the stream settles, so Date.now() here gives a real wall-time
  // end. We only capture for assistant messages — other roles
  // (user/toolResult) don't contribute to output tokens.
  pi.on("message_end", event => {
    if (!active) return;
    if (event.message.role === "assistant") {
      lastMessageEndTime = Date.now();
      footerRequestRender();
    }
  });
}
