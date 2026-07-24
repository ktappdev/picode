import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PicodeStore, PicodeState } from "./core/types";
import type { Inbox, Injection } from "./inbox";
import { threadModelPrompt } from "./core/system-prompt";
import { journalMode, shouldJournal } from "./journal";
import { roleEmoji } from "./core/roles";
import { purgeStalePcodes } from "./tools/purge";
import { startHerdrListener } from "./herdr/listener";
import { execSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Wiring into pi's event stream: state transitions across the turn cycle,
 *  the silent-debtor nudge, journal cadence triggers, and the picode-model
 *  system prompt. */

/** Where a picode settles between turns: On Hold must survive the turn
 *  boundary instead of being stomped to open/done (§11.1). */
function restingState(store: PicodeStore, whenFree: PicodeState): PicodeState {
  if (store.state === "on-hold") return "on-hold";
  return whenFree;
}

/** Rename this pane in herdr so the label shows role emoji + name
 *  (e.g. 🧭 coordinator). Uses $HERDR_PANE_ID — never rely on focused pane.
 *  Startup-only, so execSync is fine. Errors logged, not fatal. */
function setHerdrPaneLabel(store: PicodeStore): void {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return;
  const label = `${roleEmoji(store.role)} ${store.role ?? "worker"}`;
  try {
    execSync(`herdr pane rename "${process.env.HERDR_PANE_ID}" "${label}"`, {
      stdio: "pipe",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[picode] Failed to set herdr pane label: ${msg}`);
  }
}

/** True once this session has stamped its own picode-identity entry — the
 *  signal that lets a later launch of the *same* session stay a picode
 *  without repassing --picode-id. Mirrors the lookup in state.ts's init().
 *
 *  Forked sessions are excluded: `--fork` copies all entries (including
 *  picode-identity) into a new session with a `parentSession` header. Without
 *  this guard, a journal fork would inherit the coordinator's identity,
 *  activate, persist state over the real picode, and fork another journal —
 *  the ghost-chain bug. A fork is never the same picode, even if it carries
 *  the identity entry. */
function hasThreadIdentity(ctx: ExtensionContext): boolean {
  try {
    // A forked session (header.parentSession set) is never a picode, even if
    // it inherited a picode-identity entry from the source session.
    const header = ctx.sessionManager.getHeader();
    if (header?.parentSession) return false;
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type === "custom" && e.customType === "picode-identity") return true;
    }
  } catch {
    // --no-session or unreadable session — nothing to recover.
  }
  return false;
}

/** Strip the rendered-envelope header/hint/barrier wrapper to recover the
 *  raw message body. `renderEnvelope` produces `${header}\n${body}${hint}`
 *  and `deliver` may append `\n\n[barrier …]` notes after it.
 *  Falls back to the full string if no header newline is found. */
function extractBodyFromRendered(rendered: string): string {
  const nl = rendered.indexOf("\n");
  if (nl === -1) return rendered;
  let body = rendered.slice(nl + 1);
  const hint = body.indexOf("\n(this expects");
  if (hint !== -1) body = body.slice(0, hint);
  const barrier = body.indexOf("\n\n[barrier");
  if (barrier !== -1) body = body.slice(0, barrier);
  return body;
}

/** First non-empty line of a task body, with leading markdown noise
 *  (`#` headers, `**` bold wrappers) stripped. Falls back to the first
 *  80 chars of the raw body when every line strips to empty. */
export function extractFirstLine(body: string): string {
  if (!body) return "";
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cleaned = trimmed
      .replace(/^#+\s*/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (cleaned) return cleaned.slice(0, 80);
  }
  return body.slice(0, 80);
}

export function registerLifecycle(pi: ExtensionAPI, store: PicodeStore, inbox: Inbox) {
  let toolUsedThisTurn = false;
  // Opt-in gate (§2.3 — participation is opt-in): this extension only turns
  // a directory into a picode workspace when explicitly asked —
  // --picode-id on this launch, or a picode-identity entry already stamped
  // into this session's own history from an earlier one. Every handler below
  // no-ops while this is false, so an unrelated session (including forked
  // children, which never inherit participation) never gets a .picode/ dir,
  // a random identity, the picode_* tools, or the picode-model system prompt.
  let active = false;
  let stopHerdrListener: (() => void) | null = null;

  pi.on("session_start", async (_event, ctx) => {
    // Export bundled themes dir so worker spawn commands can resolve
    // --theme <name> to an absolute file path (pi treats --theme as a
    // file path, not a name). In ESM, __dirname doesn't exist — derive
    // it from import.meta.url. At runtime this is dist/lifecycle.js, so
    // dirname is dist/ and ../themes points to the project-root themes/.
    const themesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "themes");
    process.env.PICODE_THEMES_DIR = themesDir;

    const flagId = pi.getFlag("picode-id");
    const picodeShorthand = pi.getFlag("picode");
    // --picode (boolean) defaults to coordinator when no --picode-id given
    const resolvedId =
      typeof flagId === "string" && flagId.length > 0
        ? flagId
        : picodeShorthand === true
          ? "coordinator"
          : undefined;
    active = typeof resolvedId === "string" || hasThreadIdentity(ctx);
    if (!active) {
      // Keep the picode_* tools out of this session's active set entirely —
      // an unrelated session shouldn't see them offered, let alone have the
      // model attempt one against an uninitialized store.
      pi.setActiveTools(pi.getActiveTools().filter(name => !name.startsWith("picode_")));
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

    // Start Herdr real-time event listener for coordinators. Events are
    // pushed into the session as [picode-system] messages so the coordinator
    // learns about pane closes/exits and agent status changes without polling.
    if (
      store.role === "coordinator" &&
      process.env.HERDR_ENV === "1" &&
      process.env.HERDR_WORKSPACE_ID
    ) {
      stopHerdrListener = startHerdrListener(pi, process.env.HERDR_WORKSPACE_ID);
    }

    // Auto-purge stale picode data on coordinator startup (fire-and-forget)
    if (store.role === "coordinator") {
      try {
        const root = execSync("git rev-parse --show-toplevel", {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const result = purgeStalePcodes(root, store.picodeId, false);
        if (result.count > 0) {
          ctx.ui.notify(`Auto-purged ${result.count} stale picode(s) on startup`, "info");
        }
      } catch {
        // Non-fatal — git not available or purge failed
      }
    }

    // Current-task widget: workers only (§ — coordinator routes, doesn't
    // have a single task). Use onInject hook so every drained envelope
    // updates the widget with the first line of the most recent request body.
    if (store.role !== "coordinator") {
      inbox.onInject = (parts: Injection[], injectCtx: ExtensionContext) => {
        const taskParts = parts.filter(p => /^\[(request|reply\+request) from /.test(p.text));
        if (taskParts.length > 0) {
          const lastTask = taskParts[taskParts.length - 1];
          const body = extractBodyFromRendered(lastTask.text);
          const firstLine = extractFirstLine(body);
          const ui = injectCtx.ui as unknown as Record<string, unknown>;
          if (typeof ui.setWidget === "function") {
            ui.setWidget("current-task", ["🎯 " + firstLine], { placement: "aboveEditor" });
          }
        }
      };
    }

    // Set the terminal title so the role is visible in window lists and tmux
    // status bars, even when the user is not in herdr.
    ctx.ui.setTitle(
      `pi · ${roleEmoji(store.role)} ${store.role ?? "worker"} · ${basename(ctx.cwd)}`,
    );
    setHerdrPaneLabel(store);

    // Read-only roles: coordinator + read-only subtypes (reviewer, scout,
    // designer). Builder and generic worker keep full tools.
    const READ_ONLY_ROLES = new Set([
      "coordinator",
      "reviewer",
      "scout",
      "designer",
      "bug-hunter",
      "planner",
    ]);
    if (READ_ONLY_ROLES.has(store.role)) {
      // Denylist, not allowlist: read-only roles keep every registered tool
      // except write/edit. This lets extension tools (todo, grep, find, ls,
      // code_search, future extensions) stay active without a hardcoded
      // allowlist that drifts from what's actually registered.
      const DENIED = new Set(["write", "edit", "bash"]);
      const filtered = pi.getActiveTools().filter(name => !DENIED.has(name));
      pi.setActiveTools(filtered);
    }

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
    if (stopHerdrListener) {
      stopHerdrListener();
      stopHerdrListener = null;
    }
    if (active) await store.shutdown(event.reason);
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!active) return;
    inbox.noteRunStarted();
    const wasOnHold = store.state === "on-hold";
    toolUsedThisTurn = false;
    await store.transition("thinking", ctx);
    if (wasOnHold) {
      // A prompt landing on a suspended picode is an implicit resume.
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

    // Silent-debtor nudge (§9.4): a picode holding owed replies that ends a
    // pure-text turn instead of replying via picode_send — the classic
    // channel confusion, where the model "answers" but only the human sees
    // it. Inject a passive reminder (no turn trigger — a forced turn goads
    // the model into acting just to have something to do). Gated by
    // owedNudgePending so a long run of consecutive silent+owed turns queues
    // exactly one reminder, not one per turn; agent_end re-arms the gate so
    // a persistently silent picode still gets one fresh, escalating nudge
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
            customType: "picode-owed-reminder",
            content: `[picode-system] Automated reminder (not from the human): you still owe a reply to ${items}. Plain text reaches only the human — never them. Reply for real via picode_send with the re id.${escalation} Still working on it? Acknowledge with "Standing by". Missing information from the requester? Pass the ball: reply with what you need and expects=true.`,
            display: true,
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
      }
    }

    if (
      journalMode(pi, path.join(ctx.cwd, ".picode", "models.json")) === "turn" &&
      shouldJournal(store, toolUsedThisTurn, "turn")
    ) {
      const sf = ctx.sessionManager.getSessionFile();
      if (sf) store.forkJournal(sf);
    }

    // The turn boundary is the documented "Open" moment — pick up anything
    // the watcher couldn't deliver while the injection gate was closed.
    await inbox.drainInbox(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!active) return;
    await store.transition(restingState(store, "done"), ctx);
    // Re-arm the owed-reply nudge gate: each new run gets one fresh chance to
    // remind, while owedSilentStreak (untouched here) keeps climbing across
    // consecutive silent runs — that's what makes the streak>=2 escalation
    // in turn_end's guard reachable at all.
    store.owedNudgePending = false;
    const mode = journalMode(pi, path.join(ctx.cwd, ".picode", "models.json"));
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
    if (journalMode(pi, path.join(ctx.cwd, ".picode", "models.json")) !== "off") {
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
}
