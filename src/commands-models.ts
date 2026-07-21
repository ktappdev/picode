/** Interactive model selector for /picode-models.
 *
 *  Two-screen flow:
 *    1. Role list — pick a role (builder, reviewer, …, default, custom keys)
 *    2. Model picker — pick from available (authed) models, or clear
 *  Loops until user picks "(done)" or escapes.
 *
 *  Pure helpers (buildRoleItems, buildModelItems, formatContextWindow,
 *  readModelsConfig, writeModelsConfig, ROLE_DISPLAY_ORDER) are exported
 *  for unit testing. The TUI component itself is not unit-testable. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Model type derived from the registry — avoids a direct @earendil-works/pi-ai
 *  dependency (picode doesn't list it). Matches Model<Api> from pi-ai. */
type AvailableModel = ReturnType<ExtensionCommandContext["modelRegistry"]["getAvailable"]>[number];

/** Roles shown in the selector, in display order. Coordinator is excluded —
 *  its model comes from the --model flag, not models.json. "default" is the
 *  fallback resolveModel() uses when no role-specific entry exists. */
const ROLE_DISPLAY_ORDER = [
  "default",
  "journal",
  "builder",
  "reviewer",
  "tester",
  "scout",
  "designer",
  "bug-hunter",
  "planner",
  "runner",
] as const;

/** Keys in models.json that are not role assignments and must be preserved
 *  across writes. Currently just "theme" (used by spawn.ts:resolveTheme). */
const NON_ROLE_KEYS = new Set(["theme", "coordinator"]);

/** Sentinel values used as SelectItem.value for special list entries.
 *  Prefixed with "\x00" so they can never collide with a real role or
 *  model ID (which are alphanumeric + slash/hyphen). */
const DONE_SENTINEL = "\x00done";
const RESET_SENTINEL = "\x00reset";
const CLEAR_SENTINEL = "\x00clear";
const BACK_SENTINEL = "\x00back";
const CADENCE_SENTINEL = "\x00cadence";

// ── Pure helpers (unit-testable) ────────────────────────────────────

/** Read and parse .picode/models.json. Returns {} if absent.
 *  Throws on invalid JSON — caller handles. */
export function readModelsConfig(modelsPath: string): Record<string, string> {
  if (!existsSync(modelsPath)) return {};
  const raw = readFileSync(modelsPath, "utf8");
  return JSON.parse(raw) as Record<string, string>;
}

/** Write models.json with 2-space indent. Preserves non-role keys (theme)
 *  that were in the config — caller passes the full object. */
export function writeModelsConfig(modelsPath: string, config: Record<string, string>): void {
  writeFileSync(modelsPath, JSON.stringify(config, null, 2));
}

/** Format a context window token count for compact display.
 *  1000000 → "1M", 128000 → "128K", 49152 → "49K". */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** Build the description string for a model entry: "1M · reasoning" or "200K". */
export function formatModelDescription(model: AvailableModel): string {
  const parts = [formatContextWindow(model.contextWindow)];
  if (model.reasoning) parts.push("reasoning");
  return parts.join(" · ");
}

/** Build the ordered role list for the selector.
 *  Includes ROLE_DISPLAY_ORDER + any extra role keys from existing config
 *  (excluding non-role keys like "theme" and "coordinator").
 *  Appends special entries: (reset all) and (done). */
export function buildRoleItems(config: Record<string, string>): SelectItem[] {
  const seen = new Set<string>();
  const items: SelectItem[] = [];

  const addRole = (role: string) => {
    if (seen.has(role)) return;
    if (NON_ROLE_KEYS.has(role)) return;
    seen.add(role);
    const model = config[role];
    const label = role;
    const description =
      role === "journal" && !model ? "(inherits coordinator model)" : (model ?? "(not set)");
    items.push({ value: role, label, description });
  };

  for (const role of ROLE_DISPLAY_ORDER) addRole(role);
  // Any custom role keys from config not in the standard order
  for (const key of Object.keys(config)) {
    if (key.startsWith("journal-")) continue; // handled explicitly as cadence entry
    addRole(key);
  }

  // Journal cadence entry (reads/writes "journal-cadence" key in models.json)
  items.push({
    value: CADENCE_SENTINEL,
    label: "(journal cadence)",
    description: config["journal-cadence"] ?? "done (default)",
  });

  // Special entries
  items.push({ value: RESET_SENTINEL, label: "(reset all)", description: "delete models.json" });
  items.push({ value: DONE_SENTINEL, label: "(done)", description: "exit selector" });

  return items;
}

/** Build the model picker list for a given role.
 *  Shows all available (authed) models, sorted by provider then id.
 *  Prepends "(clear)" (inherit default) and appends "(back)". */
export function buildModelItems(
  models: AvailableModel[],
  currentModelId: string | undefined,
): SelectItem[] {
  const sorted = [...models].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });

  const items: SelectItem[] = sorted.map(m => {
    const value = `${m.provider}/${m.id}`;
    const label = value;
    const description = formatModelDescription(m);
    return { value, label, description };
  });

  // Prepend clear, append back — clear at top so it's easy to reach
  items.unshift({
    value: CLEAR_SENTINEL,
    label: "(clear)",
    description: currentModelId ? `inherit default (was ${currentModelId})` : "inherit default",
  });
  items.push({ value: BACK_SENTINEL, label: "(back)", description: "return to role list" });

  return items;
}

// ── TUI selectors (not unit-testable — requires real terminal) ──────

/** Themed SelectList factory — shared styling for both selectors. */
function themedSelectList(items: SelectItem[], maxVisible: number): SelectList {
  return new SelectList(items, maxVisible, {
    selectedPrefix: (t: string) => `\x1b[36m${t}\x1b[39m`,
    selectedText: (t: string) => `\x1b[36m${t}\x1b[39m`,
    description: (t: string) => `\x1b[2m${t}\x1b[22m`,
    scrollInfo: (t: string) => `\x1b[2m${t}\x1b[22m`,
    noMatch: (t: string) => `\x1b[33m${t}\x1b[39m`,
  });
}

/** A SelectList with an fzf-style fuzzy filter input above it.
 *  Printable chars + backspace go to the Input; arrows/enter/esc go to the
 *  SelectList. The list is re-filtered on every keystroke via fuzzyFilter
 *  (subsequence match, best matches first). Implements Focusable so the
 *  Input's hardware cursor is positioned correctly for IME input. */
class FilterableSelectList implements Focusable {
  private allItems: SelectItem[];
  private maxVisible: number;
  private filterLabel: string;
  private input: Input;
  private list: SelectList;
  private _focused = false;

  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;

  constructor(items: SelectItem[], maxVisible: number, filterLabel: string) {
    this.allItems = items;
    this.maxVisible = maxVisible;
    this.filterLabel = filterLabel;
    this.input = new Input();
    this.list = themedSelectList(items, maxVisible);
    this.list.onSelect = (item: SelectItem) => this.onSelect?.(item);
    this.list.onCancel = () => this.onCancel?.();
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  private applyFilter(query: string): void {
    if (!query) {
      this.list = themedSelectList(this.allItems, this.maxVisible);
    } else {
      const filtered = fuzzyFilter(this.allItems, query, i => `${i.label} ${i.description ?? ""}`);
      this.list = themedSelectList(filtered, this.maxVisible);
    }
    this.list.onSelect = (item: SelectItem) => this.onSelect?.(item);
    this.list.onCancel = () => this.onCancel?.();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const inputLines = this.input.render(Math.max(1, width - this.filterLabel.length));
    lines.push(this.filterLabel + inputLines.join("\n"));
    lines.push(...this.list.render(width));
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }

  handleInput(data: string): void {
    // Route navigation/confirm/cancel to the list; printable/edit keys to Input.
    // Escape: if filter query active, clear it first; second escape cancels.
    const isUp = matchesKey(data, Key.up);
    const isDown = matchesKey(data, Key.down);
    const isEnter = data === "\r" || data === "\n";
    const isEscape = matchesKey(data, Key.escape);

    if (isUp || isDown || isEnter) {
      this.list.handleInput(data);
      return;
    }
    if (isEscape) {
      if (this.input.getValue()) {
        this.input.setValue("");
        this.applyFilter("");
      } else {
        this.onCancel?.();
      }
      return;
    }

    // Printable / edit keys → Input, then refilter if value changed
    const before = this.input.getValue();
    this.input.handleInput(data);
    const after = this.input.getValue();
    if (before !== after) {
      this.applyFilter(after);
    }
  }
}

/** Show the role selector with fuzzy filter. Returns chosen value or null. */
async function showRoleSelector(
  ctx: ExtensionCommandContext,
  items: SelectItem[],
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Worker Models")), 1, 0));
    container.addChild(new Text(theme.fg("dim", "Select a role to configure"), 1, 0));
    container.addChild(new Text("", 1, 0));

    const filter = new FilterableSelectList(items, Math.min(items.length, 12), "filter: ");
    filter.focused = true;
    filter.onSelect = (item: SelectItem) => done(item.value);
    filter.onCancel = () => done(null);
    container.addChild(filter);

    container.addChild(new Text("", 1, 0));
    container.addChild(
      new Text(theme.fg("dim", "type to filter • ↑↓ navigate • enter select • esc cancel"), 1, 0),
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        filter.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/** Show the model picker with fuzzy filter. Returns chosen value or null. */
async function showModelSelector(
  ctx: ExtensionCommandContext,
  items: SelectItem[],
  role: string,
  currentModelId: string | undefined,
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(`Model for: ${role}`)), 1, 0));
    const currentLine = currentModelId
      ? `Current: ${currentModelId}`
      : "Current: (not set — inherits default)";
    container.addChild(new Text(theme.fg("dim", currentLine), 1, 0));
    container.addChild(new Text("", 1, 0));

    const filter = new FilterableSelectList(items, Math.min(items.length, 12), "filter: ");
    filter.focused = true;
    filter.onSelect = (item: SelectItem) => done(item.value);
    filter.onCancel = () => done(BACK_SENTINEL); // esc = back, not exit
    container.addChild(filter);

    container.addChild(new Text("", 1, 0));
    container.addChild(
      new Text(theme.fg("dim", "type to filter • ↑↓ navigate • enter select • esc back"), 1, 0),
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        filter.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

// ── Main entry: interactive loop ────────────────────────────────────

/** Run the interactive /picode-models selector.
 *  Loops role↔model until user picks (done) or escapes.
 *  Writes to models.json on each model pick.
 *  Returns a summary string for the caller to notify. */
export async function interactiveModelSelector(
  ctx: ExtensionCommandContext,
  modelsPath: string,
): Promise<string> {
  // Load available models once — registry doesn't change mid-session
  const availableModels = ctx.modelRegistry.getAvailable();
  if (availableModels.length === 0) {
    return "No models available. Run `/login <provider>` first.";
  }

  // Load current config (may throw on invalid JSON — caller handles)
  let config = readModelsConfig(modelsPath);
  const changed: string[] = [];

  // Main loop: role selector → model selector → back to role selector
  while (true) {
    const roleItems = buildRoleItems(config);
    const roleChoice = await showRoleSelector(ctx, roleItems);

    // null = esc from role selector → exit
    if (roleChoice === null) break;
    if (roleChoice === DONE_SENTINEL) break;

    if (roleChoice === RESET_SENTINEL) {
      // Clear all role keys, preserve non-role keys (theme)
      const preserved: Record<string, string> = {};
      for (const [k, v] of Object.entries(config)) {
        if (NON_ROLE_KEYS.has(k)) preserved[k] = v;
      }
      config = preserved;
      writeModelsConfig(modelsPath, config);
      changed.length = 0;
      changed.push("reset all");
      continue;
    }

    if (roleChoice === CADENCE_SENTINEL) {
      const cadenceItems: SelectItem[] = [
        { value: "turn", label: "turn", description: "journal every turn (2-min throttle)" },
        {
          value: "done",
          label: "done",
          description: "journal only at agent_end (one entry per run) (default)",
        },
        { value: "off", label: "off", description: "no journaling" },
        { value: BACK_SENTINEL, label: "(back)", description: "return to role list" },
      ];
      const cadenceChoice = await showModelSelector(
        ctx,
        cadenceItems,
        "journal cadence",
        config["journal-cadence"],
      );
      if (cadenceChoice && cadenceChoice !== BACK_SENTINEL) {
        config["journal-cadence"] = cadenceChoice;
        writeModelsConfig(modelsPath, config);
        changed.push(`journal-cadence → ${cadenceChoice}`);
      }
      continue;
    }

    // Role selected → show model picker
    const currentModelId = config[roleChoice];
    const modelItems = buildModelItems(availableModels, currentModelId);
    const modelChoice = await showModelSelector(ctx, modelItems, roleChoice, currentModelId);

    // BACK_SENTINEL or null (esc) → back to role list
    if (modelChoice === BACK_SENTINEL || modelChoice === null) continue;
    if (modelChoice === CLEAR_SENTINEL) {
      if (roleChoice in config) {
        delete config[roleChoice];
        writeModelsConfig(modelsPath, config);
        changed.push(`${roleChoice} cleared`);
      }
      continue;
    }

    // Real model selected → persist
    config[roleChoice] = modelChoice;
    writeModelsConfig(modelsPath, config);
    changed.push(`${roleChoice} → ${modelChoice}`);
  }

  if (changed.length === 0) return "No changes.";
  return `Updated .picode/models.json:\n  ${changed.join("\n  ")}`;
}
