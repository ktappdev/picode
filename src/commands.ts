import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PicodeStore } from "./core/types";
import { formatThreadLine } from "./core/format";
import { resumeThread, suspendThread } from "./core/picode-ops";
import type { Inbox } from "./inbox";
import { checkBodySize } from "./tools/messaging";
import { interactiveModelSelector, readModelsConfig } from "./commands-models";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Slash commands: the human operator's view of the same operations the
 *  picode_* tools give the model. */

const NOT_ACTIVE =
  "This session hasn't opted into picode — restart pi with --picode-id <id> to activate.";

/** store.picodeId is only ever set by state.ts's init(), which lifecycle.ts
 *  skips entirely when the opt-in gate is closed — so an empty id means this
 *  session never activated, not just "hasn't picked a name yet". */
function checkActive(store: PicodeStore, ctx: ExtensionCommandContext): boolean {
  if (store.picodeId) return true;
  ctx.ui.notify(NOT_ACTIVE, "warning");
  return false;
}

export function registerCommands(pi: ExtensionAPI, store: PicodeStore, inbox: Inbox) {
  pi.registerCommand("/picode-status", {
    description: "Show this picode's own state and latest journal entry",
    async handler(_args, ctx) {
      if (!checkActive(store, ctx)) return;
      try {
        await ctx.waitForIdle();
        const journal = await store.readJournal(store.picodeId);
        const lines = journal ? journal.split("\n").slice(-12).join("\n") : "(no journal yet)";
        ctx.ui.notify(
          `Id: ${store.picodeId} | State: ${store.state} | Status: ${store.status} | Obligations: ${store.obligations.length} | Owed: ${store.owed.length} | Barriers: ${store.barriers.length}\n\n${lines}`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("/picode-journal", {
    description:
      "View, trim, clear, or compact the journal: /picode-journal [status|tail N|trim N|clear|compact]",
    async handler(args, ctx) {
      if (!checkActive(store, ctx)) return;
      try {
        await ctx.waitForIdle();
        const trimmed = args.trim();
        const subcommand = trimmed.split(/\s+/)[0] ?? "";

        const journal = await store.readJournal(store.picodeId);
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
            ctx.ui.notify("Usage: /picode-journal tail N", "warning");
            return;
          }
          const lines = entries.slice(-n).join("\n") || "(no journal yet)";
          ctx.ui.notify(lines, "info");
          return;
        }

        if (subcommand === "trim") {
          const n = parseInt(trimmed.split(/\s+/)[1] ?? "100", 10);
          if (!Number.isFinite(n) || n < 1) {
            ctx.ui.notify("Usage: /picode-journal trim N", "warning");
            return;
          }
          if (entries.length <= n) {
            ctx.ui.notify(`Journal already at ${entries.length} entries (≤ ${n}).`, "info");
            return;
          }
          const kept = entries.slice(-n);
          const newContent = kept.join("\n") + "\n";
          // setJournal acquires its own lock internally — no double-acquire.
          await store.adapter.setJournal?.(store.picodeId, newContent);
          ctx.ui.notify(`Trimmed: ${entries.length} → ${kept.length} entries.`, "info");
          return;
        }

        if (subcommand === "clear") {
          // deleteJournal acquires its own lock internally.
          await store.adapter.deleteJournal?.(store.picodeId);
          ctx.ui.notify("Journal deleted.", "info");
          return;
        }

        if (subcommand === "compact") {
          store.compactJournal();
          ctx.ui.notify("Compact triggered (fire-and-forget).", "info");
          return;
        }

        ctx.ui.notify("Usage: /picode-journal [status|tail N|trim N|clear|compact]", "warning");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("/picode-list", {
    description: "List all known threads sharing this workspace",
    async handler(_args, ctx) {
      if (!checkActive(store, ctx)) return;
      try {
        const threads = await store.listPcodes();
        if (!threads.length) {
          ctx.ui.notify("(no other threads found)", "info");
          return;
        }
        ctx.ui.notify(threads.map(formatThreadLine).join("\n"), "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("/picode-send", {
    description: "Send a note to another picode: /picode-send <to> <body...>",
    async handler(args, ctx) {
      if (!checkActive(store, ctx)) return;
      const parts = args.trim().split(/\s+/);
      const [to, ...bodyParts] = parts;
      const body = bodyParts.join(" ");
      if (!to || !body) {
        ctx.ui.notify("Usage: /picode-send <to> <body...>", "warning");
        return;
      }
      if (to === store.picodeId) {
        ctx.ui.notify("Cannot send to self.", "warning");
        return;
      }
      // Same body-size guard as the picode_send tool: /picode-send is the
      // human-equivalent entry point and must not bypass the 256KB cap
      // that protects the inbox dir from runaway writes.
      const sizeError = checkBodySize(body);
      if (sizeError) {
        ctx.ui.notify(sizeError, "error");
        return;
      }
      try {
        const targets = (await inbox.resolveTargets(to)).filter(t => t !== store.picodeId);
        if (!targets.length) {
          ctx.ui.notify(`No matching targets for "${to}".`, "warning");
          return;
        }
        const missing = new Set(await inbox.findMissingTargets(targets));
        // Operator sends are urgent by default — a human steering a picode
        // wants it seen at the next opening, not when the target goes idle.
        const sent = await inbox.sendToMany(targets, body, { urgency: "high" });
        for (const s of sent) {
          const unseen = missing.has(s.to);
          ctx.ui.notify(
            `Sent to ${s.to}. id=${s.id} (${s.delivered}).${unseen ? ` Warning: "${s.to}" has never been seen in this workspace — delivers only if a picode with that id starts.` : ""}`,
            unseen ? "warning" : "info",
          );
        }
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("/picode-suspend", {
    description: "Mark this picode On Hold: /picode-suspend [reason]",
    async handler(args, ctx) {
      if (!checkActive(store, ctx)) return;
      try {
        await suspendThread(store, args.trim() || null, ctx);
        ctx.ui.notify(
          `Picode suspended (On Hold)${store.holdReason ? `: ${store.holdReason}` : ""}. Inbox queues until resume.`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("/picode-resume", {
    description: "Resume this picode from On Hold back to Open",
    async handler(_args, ctx) {
      if (!checkActive(store, ctx)) return;
      try {
        if (!(await resumeThread(store, () => inbox.drainInbox(ctx), ctx))) {
          ctx.ui.notify(`Not on hold (state is ${store.state}).`, "warning");
          return;
        }
        ctx.ui.notify("Picode resumed (Open). Queued inbox drained.", "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("/picode-reset", {
    description:
      "Clear all obligations, owed replies, and barriers across all threads. Use before shutdown for a clean slate.",
    async handler(args, ctx) {
      if (!checkActive(store, ctx)) return;
      try {
        await ctx.waitForIdle();
        const force = args.trim() === "--force";
        const threads = await store.listPcodes();
        const cleared: string[] = [];
        const skipped: { id: string; reason: string }[] = [];

        for (const picode of threads) {
          // Never reset the current picode unless --force is passed
          if (picode.id === store.picodeId && !force) {
            skipped.push({ id: picode.id, reason: "current picode (use --force to include)" });
            continue;
          }

          const state = await store.adapter.loadPicodeState(picode.id);
          if (!state) {
            skipped.push({ id: picode.id, reason: "no state.json" });
            continue;
          }

          const obligations = state.obligations?.length ?? 0;
          const owed = state.owed?.length ?? 0;
          const barriers = state.barriers?.length ?? 0;

          if (obligations === 0 && owed === 0 && barriers === 0) {
            skipped.push({ id: picode.id, reason: "no debts to clear" });
            continue;
          }

          // Zero out all three debt arrays
          state.obligations = [];
          state.owed = [];
          state.barriers = [];
          state.updatedAt = new Date().toISOString();

          await store.adapter.savePicodeState(picode.id, state);
          cleared.push(
            `${picode.id} (obligations: ${obligations}, owed: ${owed}, barriers: ${barriers})`,
          );
        }

        const lines = [];
        if (cleared.length > 0) {
          lines.push(`Cleared ${cleared.length} picode(s):`);
          lines.push(...cleared.map(id => `  ${id}`));
        }
        if (skipped.length > 0) {
          lines.push(`Skipped ${skipped.length} picode(s):`);
          lines.push(...skipped.map(s => `  ${s.id}: ${s.reason}`));
        }
        if (lines.length === 0) {
          lines.push("No threads found with debts to clear.");
        }

        ctx.ui.notify(lines.join("\n"), cleared.length > 0 ? "info" : "warning");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("/picode-models", {
    description:
      "Configure worker models: /picode-models (interactive) | /picode-models role model | /picode-models --reset",
    async handler(args, ctx) {
      if (!checkActive(store, ctx)) return;
      const modelsPath = join(ctx.cwd, ".picode", "models.json");
      const trimmed = args.trim();

      // --reset: delete file, notify defaults
      if (trimmed === "--reset") {
        if (existsSync(modelsPath)) {
          unlinkSync(modelsPath);
        }
        ctx.ui.notify("Cleared .picode/models.json — defaults restored.", "info");
        return;
      }

      // "role model" positional args → set directly (bypass selector)
      if (trimmed) {
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) {
          ctx.ui.notify(
            "Usage: /picode-models (interactive) | /picode-models role model | /picode-models --reset",
            "warning",
          );
          return;
        }
        const [role, model] = parts;
        let models: Record<string, string> = {};
        if (existsSync(modelsPath)) {
          try {
            models = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, string>;
          } catch {
            ctx.ui.notify(
              `.picode/models.json exists but is invalid JSON — not overwriting.`,
              "error",
            );
            return;
          }
        }
        models[role] = model;
        try {
          writeFileSync(modelsPath, JSON.stringify(models, null, 2));
          ctx.ui.notify(`Set ${role} → ${model} in .picode/models.json.`, "info");
        } catch (e) {
          ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
        }
        return;
      }

      // No args → interactive selector (if UI) or text listing (no UI)
      if (!ctx.hasUI) {
        try {
          const models = readModelsConfig(modelsPath);
          const entries = Object.entries(models).filter(([k]) => k !== "theme");
          if (!entries.length) {
            ctx.ui.notify("No models configured (.picode/models.json absent or empty).", "info");
            return;
          }
          const lines = entries.map(([role, model]) => `  ${role}: ${model}`).join("\n");
          ctx.ui.notify(`Worker models:\n${lines}`, "info");
        } catch {
          ctx.ui.notify(`.picode/models.json exists but is invalid JSON.`, "error");
        }
        return;
      }

      // Interactive: validate JSON first, then enter selector loop
      try {
        // readModelsConfig throws on invalid JSON — validate before entering TUI
        readModelsConfig(modelsPath);
      } catch {
        ctx.ui.notify(
          `.picode/models.json exists but is invalid JSON — fix or use --reset.`,
          "error",
        );
        return;
      }
      try {
        const summary = await interactiveModelSelector(ctx, modelsPath);
        ctx.ui.notify(summary, "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });
}
