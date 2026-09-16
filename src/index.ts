import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPicodeStore } from "./state";
import { createInbox } from "./inbox";
import { registerLifecycle } from "./lifecycle";
import { registerTools } from "./tools/index";
import { registerCommands } from "./commands";
import { envelopeMessageRenderer, systemMessageRenderer } from "./renderers";
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
  pi.registerFlag("picode-round-table", {
    type: "boolean",
    description: "Start a resumed, read-only Recall Round Table consultation.",
  });
  pi.registerFlag("picode-revived", {
    type: "string",
    description:
      "Set by revive_closed_session to the ISO timestamp of this worker's last heartbeat before it stopped. Tells the resumed session its context may be stale.",
  });
  pi.registerFlag("picode-journal", {
    type: "string",
    description:
      'Journal cadence: "turn", "done" (default, one entry per run at agent_end), or "off". Overrides merged global/project Picode model config "journal-cadence" key.',
  });
  pi.registerFlag("picode-journal-model", {
    type: "string",
    description:
      'Model for journal fork entries (e.g. deepseek/deepseek-chat). Overrides merged global/project Picode model config "journal" key. Default: the picode\'s own model — a pinned model must resolve on this machine or journaling fails.',
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

  // Operator-screen quieting: these renderers control the TUI view only —
  // the model always receives the full message content (pi's convertToLlm
  // ignores the display flag for custom-role messages).
  pi.registerMessageRenderer("picode-envelope", envelopeMessageRenderer);
  pi.registerMessageRenderer("picode-system", systemMessageRenderer);
  pi.registerMessageRenderer("picode-owed-reminder", systemMessageRenderer);
}
