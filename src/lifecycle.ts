import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { PicodeStore, PicodeState } from "./core/types";
import type { Inbox, Injection } from "./inbox";
import { splitPicodeRoster, threadModelPrompt } from "./core/system-prompt";
import { formatWorkerDigest, recentWorkers } from "./core/worker-ledger";
import { registerCacheDiagnostics } from "./cache-diagnostics";
import {
  journalMode,
  shouldJournal,
  buildJournalPrompt,
  splitJournalEntries,
  JOURNAL_CONTEXT_MAX_MESSAGES,
} from "./journal";
import {
  advanceSitrep,
  initialSitrepStreak,
  resolveSitrepMaxIdle,
  sitrepSignature,
} from "./core/sitrep";
import { roleEmoji } from "./core/roles";
import { modelsConfigPaths } from "./core/model-config";
import { resolveQuietTui, setQuietTui } from "./core/quiet-tui";
import { purgeStalePcodes, referencedPicodeIds } from "./tools/purge";
import { saveRecallParticipant } from "./core/recall-registry";
import { isProtectedTabLabel, tabLabelMap } from "./tools/shared";
import { nowIso } from "./core/time";
import {
  startHerdrListener,
  setListenerHandle,
  getTrackedPaneCount,
  type HerdrListenerHandle,
} from "./herdr/listener";
import { execSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function hasSystemPromptSections(
  options: BuildSystemPromptOptions,
): options is BuildSystemPromptOptions & { sections: Record<string, string> } {
  if (!("sections" in options)) return false;
  const sections = options.sections;
  if (typeof sections !== "object" || sections === null || Array.isArray(sections)) return false;
  return Object.values(sections).every(section => typeof section === "string");
}

/** Default interval for periodic coordinator sit-rep injections (ms).
 *  Every N minutes, if the coordinator is idle and has tracked panes,
 *  inject a sit-rep prompt so it checks worker health and stale barriers.
 *  Override with PICODE_SITREP_INTERVAL_MS env var. */
export const SITREP_INTERVAL_MS_DEFAULT = 600_000; // 10 min

/** Resolved at arming time, not module load: env read at import time makes the
 *  policy untestable (and a shell-exported override silently rewrites it for
 *  every test that imports this file). */
function sitRepIntervalMs(): number {
  return Number(process.env.PICODE_SITREP_INTERVAL_MS) || SITREP_INTERVAL_MS_DEFAULT;
}

/** Consecutive unchanged checks tolerated before the timer stops itself —
 *  see core/sitrep.ts for the policy. 0 = poll forever. */
function sitRepMaxIdle(): number {
  return resolveSitrepMaxIdle(process.env.PICODE_SITREP_MAX_IDLE);
}

/** How long after injecting a sit-rep the run still counts as "ours" for
 *  journal suppression. Bounds the blast radius of a sit-rep whose turn never
 *  ran: it must not silence the journal for an unrelated later run. */
const SITREP_RUN_WINDOW_MS = 120_000;

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
function setHerdrPaneLabel(store: PicodeStore, isRoundTable = false): void {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return;
  const label = isRoundTable
    ? `🗣️ Round Table · ${store.picodeId}`
    : `${roleEmoji(store.role)} ${store.role ?? "worker"}`;
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

/** First non-empty content line of a task body, with leading markdown noise
 *  (`**` bold wrappers) stripped. Markdown headings (`#`, `##`, etc.) are
 *  skipped — they're structural, not content. Falls back to the first
 *  80 chars of the raw body when every line strips to empty. */
export function extractFirstLine(body: string): string {
  if (!body) return "";
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip markdown headings — they're structural, not the task description
    if (/^#+\s/.test(trimmed)) continue;
    const cleaned = trimmed.replace(/\*\*/g, "").trim();
    if (cleaned) return cleaned.slice(0, 80);
  }
  return body.slice(0, 80);
}

export function registerLifecycle(pi: ExtensionAPI, store: PicodeStore, inbox: Inbox) {
  let toolUsedThisTurn = false;
  // True from the first operator prompt of a run until agent_end settles the
  // journal decision. Drives shouldJournal's "done" phase — see journal.ts.
  let userPromptThisRun = false;
  // Message entries already covered by a journal fork this session. The next
  // fork summarizes only what came after, capped to the most recent
  // JOURNAL_CONTEXT_MAX_MESSAGES — journal cost stays O(recent run), never
  // O(session).
  let journaledMessageCount = 0;
  // Opt-in gate (§2.3 — participation is opt-in): this extension only turns
  // a directory into a picode workspace when explicitly asked —
  // --picode-id on this launch, or a picode-identity entry already stamped
  // into this session's own history from an earlier one. Every handler below
  // no-ops while this is false, so an unrelated session (including forked
  // children, which never inherit participation) never gets a .picode/ dir,
  // a random identity, the picode_* tools, or the picode-model system prompt.
  let active = false;
  let isRoundTable = false;
  let stopHerdrListener: HerdrListenerHandle | null = null;
  let sitRepTimer: NodeJS.Timeout | null = null;
  const cacheDiagnostics = registerCacheDiagnostics(pi, store, () => active);

  // --- Periodic sit-rep, bounded (core/sitrep.ts) -------------------------
  // Armed only for a coordinator running inside herdr. The timer stops itself
  // once consecutive checks stop finding news, and restarts on real activity.
  let sitRepEligible = false;
  let sitRepCtx: ExtensionContext | null = null;
  let sitRepStreak = initialSitrepStreak();
  // Set while a sit-rep run is in flight so the journal can tell a no-op check
  // apart from real work and skip its forked model call (see
  // sitRepRunChangedNothing).
  let sitRepRunAt = 0;
  let sitRepRunSignature: string | null = null;

  /** The picture a sit-rep inspects, right now. */
  function currentSitrepSignature(): string {
    return sitrepSignature({
      trackedPanes: getTrackedPaneCount(),
      obligations: store.obligations.map(o => o.id),
      barriers: store.barriers.map(b => b.id),
      owed: store.owed.map(o => o.id),
    });
  }

  /** True when this run was started by the sit-rep timer and nothing
   *  structural has moved since it injected. A check that found nothing must
   *  not also pay for a forked journal entry — that would be a second model
   *  call for the same no-op. */
  function sitRepRunChangedNothing(): boolean {
    return (
      sitRepRunSignature !== null &&
      Date.now() - sitRepRunAt < SITREP_RUN_WINDOW_MS &&
      sitRepRunSignature === currentSitrepSignature()
    );
  }

  function stopSitRepTimer(): void {
    if (sitRepTimer) clearInterval(sitRepTimer);
    sitRepTimer = null;
  }

  /** Real activity: the next check gets a fresh baseline, and a timer that
   *  paused itself starts checking again. Deliberately NOT called for the
   *  sit-rep's own injection — that would reset the very cap it enforces. */
  function notePicodeActivity(): void {
    sitRepStreak = initialSitrepStreak();
    sitRepRunSignature = null;
    if (sitRepEligible && sitRepCtx && !sitRepTimer) armSitRepTimer(sitRepCtx);
  }

  /** (Re)start the sit-rep interval against this session's context. */
  function armSitRepTimer(ctx: ExtensionContext): void {
    stopSitRepTimer();
    sitRepCtx = ctx;
    sitRepTimer = setInterval(() => {
      // Skip if coordinator is actively working or thinking
      if (store.state === "thinking" || store.state === "working" || store.state === "on-hold") {
        return;
      }
      // Skip if compaction is in progress — injection would race context rewrite
      if (!inbox.canInject()) {
        return;
      }
      // Skip if no tracked panes — nothing to sit-rep about
      if (getTrackedPaneCount() === 0) {
        return;
      }

      const signature = currentSitrepSignature();
      const maxIdle = sitRepMaxIdle();
      const { streak, decision } = advanceSitrep(sitRepStreak, signature, maxIdle);
      sitRepStreak = streak;

      // Nothing has changed for maxIdle checks in a row: stop waking the model
      // over an unchanged picture. The session stays alive and silent — the
      // next operator message or delivered envelope re-arms the timer via
      // notePicodeActivity. `maxIdle === 0` never pauses.
      if (decision === "pause") {
        stopSitRepTimer();
        ctx.ui.notify(
          `Sit-rep paused: ${maxIdle} checks in a row found no changes. No further checks until you send a message or picode traffic arrives.`,
          "info",
        );
        return;
      }

      sitRepRunAt = Date.now();
      sitRepRunSignature = signature;

      // Inject sit-rep as followUp (non-interrupting — waits for current
      // turn). Collapsed picode-system message once a prompt()-driven run
      // has assembled the picode system prompt; until then the verbose
      // sendUserMessage fallback keeps that first run correct.
      const sitrep =
        "[picode-system] Periodic sit-rep: run picode_panes() and picode_status(tail=5). Check for: (1) zombie workers — working but no recent activity, (2) stale barriers — expired deadlines, (3) idle workers that could be reused or closed. Act on findings — close zombies, purge stale barriers, reassign idle workers. Don't just report.";
      if (store.promptDrivenTurnSeen) {
        pi.sendMessage(
          { customType: "picode-system", content: sitrep, display: true, details: {} },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } else {
        pi.sendUserMessage(sitrep, { deliverAs: "followUp" });
      }
    }, sitRepIntervalMs());
  }

  // Targeted guard: upstream extensions (e.g. pi-windsurf) can throw
  // ERR_INVALID_STATE when cancelling a locked ReadableStream on idle
  // timeout. The error escapes as an uncaughtException because the
  // cancel() Promise rejection isn't awaited. Pi has no global handler,
  // so the process dies. Catch only this specific error — let everything
  // else crash normally so real bugs surface.
  const streamGuard = (err: Error) => {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ERR_INVALID_STATE" &&
      /ReadableStream|cancel/i.test(err.message)
    ) {
      console.error(
        `[picode] Suppressed upstream stream error (likely pi-windsurf idle timeout): ${err.message}`,
      );
      return;
    }
    // Re-throw — not ours to handle
    throw err;
  };
  process.on("uncaughtException", streamGuard);

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
    isRoundTable = pi.getFlag("picode-round-table") === true;
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
      const PICODE_TOOLS = new Set([
        "picode_send",
        "picode_wait",
        "picode_status",
        "picode_list",
        "picode_journal",
        "picode_suspend",
        "picode_resume",
        "picode_purge",
        "picode_panes",
        "picode_pane_read",
        "spawn_worker",
        "cleanup_panes",
        "picode_run",
        "picode_tab_create",
        "picode_tab_close",
        "picode_round_table",
        "picode_round_table_reply",
        "picode_finish",
        "revive_closed_session",
      ]);
      pi.setActiveTools(pi.getActiveTools().filter(name => !PICODE_TOOLS.has(name)));
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

    // Operator quiet screen: resolve the display-only preference now that cwd
    // is known — render callbacks get no ctx, so they read this module flag
    // (refreshed again by /picode-quiet).
    setQuietTui(resolveQuietTui(ctx.cwd).value);

    if (!isRoundTable && store.role !== "coordinator" && store.sessionFile) {
      saveRecallParticipant(ctx.cwd, {
        id: store.picodeId,
        role: store.role,
        sessionFile: store.sessionFile,
        cwd: ctx.cwd,
        updatedAt: nowIso(),
      });
    }

    // A new session's agent starts from the base system prompt; the picode
    // thread-model block is only assembled per prompt()-driven run (see the
    // before_agent_start handler below). The journal slice marker resets too
    // — a fresh session's entries must not be skipped by the old session's
    // count.
    store.promptDrivenTurnSeen = false;
    cacheDiagnostics.reset();
    journaledMessageCount = 0;

    // Coordinator must run inside herdr
    if (store.role === "coordinator" && process.env.HERDR_ENV !== "1") {
      ctx.ui.notify("Coordinator must run inside herdr (HERDR_ENV=1). Shutting down.", "error");
      ctx.shutdown();
      return;
    }

    // Clean up stale worker panes BEFORE starting the event listener,
    // so their close events don't flood the coordinator on startup.
    if (
      store.role === "coordinator" &&
      process.env.HERDR_ENV === "1" &&
      process.env.HERDR_WORKSPACE_ID
    ) {
      try {
        // List panes and close stale workers synchronously
        const listRaw = execSync(`herdr api snapshot`, {
          encoding: "utf-8",
          timeout: 10_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const snap = JSON.parse(listRaw).result?.snapshot;
        const panes = snap?.panes || [];
        const ws = process.env.HERDR_WORKSPACE_ID;
        const myPane = process.env.HERDR_PANE_ID;
        // User-owned tabs (e.g. "don't close — frontend") are off-limits:
        // never close their panes during startup cleanup.
        const tabLabels = tabLabelMap(snap?.tabs);
        for (const p of panes) {
          if (p.workspace_id !== ws) continue;
          if (p.pane_id === myPane) continue;
          if (isProtectedTabLabel(tabLabels.get(p.tab_id as string) || "")) continue;
          const status = p.agent_status;
          if (status === "working" || status === "idle") continue;
          try {
            execSync(`herdr pane close ${p.pane_id}`, { stdio: "pipe", timeout: 5_000 });
          } catch {
            // Non-fatal — pane may already be gone
          }
        }
      } catch {
        // Non-fatal — snapshot or close failed
      }
    }

    // Start Herdr real-time event listener AFTER stale cleanup so close
    // events from dead panes don't flood the coordinator.
    if (
      store.role === "coordinator" &&
      process.env.HERDR_ENV === "1" &&
      process.env.HERDR_WORKSPACE_ID
    ) {
      stopHerdrListener = startHerdrListener(pi, process.env.HERDR_WORKSPACE_ID);
      setListenerHandle(stopHerdrListener);

      // Start periodic sit-rep timer — wakes the coordinator to check worker
      // health and stale barriers. Only fires when the coordinator is idle
      // (done/open state), not during active work, compaction, or suspend. A
      // delivered envelope is real activity: it restarts a paused timer.
      sitRepEligible = true;
      inbox.onInjected = () => notePicodeActivity();
      armSitRepTimer(ctx);
    }

    // Auto-purge stale picode data on coordinator startup (fire-and-forget)
    if (store.role === "coordinator") {
      try {
        const root = execSync("git rev-parse --show-toplevel", {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const result = purgeStalePcodes(root, store.picodeId, false, referencedPicodeIds(store));
        if (result.count > 0) {
          ctx.ui.notify(`Auto-purged ${result.count} stale picode(s) on startup`, "info");
        }
      } catch {
        // Non-fatal — git not available or purge failed
      }
    }

    // Startup resume context (coordinator only): append project context
    // without waking the model. The journal is the coordinator's memory —
    // inject the last entries plus outstanding coordination state so the next
    // operator prompt can re-orient without having to remember to call
    // picode_status. Workers stay cold — their context is the task envelope.
    if (store.role === "coordinator") {
      const parts: string[] = [];
      const journal = await store.readJournal(store.picodeId);
      if (journal) {
        const entries = journal.split(/\n(?=<!--)/).filter(Boolean);
        const recent = entries.slice(-5).join("\n");
        parts.push(`[picode-system] Startup resume — your last journal entries:\n${recent}`);
      }
      if (store.obligations.length) {
        parts.push(
          `[picode-system] Outstanding obligations: ${store.obligations.map(o => o.id).join(", ")}`,
        );
      }
      if (store.owed.length) {
        parts.push(`[picode-system] Owed replies: ${store.owed.map(o => o.id).join(", ")}`);
      }
      if (store.barriers.length) {
        parts.push(`[picode-system] Active barriers: ${store.barriers.map(b => b.id).join(", ")}`);
      }
      if (parts.length) {
        parts.push(
          "[picode-system] Reading the entries above: they are chronological — the LAST entry is the current state, earlier entries are history. Never re-ask the user about a decision, question, or request that a later entry shows was answered, resolved, or dropped. If the last entry lists something open, verify it is still true before acting on it or asking the user. If an open item is a question awaiting the user's answer, surface it in ONE short line — the user has already seen the details; do not re-present analysis, evidence, or decision menus, and do not re-run orientation tool calls to re-derive them. If the user's reply resolves or drops anything, say so plainly in your response so the journal entry records the closure.",
        );
      }
      if (parts.length) {
        setImmediate(() => {
          // The full resume context (journal, obligations, owed, barriers)
          // rides as a collapsed picode-system message appended to context
          // without triggering a turn. The next operator prompt supplies the
          // turn that re-orients the coordinator.
          pi.sendMessage(
            {
              customType: "picode-system",
              content: parts.join("\n\n"),
              display: true,
              details: {},
            },
            { triggerTurn: false },
          );
        });
      }
    }

    // Current-task widget: workers only (§ — coordinator routes, doesn't
    // have a single task). Use onInject hook so every drained envelope
    // updates the widget with the first line of the most recent request body.
    if (!isRoundTable && store.role !== "coordinator") {
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
    const titleRole = isRoundTable
      ? `🗣️ Round Table · ${store.picodeId}`
      : `${roleEmoji(store.role)} ${store.role ?? "worker"}`;
    ctx.ui.setTitle(`pi · ${titleRole} · ${basename(ctx.cwd)}`);
    setHerdrPaneLabel(store, isRoundTable);

    // Read-only roles keep inspection tools but cannot modify files. Runner
    // still needs bash for long-lived processes; coordinator does not.
    const READ_ONLY_ROLES = new Set([
      "coordinator",
      "reviewer",
      "scout",
      "bug-hunter",
      "planner",
      "runner",
      "visionary",
    ]);
    if (isRoundTable) {
      pi.setActiveTools(["picode_round_table_reply"]);
    } else if (READ_ONLY_ROLES.has(store.role)) {
      const DENIED = new Set(["write", "edit", "picode_run"]);
      if (store.role === "coordinator") DENIED.add("bash");
      const filtered = pi.getActiveTools().filter(name => !DENIED.has(name));
      pi.setActiveTools(filtered);
    }
    // Journaling is coordinator-only: hide picode_journal from workers so they
    // are never tempted to spend a tool call reading a journal that (a) is
    // always empty for them and (b) they are not supposed to use. picode_status
    // stays — it is the worker's own-state recovery path (owed replies).
    if (!isRoundTable && store.role !== "coordinator") {
      const filtered = pi.getActiveTools().filter(name => name !== "picode_journal");
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
    stopSitRepTimer();
    sitRepEligible = false;
    sitRepCtx = null;
    process.off("uncaughtException", streamGuard);
    if (stopHerdrListener) {
      stopHerdrListener.stop();
      stopHerdrListener = null;
      setListenerHandle(null);
    }
    if (active) await store.shutdown(event.reason);
  });

  // Build the bounded journal prompt — the messages since the last fork,
  // capped to the most recent JOURNAL_CONTEXT_MAX_MESSAGES — and fire the
  // print-mode fork. No session access or no new messages → nothing to
  // summarize, no model call.
  const forkJournalFor = async (ctx: ExtensionContext): Promise<void> => {
    let entries: unknown[] = [];
    try {
      entries = ctx.sessionManager.getEntries();
    } catch {
      return;
    }
    if (!Array.isArray(entries)) return;
    const messages = entries
      .map(e =>
        (e as { type?: string; message?: unknown }).type === "message"
          ? (e as { message?: unknown }).message
          : undefined,
      )
      .filter(
        (m): m is { role: string; [key: string]: unknown } =>
          !!m && typeof (m as { role?: unknown }).role === "string",
      );
    const start = Math.max(journaledMessageCount, messages.length - JOURNAL_CONTEXT_MAX_MESSAGES);
    const slice = messages.slice(start);
    journaledMessageCount = messages.length;
    if (slice.length === 0) return;
    let previousEntry: string | undefined;
    try {
      const journal = await store.readJournal(store.picodeId);
      previousEntry = journal ? splitJournalEntries(journal).at(-1) : undefined;
    } catch {
      // Continuity anchor is best-effort.
    }
    // Without a pinned journal model, fork on the session's own last model —
    // it just ran, so it resolves on this machine by construction.
    let fallbackModel: string | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const m = (entries[i] as { message?: { role?: string; provider?: string; model?: string } })
        .message;
      if (m?.role === "assistant" && m.provider && m.model) {
        fallbackModel = `${m.provider}/${m.model}`;
        break;
      }
    }
    store.forkJournal(buildJournalPrompt(slice, previousEntry), fallbackModel);
  };

  pi.on("input", async event => {
    if (!active) return;
    // Extension-sourced input is picode's own machinery (envelope injections,
    // system prompts) — the "did the operator speak" signal is for humans and
    // RPC clients only.
    if (event.source !== "extension") {
      userPromptThisRun = true;
      // The operator is back: give an idle or self-paused sit-rep timer a
      // fresh baseline and let it check again.
      notePicodeActivity();
    }
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
        // triggerTurn:false with no deliverAs appends the reminder passively:
        // it lands in context for the next turn without forcing one. It must
        // NOT use deliverAs:"nextTurn" — that queue is only flushed by
        // prompt()-driven turns, and a coordinator woken solely by envelope
        // injections never runs one, so the reminder would starve forever.
        pi.sendMessage(
          {
            customType: "picode-owed-reminder",
            content: `[picode-system] Automated reminder (not from the human): you still owe a reply to ${items}. Plain text reaches only the human — never them. Reply for real via picode_send with the re id.${escalation} Still working on it? Acknowledge with "Standing by". Missing information from the requester? Pass the ball: reply with what you need and expects=true.`,
            display: true,
          },
          { triggerTurn: false },
        );
      }
    }

    const modelPaths = modelsConfigPaths(ctx.cwd);
    if (
      !sitRepRunChangedNothing() &&
      !isRoundTable &&
      journalMode(pi, modelPaths.project, store.role, modelPaths.global) === "turn" &&
      shouldJournal(store, toolUsedThisTurn, "turn")
    ) {
      await forkJournalFor(ctx);
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
    const modelPaths = modelsConfigPaths(ctx.cwd);
    const mode = isRoundTable
      ? "off"
      : journalMode(pi, modelPaths.project, store.role, modelPaths.global);
    // A sit-rep that found nothing is not journal news: skip the fork so the
    // no-op costs one model call instead of two. The run marker is cleared
    // either way — it describes this run only.
    const noNewsSitRep = sitRepRunChangedNothing();
    sitRepRunSignature = null;
    const write =
      !noNewsSitRep &&
      (mode === "done"
        ? shouldJournal(store, toolUsedThisTurn, "done", userPromptThisRun)
        : mode === "turn" && shouldJournal(store, toolUsedThisTurn, "run-end"));
    userPromptThisRun = false;
    if (write) {
      await forkJournalFor(ctx);
    }

    // Auto-compact if journal grew past threshold. Fire-and-forget. Only
    // at run end — not per turn — to avoid racing the normal journal writes.
    if (journalMode(pi, modelPaths.project, store.role, modelPaths.global) !== "off") {
      store.compactJournal();
    }

    // Messages steered from agent_end handlers are still consumed: pi checks
    // its queues once more after these handlers settle and continues the run.
    await inbox.drainInbox(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!active) return;
    // Only prompt()-driven runs assemble the system prompt through this
    // handler. Persist the Picode rules as a structured section so later
    // sendMessage-triggered runs inherit them from the transcript; a forced
    // systemPrompt override applies only to this run and is not persisted.
    store.promptDrivenTurnSeen = true;

    // Roster digest — coordinator only, and cheap by construction: bounded
    // to the most recent workers, with session scans memoised by mtime.
    const workerRows = store.role === "coordinator" && !isRoundTable ? recentWorkers(ctx.cwd) : [];
    const workers = formatWorkerDigest(workerRows);

    // Stamped by revive_closed_session at launch with the timestamp of this
    // worker's last heartbeat before it stopped, so a resumed session knows
    // how stale its own context is.
    const revivedFlag = pi.getFlag("picode-revived");
    const revived =
      typeof revivedFlag === "string" && revivedFlag ? { since: revivedFlag } : undefined;

    const picodePrompt = threadModelPrompt(store, {
      roundTable: isRoundTable,
      workers,
      revived,
    });
    const basePrompt = event.systemPrompt;
    if (hasSystemPromptSections(event.systemPromptOptions)) {
      // Two sections, not one. A roster change re-sends the whole value of
      // whichever section changed, so keeping the roster in the same section as
      // the rules meant re-sending ~37k characters of rules to deliver a ~200
      // character digest. See splitPicodeRoster. Pi joins the values with a
      // blank line in insertion order, so this renders as the single-section form.
      const { rules, roster } = splitPicodeRoster(picodePrompt, workers);
      event.systemPromptOptions.sections.picode = rules;
      if (roster) event.systemPromptOptions.sections["picode-workers"] = roster;
      cacheDiagnostics.recordPrompt(ctx, basePrompt, picodePrompt, workers, workerRows.length);
      return;
    }

    // Older Pi versions do not expose structured sections; preserve their
    // existing prompt behavior while using transcript-backed sections when available.
    const renderedPrompt = `${basePrompt}\n\n${picodePrompt}`;
    cacheDiagnostics.recordPrompt(ctx, basePrompt, picodePrompt, workers, workerRows.length);
    return { systemPrompt: renderedPrompt };
  });
}
