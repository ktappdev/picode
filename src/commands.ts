import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PicodeStore } from "./core/types";
import {
  formatIssues,
  issueJournalPath,
  issueSummary,
  readIssues,
  solveIssue,
} from "../bin/issue-journal.mjs";
import { formatThreadLine } from "./core/format";
import { resumeThread, suspendThread } from "./core/picode-ops";
import type { Inbox } from "./inbox";
import { checkBodySize } from "./tools/messaging";
import { existsSync, unlinkSync } from "node:fs";
import { interactiveModelSelector } from "./commands-models";
import {
  DEFAULT_MODELS,
  modelsConfigPaths,
  readModelsConfig,
  resolveModelFromConfigs,
  writeModelsConfig,
  type ModelConfigScope,
} from "./core/model-config";
import { isQuietTui, resolveQuietTui, setQuietTui, writeQuietTui } from "./core/quiet-tui";
import {
  DEFAULT_THINKING,
  THINKING_LEVELS,
  isThinkingLevel,
  readThinkingConfig,
  resetThinkingConfig,
  resolveThinkingFromConfigs,
  thinkingConfigPaths,
  writeThinkingConfig,
  type ThinkingScope,
} from "./core/thinking-config";

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

export function registerCommands(
  pi: ExtensionAPI,
  store: PicodeStore,
  inbox: Inbox,
  agentDir?: string,
) {
  pi.registerCommand("/picode-status", {
    description: "Show this picode's coordination state and open papercut count",
    async handler(_args, ctx) {
      if (!checkActive(store, ctx)) return;
      try {
        await ctx.waitForIdle();
        const lines = `${issueSummary(ctx.cwd)} (/picode-journal to view).`;
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
      "Papercuts: /picode-journal [open|solved|all|show PC-001|solve PC-001 [note]|status]",
    getArgumentCompletions(argumentPrefix: string) {
      return [
        { value: "open", label: "open", description: "List open papercuts (default)" },
        { value: "solved", label: "solved", description: "List solved papercuts" },
        { value: "all", label: "all", description: "List all papercuts" },
        { value: "show", label: "show PC-001", description: "Show an issue in full" },
        { value: "solve", label: "solve PC-001 [note]", description: "Mark an issue solved" },
        { value: "status", label: "status", description: "Open and solved counts, file location" },
      ].filter(item => item.value.startsWith(argumentPrefix.trim()));
    },
    async handler(args, ctx) {
      if (!checkActive(store, ctx)) return;
      try {
        await ctx.waitForIdle();
        const [command = "open", id, ...words] = args.trim().split(/\s+/).filter(Boolean);
        if (command === "solve") {
          if (!id) throw new Error("Usage: /picode-journal solve PC-001 [resolution note]");
          const result = await solveIssue(ctx.cwd, id, words.join(" "));
          ctx.ui.notify(
            `${id}: ${result.alreadySolved ? "already solved" : "marked solved"}.`,
            "info",
          );
          return;
        }
        const issues = readIssues(ctx.cwd);
        if (command === "status") {
          const open = issues.filter(issue => !issue.solved).length;
          ctx.ui.notify(
            `Papercuts: ${open} open, ${issues.length - open} solved.\n${issueJournalPath(ctx.cwd)}`,
            "info",
          );
          return;
        }
        if (command === "show") {
          if (!id || !issues.some(issue => issue.id === id))
            throw new Error(
              `No issue ${id ?? "(id required)"} found. Usage: /picode-journal show PC-001`,
            );
          ctx.ui.notify(formatIssues(issues, { id, status: "all", compact: false }), "info");
          return;
        }
        if (command !== "open" && command !== "solved" && command !== "all") {
          throw new Error(
            "Usage: /picode-journal [open|solved|all|show PC-001|solve PC-001 [note]|status]. Old trim/clear/compact actions were removed to preserve issues.",
          );
        }
        ctx.ui.notify(
          formatIssues(issues, { status: command, tail: 0 }) + `\n\n${issueJournalPath(ctx.cwd)}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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
    getArgumentCompletions(argumentPrefix: string) {
      // Only complete the target token — once a space is typed the user is
      // writing the body, and completing against free text is noise.
      if (argumentPrefix.includes(" ")) return null;
      const prefix = argumentPrefix.trim();
      return (async () => {
        const targets: { value: string; label: string; description?: string }[] = [
          { value: "*", label: "*", description: "every known picode" },
        ];
        for (const p of await store.listPcodes()) {
          if (p.id === store.picodeId) continue;
          targets.push({ value: p.id, label: p.id, description: `${p.role} · ${p.state}` });
        }
        return targets.filter(t => t.value.startsWith(prefix));
      })();
    },
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

  // Operator-screen quiet mode: hides picode's traffic rows (envelope batches,
  // system prompts, tool call headers) — DISPLAY ONLY. Envelopes, obligations,
  // barriers, journal, status, and the model's context are untouched; pi's
  // renderers and the `display` flag never affect behavior (convertToLlm
  // ignores display). Resolution: PICODE_QUIET_TUI env > project > global file.
  pi.registerCommand("/picode-quiet", {
    description:
      "Quiet operator screen: /picode-quiet [on|off|status] [--project] — hides picode traffic rows (display only)",
    getArgumentCompletions(argumentPrefix: string) {
      if (argumentPrefix.includes(" ")) return null;
      const flags = [
        { value: "on", label: "on", description: "hide picode traffic rows" },
        { value: "off", label: "off", description: "show them again (today's view)" },
        { value: "status", label: "status", description: "current mode + which config set it" },
        {
          value: "--project",
          label: "--project",
          description: "write this repo's config instead of global",
        },
      ];
      return flags.filter(f => f.value.startsWith(argumentPrefix.trim()));
    },
    async handler(args, ctx) {
      if (!checkActive(store, ctx)) return;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const useProject = parts.includes("--project");
      const scope = useProject ? "project" : "global";
      const cmd = parts.find(p => p !== "--project") ?? "toggle";

      if (cmd === "status") {
        const r = resolveQuietTui(ctx.cwd, agentDir);
        ctx.ui.notify(
          `Quiet screen: ${r.value ? "on" : "off"} (source: ${r.source}; priority env > project > global).`,
          "info",
        );
        return;
      }
      if (cmd !== "on" && cmd !== "off" && cmd !== "toggle") {
        ctx.ui.notify("Usage: /picode-quiet [on|off|status] [--project]", "warning");
        return;
      }

      const next = cmd === "toggle" ? !isQuietTui() : cmd === "on";
      writeQuietTui(next, scope, ctx.cwd, agentDir);
      setQuietTui(next);

      // Rebuild rows already on screen: flipping expansion round-trips every
      // chat child through setExpanded, and both message and tool components
      // re-run their renderers then. Restoring the original value preserves
      // the user's expand preference; both calls land in the same render tick,
      // so nothing flashes. Older pi builds without these methods simply don't
      // refresh existing rows (new rows still obey quiet).
      if (
        typeof ctx.ui.getToolsExpanded === "function" &&
        typeof ctx.ui.setToolsExpanded === "function"
      ) {
        const expanded = ctx.ui.getToolsExpanded();
        ctx.ui.setToolsExpanded(!expanded);
        ctx.ui.setToolsExpanded(expanded);
      }

      // Report the RESOLVED truth, not the intended value — env or the other
      // scope's file may override this write.
      const r = resolveQuietTui(ctx.cwd, agentDir);
      const overridden = r.value !== next;
      ctx.ui.notify(
        `Quiet screen: ${r.value ? "on" : "off"} (source: ${r.source})${
          overridden ? " — overridden by higher-priority config" : ""
        }`,
        overridden ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("/picode-reset", {
    description:
      "Clear all obligations, owed replies, and barriers across all threads. Use before shutdown for a clean slate.",
    getArgumentCompletions(argumentPrefix: string) {
      if (argumentPrefix.includes(" ")) return null;
      return [
        { value: "--force", label: "--force", description: "also reset the current picode" },
      ].filter(f => f.value.startsWith(argumentPrefix.trim()));
    },
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

  pi.registerCommand("/picode-thinking", {
    description:
      "Configure worker thinking levels: /picode-thinking [--global|--project] (role level | --reset)",
    getArgumentCompletions(argumentPrefix: string) {
      if (argumentPrefix.includes(" ")) return null;
      const choices = [
        "builder",
        "reviewer",
        "bug-hunter",
        "planner",
        "designer",
        "scout",
        "explorer",
        "visionary",
        "gauntlet",
        "tester",
        "runner",
        "--global",
        "--project",
        "--reset",
      ];
      return choices
        .filter(value => value.startsWith(argumentPrefix.trim()))
        .map(value => ({ value, label: value }));
    },
    async handler(args, ctx) {
      if (!checkActive(store, ctx)) return;
      const paths = thinkingConfigPaths(ctx.cwd, agentDir);
      const usage = `Usage: /picode-thinking [--global|--project] [role level | --reset] (levels: ${THINKING_LEVELS.join(", ")})`;
      const rawParts = args.trim() ? args.trim().split(/\s+/) : [];
      const scopeFlags = rawParts.filter(part => part === "--global" || part === "--project");
      if (scopeFlags.length > 1) {
        ctx.ui.notify(usage, "warning");
        return;
      }
      const scope: ThinkingScope = scopeFlags[0] === "--global" ? "global" : "project";
      const parts = rawParts.filter(part => part !== "--global" && part !== "--project");
      const scopeLabel = scope === "global" ? "global defaults" : "project overrides";

      if (parts[0] === "--reset") {
        if (parts.length !== 1) {
          ctx.ui.notify(usage, "warning");
          return;
        }
        try {
          resetThinkingConfig(paths[scope], scope);
          ctx.ui.notify(
            scope === "global"
              ? "Cleared global Picode thinking overrides — built-in defaults restored."
              : "Cleared project Picode thinking overrides — global defaults restored.",
            "info",
          );
        } catch (e) {
          ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
        }
        return;
      }

      if (parts.length > 0) {
        if (parts.length !== 2 || !/^[a-zA-Z0-9-]+$/.test(parts[0])) {
          ctx.ui.notify(usage, "warning");
          return;
        }
        const [role, level] = parts;
        if (!isThinkingLevel(level)) {
          ctx.ui.notify(`Invalid thinking level: ${level}. ${usage}`, "warning");
          return;
        }
        try {
          const config = readThinkingConfig(paths[scope]);
          config[role] = level;
          writeThinkingConfig(paths[scope], config);
          ctx.ui.notify(`Set ${role} thinking → ${level} in ${scopeLabel}.`, "info");
        } catch (e) {
          ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
        }
        return;
      }

      try {
        const project = readThinkingConfig(paths.project);
        const global = readThinkingConfig(paths.global);
        const roles = [
          ...new Set([
            ...Object.keys(DEFAULT_THINKING),
            ...Object.keys(global),
            ...Object.keys(project),
          ]),
        ].sort();
        const lines = ["Effective worker thinking levels (project → global → built-in):"];
        for (const role of roles) {
          const level = resolveThinkingFromConfigs(role, project, global);
          lines.push(`  ${role}: ${level ?? "pi default"}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (e) {
        ctx.ui.notify(
          e instanceof Error ? e.message : "Picode thinking config is invalid.",
          "error",
        );
      }
    },
  });

  pi.registerCommand("/picode-models", {
    description:
      "Configure worker models: /picode-models [--global|--project] (interactive | role model | --reset)",
    async handler(args, ctx) {
      if (!checkActive(store, ctx)) return;

      const paths = modelsConfigPaths(ctx.cwd, agentDir);
      const usage =
        "Usage: /picode-models [--global|--project] (interactive | role model | --reset)";
      const rawParts = args.trim() ? args.trim().split(/\s+/) : [];
      const scopeFlags = rawParts.filter(part => part === "--global" || part === "--project");
      if (scopeFlags.length > 1) {
        ctx.ui.notify(usage, "warning");
        return;
      }
      const scope: ModelConfigScope = scopeFlags[0] === "--global" ? "global" : "project";
      const parts = rawParts.filter(part => part !== "--global" && part !== "--project");
      const scopeLabel = scope === "global" ? "global defaults" : "project overrides";

      // --reset clears only selected scope. Global file remains present as an
      // empty override file; built-in defaults still resolve underneath it.
      if (parts[0] === "--reset") {
        if (parts.length !== 1) {
          ctx.ui.notify(usage, "warning");
          return;
        }
        if (scope === "global") {
          try {
            writeModelsConfig(paths.global, {});
          } catch (e) {
            ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
            return;
          }
          ctx.ui.notify(
            "Cleared global Picode model overrides — built-in defaults restored.",
            "info",
          );
        } else {
          if (existsSync(paths.project)) unlinkSync(paths.project);
          ctx.ui.notify(
            "Cleared project Picode model overrides — global defaults restored.",
            "info",
          );
        }
        return;
      }

      // Positional role/model syntax remains project-scoped for compatibility.
      // Add --global when setting one global role without opening the selector.
      if (parts.length > 0) {
        if (parts.length !== 2) {
          ctx.ui.notify(usage, "warning");
          return;
        }
        const [role, model] = parts;
        if (role === "journal" || role.startsWith("journal-")) {
          ctx.ui.notify(
            "Automatic journal models/cadence were removed. Use /picode-journal for papercuts; no separate model is needed.",
            "warning",
          );
          return;
        }
        const modelsPath = paths[scope];
        let models: Record<string, string>;
        try {
          models = readModelsConfig(modelsPath);
        } catch {
          ctx.ui.notify(`${modelsPath} is invalid JSON — not overwriting.`, "error");
          return;
        }
        models[role] = model;
        try {
          writeModelsConfig(modelsPath, models);
          ctx.ui.notify(`Set ${role} → ${model} in ${scopeLabel}.`, "info");
        } catch (e) {
          ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
        }
        return;
      }

      // No UI: show both layers so project inheritance is visible.
      if (!ctx.hasUI) {
        try {
          const globalOverrides = readModelsConfig(paths.global);
          const global = { ...DEFAULT_MODELS, ...globalOverrides };
          for (const role of Object.keys(global)) {
            if (role === "theme" || role === "coordinator" || role.startsWith("journal")) continue;
            global[role] = resolveModelFromConfigs(role, {}, globalOverrides);
          }
          const project = readModelsConfig(paths.project);
          const format = (config: Record<string, string>) =>
            Object.entries(config)
              .filter(
                ([key]) => key !== "theme" && key !== "journal" && !key.startsWith("journal-"),
              )
              .map(([role, model]) => `  ${role}: ${model}`);
          const projectLines = format(project);
          const lines = [
            "Global defaults:",
            ...format(global),
            "",
            "Project overrides:",
            ...(projectLines.length ? projectLines : ["  (none — inherits global defaults)"]),
          ];
          ctx.ui.notify(lines.join("\n"), "info");
        } catch (e) {
          ctx.ui.notify(
            e instanceof Error ? e.message : "Picode model config is invalid JSON.",
            "error",
          );
        }
        return;
      }

      let selectedScope: ModelConfigScope = scope;
      if (scopeFlags.length === 0) {
        const choice = await ctx.ui.select("Configure worker models", [
          "Global defaults",
          "This project overrides",
        ]);
        if (!choice) return;
        selectedScope = choice === "Global defaults" ? "global" : "project";
      }

      const selectedPath = paths[selectedScope];
      try {
        readModelsConfig(selectedPath);
        if (selectedScope === "project") readModelsConfig(paths.global);
      } catch (e) {
        ctx.ui.notify(
          e instanceof Error ? e.message : "Picode model config is invalid JSON.",
          "error",
        );
        return;
      }
      try {
        const summary = await interactiveModelSelector(ctx, paths, selectedScope);
        ctx.ui.notify(summary, "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });
}
