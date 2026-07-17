import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ThreadStore } from "./core/types";
import { formatThreadLine } from "./core/format";
import { resumeThread, suspendThread } from "./core/thread-ops";
import type { Inbox } from "./inbox";
import { checkBodySize } from "./tools/messaging";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Slash commands: the human operator's view of the same operations the
 *  thread_* tools give the model. */

const NOT_ACTIVE =
  "This session hasn't opted into picode — restart pi with --thread-id <id> to activate.";

/** store.threadId is only ever set by state.ts's init(), which lifecycle.ts
 *  skips entirely when the opt-in gate is closed — so an empty id means this
 *  session never activated, not just "hasn't picked a name yet". */
function checkActive(store: ThreadStore, ctx: ExtensionCommandContext): boolean {
  if (store.threadId) return true;
  ctx.ui.notify(NOT_ACTIVE, "warning");
  return false;
}

export function registerCommands(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
  pi.registerCommand("/thread-status", {
    description: "Show this thread's own state and latest journal entry",
    async handler(_args, ctx) {
      if (!checkActive(store, ctx)) return;
      await ctx.waitForIdle();
      const journal = await store.readJournal(store.threadId);
      const lines = journal ? journal.split("\n").slice(-12).join("\n") : "(no journal yet)";
      ctx.ui.notify(
        `Id: ${store.threadId} | State: ${store.state} | Status: ${store.status} | Obligations: ${store.obligations.length} | Owed: ${store.owed.length} | Barriers: ${store.barriers.length}\n\n${lines}`,
        "info",
      );
    },
  });

  pi.registerCommand("/thread-journal", {
    description:
      "View, trim, clear, or compact the journal: /thread-journal [status|tail N|trim N|clear|compact]",
    async handler(args, ctx) {
      if (!checkActive(store, ctx)) return;
      await ctx.waitForIdle();
      const trimmed = args.trim();
      const subcommand = trimmed.split(/\s+/)[0] ?? "";

      const journal = await store.readJournal(store.threadId);
      const entries = journal ? journal.split(/\n(?=<!--)/).filter(Boolean) : [];

      // No args → last 12 entries
      if (!subcommand) {
        const lines = entries.slice(-12).join("\n") || "(no journal yet)";
        ctx.ui.notify(lines, "info");
        return;
      }

      if (subcommand === "status") {
        const size = journal ? journal.length : 0;
        const tsRe = /^<!--\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}|COMPACTION)/;
        const oldest = entries[0]?.match(tsRe)?.[1] ?? "(none)";
        const newest = entries[entries.length - 1]?.match(tsRe)?.[1] ?? "(none)";
        ctx.ui.notify(
          `Journal: ${entries.length} entries, ${size} bytes\noldest: ${oldest}\nnewest: ${newest}`,
          "info",
        );
        return;
      }

      if (subcommand === "tail") {
        const n = parseInt(trimmed.split(/\s+/)[1] ?? "12", 10);
        if (!Number.isFinite(n) || n < 1) {
          ctx.ui.notify("Usage: /thread-journal tail N", "warning");
          return;
        }
        const lines = entries.slice(-n).join("\n") || "(no journal yet)";
        ctx.ui.notify(lines, "info");
        return;
      }

      if (subcommand === "trim") {
        const n = parseInt(trimmed.split(/\s+/)[1] ?? "100", 10);
        if (!Number.isFinite(n) || n < 1) {
          ctx.ui.notify("Usage: /thread-journal trim N", "warning");
          return;
        }
        if (entries.length <= n) {
          ctx.ui.notify(`Journal already at ${entries.length} entries (≤ ${n}).`, "info");
          return;
        }
        const kept = entries.slice(-n);
        const newContent = kept.join("\n") + "\n";
        // setJournal acquires its own lock internally — no double-acquire.
        await store.adapter.setJournal?.(store.threadId, newContent);
        ctx.ui.notify(`Trimmed: ${entries.length} → ${kept.length} entries.`, "info");
        return;
      }

      if (subcommand === "clear") {
        // deleteJournal acquires its own lock internally.
        await store.adapter.deleteJournal?.(store.threadId);
        ctx.ui.notify("Journal deleted.", "info");
        return;
      }

      if (subcommand === "compact") {
        const sf = ctx.sessionManager.getSessionFile();
        if (!sf) {
          ctx.ui.notify("No session file — cannot fork compaction.", "error");
          return;
        }
        store.compactJournal(sf);
        ctx.ui.notify("Compact triggered (fire-and-forget).", "info");
        return;
      }

      ctx.ui.notify("Usage: /thread-journal [status|tail N|trim N|clear|compact]", "warning");
    },
  });

  pi.registerCommand("/thread-list", {
    description: "List all known threads sharing this workspace",
    async handler(_args, ctx) {
      if (!checkActive(store, ctx)) return;
      const threads = await store.listThreads();
      if (!threads.length) {
        ctx.ui.notify("(no other threads found)", "info");
        return;
      }
      ctx.ui.notify(threads.map(formatThreadLine).join("\n"), "info");
    },
  });

  pi.registerCommand("/thread-send", {
    description: "Send a note to another thread: /thread-send <to> <body...>",
    async handler(args, ctx) {
      if (!checkActive(store, ctx)) return;
      const parts = args.trim().split(/\s+/);
      const [to, ...bodyParts] = parts;
      const body = bodyParts.join(" ");
      if (!to || !body) {
        ctx.ui.notify("Usage: /thread-send <to> <body...>", "warning");
        return;
      }
      if (to === store.threadId) {
        ctx.ui.notify("Cannot send to self.", "warning");
        return;
      }
      // Same body-size guard as the thread_send tool: /thread-send is the
      // human-equivalent entry point and must not bypass the 256KB cap
      // that protects the inbox dir from runaway writes.
      const sizeError = checkBodySize(body);
      if (sizeError) {
        ctx.ui.notify(sizeError, "error");
        return;
      }
      try {
        const targets = (await inbox.resolveTargets(to)).filter(t => t !== store.threadId);
        if (!targets.length) {
          ctx.ui.notify(`No matching targets for "${to}".`, "warning");
          return;
        }
        const missing = new Set(await inbox.findMissingTargets(targets));
        // Operator sends are urgent by default — a human steering a thread
        // wants it seen at the next opening, not when the target goes idle.
        const sent = await inbox.sendToMany(targets, body, { urgency: "high" });
        for (const s of sent) {
          const unseen = missing.has(s.to);
          ctx.ui.notify(
            `Sent to ${s.to}. id=${s.id} (${s.delivered}).${unseen ? ` Warning: "${s.to}" has never been seen in this workspace — delivers only if a thread with that id starts.` : ""}`,
            unseen ? "warning" : "info",
          );
        }
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("/thread-suspend", {
    description: "Mark this thread On Hold: /thread-suspend [reason]",
    async handler(args, ctx) {
      if (!checkActive(store, ctx)) return;
      await suspendThread(store, args.trim() || null, ctx);
      ctx.ui.notify(
        `Thread suspended (On Hold)${store.holdReason ? `: ${store.holdReason}` : ""}. Inbox queues until resume.`,
        "info",
      );
    },
  });

  pi.registerCommand("/thread-resume", {
    description: "Resume this thread from On Hold back to Open",
    async handler(_args, ctx) {
      if (!checkActive(store, ctx)) return;
      if (!(await resumeThread(store, () => inbox.drainInbox(ctx), ctx))) {
        ctx.ui.notify(`Not on hold (state is ${store.state}).`, "warning");
        return;
      }
      ctx.ui.notify("Thread resumed (Open). Queued inbox drained.", "info");
    },
  });

  pi.registerCommand("/thread-models", {
    description: "Show or set worker models: /thread-models [role model] (--reset to clear)",
    async handler(args, ctx) {
      if (!checkActive(store, ctx)) return;
      const modelsPath = join(ctx.cwd, ".thread", "models.json");
      const trimmed = args.trim();

      // --reset: delete file, notify defaults
      if (trimmed === "--reset") {
        if (existsSync(modelsPath)) {
          unlinkSync(modelsPath);
        }
        ctx.ui.notify("Cleared .thread/models.json — defaults restored.", "info");
        return;
      }

      // No args → show config
      if (!trimmed) {
        let models: Record<string, string> = {};
        if (existsSync(modelsPath)) {
          try {
            models = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, string>;
          } catch {
            ctx.ui.notify(`.thread/models.json exists but is invalid JSON.`, "error");
            return;
          }
        }
        const entries = Object.entries(models);
        if (!entries.length) {
          ctx.ui.notify("No models configured (.thread/models.json absent or empty).", "info");
          return;
        }
        const lines = entries.map(([role, model]) => `  ${role}: ${model}`).join("\n");
        ctx.ui.notify(`Worker models:\n${lines}`, "info");
        return;
      }

      // role + model → set and persist
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /thread-models [role model] (--reset to clear)", "warning");
        return;
      }
      const [role, model] = parts;
      let models: Record<string, string> = {};
      if (existsSync(modelsPath)) {
        try {
          models = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, string>;
        } catch {
          ctx.ui.notify(
            `.thread/models.json exists but is invalid JSON — not overwriting.`,
            "error",
          );
          return;
        }
      }
      models[role] = model;
      try {
        writeFileSync(modelsPath, JSON.stringify(models, null, 2));
        ctx.ui.notify(`Set ${role} → ${model} in .thread/models.json.`, "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });
}
