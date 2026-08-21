import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { createPicodeStore } from "./state";
import { createInbox } from "./inbox";
import { registerLifecycle } from "./lifecycle";
import { registerTools } from "./tools/index";
import { registerCommands } from "./commands";
import { createConfiguredAdapter } from "./adapter/registry";

/** Extension entry point: register the CLI flags, build the configured
 *  storage adapter → store → inbox stack, and attach the three surfaces
 *  (lifecycle hooks, model-facing tools, human-facing slash commands). */
export default function (pi: ExtensionAPI) {
  pi.registerFlag("picode-id", {
    type: "string",
    description: "Stable id for this picode, used for cross-picode addressing (e.g. picode-b)",
  });
  pi.registerFlag("picode", {
    type: "boolean",
    description:
      "Shorthand for --picode-id coordinator. Use when you want the default coordinator role.",
  });
  pi.registerFlag("picode-parent", {
    type: "string",
    description: "Parent picode id, for Blocker escalation",
  });
  pi.registerFlag("picode-role", {
    type: "string",
    description:
      "Role label for this picode (e.g. dev, qa) — targetable via picode_send role:<role>",
  });
  pi.registerFlag("picode-journal", {
    type: "string",
    description:
      'Journal cadence: "turn", "done" (default, one entry per run at agent_end), or "off". Overrides .picode/models.json "journal-cadence" key.',
  });
  pi.registerFlag("picode-journal-model", {
    type: "string",
    description:
      'Model for journal fork entries (e.g. deepseek/deepseek-chat). Overrides .picode/models.json "journal" key. Default: the picode\'s own model — a pinned model must resolve on this machine or journaling fails.',
  });
  pi.registerFlag("picode-storage", {
    type: "string",
    description: 'Storage backend: "local" (default) or "restate"',
  });
  pi.registerFlag("picode-storage-url", {
    type: "string",
    description: "Backend connection URL (e.g. Restate ingress URL) — ignored by the local backend",
  });
  pi.registerFlag("theme", {
    type: "string",
    description:
      "Theme to apply (built-in name like 'tokyo-night' or path to custom .json theme file)",
  });

  const adapter = createConfiguredAdapter(pi);
  const store = createPicodeStore(pi, adapter);
  const inbox = createInbox(store, pi);

  registerLifecycle(pi, store, inbox);
  registerTools(pi, store, inbox);
  registerCommands(pi, store, inbox);

  // Coordinator envelope renderer: the operator asked NOT to see worker→
  // coordinator envelope bodies on screen (Morpheus summarizes instead).
  // The full content still reaches the model (sendMessage content is always
  // converted to a user message); this renderer only controls the TUI view.
  // Collapsed → one-line header per batch (sender + id, "+N more" if batched).
  // Expanded → the full rendered envelope text, so the operator can still
  // inspect a message on demand.
  pi.registerMessageRenderer("picode-envelope", (message, { expanded }, theme) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter(c => c.type === "text")
            .map(c => ("text" in c ? c.text : ""))
            .join("\n");
    const details = message.details as { count?: number; highUrgency?: boolean } | undefined;
    const count = details?.count ?? 1;

    // First envelope header line looks like "[kind from <id> #<eid> re #<rid>]".
    const firstHeader = /^\[([^\]]+)\]/.exec(content)?.[1] ?? "incoming envelope";
    const more = count > 1 ? theme.fg("dim", `  (+${count - 1} more)`) : "";
    const marker = details?.highUrgency ? theme.fg("warning", "⚠ ") : "";
    const collapsed = `${marker}${theme.fg("customMessageLabel", "📨 ")}${theme.fg("dim", firstHeader)}${more}`;

    const box = new Box(1, 1, t => theme.bg("customMessageBg", t));
    if (expanded) {
      box.addChild(new Text(theme.fg("customMessageLabel", "📨 incoming envelopes"), 0, 0));
      box.addChild(new Text(theme.fg("customMessageText", content), 0, 0));
    } else {
      box.addChild(new Text(collapsed, 0, 0));
    }
    return box;
  });
}
