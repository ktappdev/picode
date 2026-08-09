import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PicodeData } from "./types";

/** Worker subtypes that get specialized prompts. Any role not matching
 *  "coordinator" or a known subtype is treated as a generic worker. */
export type WorkerSubtype =
  | "builder"
  | "reviewer"
  | "scout"
  | "designer"
  | "tester"
  | "bug-hunter"
  | "planner"
  | "runner"
  | "visionary";

function workerSubtype(role: string): WorkerSubtype | null {
  const subtypes: WorkerSubtype[] = [
    "builder",
    "reviewer",
    "scout",
    "designer",
    "tester",
    "bug-hunter",
    "planner",
    "runner",
    "visionary",
  ];
  return subtypes.includes(role as WorkerSubtype) ? (role as WorkerSubtype) : null;
}

// ── Prompt file loading ─────────────────────────────────────────────

/** Directory containing bundled prompt markdown files. */
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

/** Load a prompt markdown file from src/prompts/. Returns trimmed content. */
function loadPromptFile(filename: string): string {
  const filePath = join(PROMPTS_DIR, filename);
  return readFileSync(filePath, "utf-8").trim();
}

// Load all prompts once at module init
const COORDINATOR_RULES = loadPromptFile("coordinator.md");
const WORKER_BASE_RULES = loadPromptFile("worker-base.md");
const BUILDER_RULES = loadPromptFile("builder.md");
const REVIEWER_RULES = loadPromptFile("reviewer.md");
const SCOUT_RULES = loadPromptFile("scout.md");
const DESIGNER_RULES = loadPromptFile("designer.md");
const TESTER_RULES = loadPromptFile("tester.md");
const BUG_HUNTER_RULES = loadPromptFile("bug-hunter.md");
const PLANNER_RULES = loadPromptFile("planner.md");
const RUNNER_RULES = loadPromptFile("runner.md");
const VISIONARY_RULES = loadPromptFile("visionary.md");
const COMMUNICATION_MODEL = loadPromptFile("communication-model.md");

const SUBTYPE_PROMPTS: Record<WorkerSubtype, string> = {
  builder: BUILDER_RULES,
  reviewer: REVIEWER_RULES,
  scout: SCOUT_RULES,
  designer: DESIGNER_RULES,
  tester: TESTER_RULES,
  "bug-hunter": BUG_HUNTER_RULES,
  planner: PLANNER_RULES,
  runner: RUNNER_RULES,
  visionary: VISIONARY_RULES,
};

// ── Project-root resolution ────────────────────────────────────────

/** Walk up from cwd to the nearest git root; fall back to cwd if git
 *  is unavailable or the working directory isn't in a repo. */
function findProjectRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

/** All roles that can have a per-project prompt override.
 *  Any role NOT in this set falls back to `worker.md` when
 *  looking for an override file. */
const OVERRIDABLE_ROLES = new Set([
  "coordinator",
  "builder",
  "reviewer",
  "scout",
  "designer",
  "tester",
  "bug-hunter",
  "planner",
  "runner",
  "visionary",
  "worker",
]);

/** Return the contents of `<root>/.picode/prompts/<role>.md` if the file
 *  exists and is non-empty, otherwise null.
 *
 *  - Known roles (coordinator + worker subtypes) load their own file.
 *  - Unknown roles (generic workers) fall back to `worker.md`.
 *  - An empty file is treated as "no override" (null). */
function loadPromptOverride(role: string): string | null {
  const root = findProjectRoot();
  const resolvedRole = OVERRIDABLE_ROLES.has(role) ? role : "worker";
  const filePath = join(root, ".picode", "prompts", `${resolvedRole}.md`);

  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, "utf-8").trim();
  return raw.length > 0 ? raw : null;
}

/** Detect frontmatter `mode:` field in an override file.
 *  Returns "extend" (default) or "replace".
 *
 *  Example frontmatter:
 *  ```
 *  ---
 *  mode: replace
 *  ---
 *  ```
 *
 *  If no frontmatter or no `mode` field, defaults to "extend". */
function parseOverrideMode(override: string): "extend" | "replace" {
  const fmMatch = override.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!fmMatch) return "extend";
  const modeMatch = fmMatch[1].match(/^mode:\s*(\w+)/m);
  const mode = modeMatch?.[1]?.toLowerCase();
  return mode === "replace" ? "replace" : "extend";
}

/** Strip frontmatter from override content so it doesn't appear in the
 *  final prompt. */
function stripFrontmatter(override: string): string {
  return override.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "").trim();
}

/** Substitute placeholders in the communication model template.
 *  Placeholders: {{picodeId}}, {{displayRole}}, {{parentLine}}, {{roleBlock}}, {{journalGuidance}}
 *
 *  Journal guidance is role-aware: only the coordinator journals, so only it is
 *  told to recover context from the journal after a compaction. Workers get an
 *  explicit "journal off" note instead of stale "call picode_status for your
 *  journal" instructions — their journal file is always empty and reading it
 *  would waste a tool call. */
function buildCommunicationModel(
  picodeId: string,
  displayRole: string,
  parent: string | null,
  roleBlock: string,
  journalGuidance: string,
): string {
  const parentLine = parent ? `, child of **${parent}**` : "";
  return COMMUNICATION_MODEL.replace("{{picodeId}}", picodeId)
    .replace("{{displayRole}}", displayRole)
    .replace("{{parentLine}}", parentLine)
    .replace("{{roleBlock}}", roleBlock)
    .replace("{{journalGuidance}}", journalGuidance);
}

/** Role-appropriate journal recovery guidance.
 *  Coordinator: the journal is its memory of the project — tell it to recover
 *  context after compaction. Workers: journals are disabled (journalMode gate),
 *  so they must not be told to read one; their context is the task envelope and
 *  owed-reply ids from picode_status. */
function journalGuidanceFor(role: string): string {
  if (role === "coordinator") {
    return [
      "After a compaction, call picode_status to recover your identity, obligations, owed replies, and recent journal (last 15 entries by default as one-line summaries; use compact=false for full multi-line entries, or tail=0 for the full journal).",
      "You can also read another picode's journal with picode_journal(id) to check what a teammate has been doing before interrupting them.",
    ].join("\n");
  }
  return [
    "Your journal is disabled — you do not write one, and picode_status will show no journal for you.",
    "After a compaction, recover your context from the task envelope you received and picode_status's owed-reply ids — not from a journal.",
  ].join("\n");
}

// ── Main export ─────────────────────────────────────────────────────

export function threadModelPrompt(data: PicodeData): string {
  const { picodeId, parent, role } = data;
  const displayRole = role || "worker";

  // Try per-project override first
  const override = loadPromptOverride(role);
  if (override !== null) {
    const mode = parseOverrideMode(override);
    const overrideBody = stripFrontmatter(override);

    // Determine the bundled role block (used in extend mode)
    let bundledBlock = "";
    if (mode === "extend") {
      if (role === "coordinator") {
        bundledBlock = COORDINATOR_RULES;
      } else {
        const subtype = workerSubtype(role);
        bundledBlock = [WORKER_BASE_RULES, subtype ? SUBTYPE_PROMPTS[subtype] : ""]
          .filter(Boolean)
          .join("\n\n");
      }
    }

    // In extend mode: bundled rules first, then user override wrapped in a
    // clearly marked section so the model knows these take precedence.
    // In replace mode: override replaces bundled entirely (legacy behavior).
    const roleBlock =
      mode === "extend"
        ? bundledBlock +
          "\n\n---\n\n### Project-Specific Rules (USER-ENFORCED — these override bundled defaults)\n\n" +
          overrideBody
        : overrideBody;

    return buildCommunicationModel(
      picodeId,
      displayRole,
      parent,
      roleBlock,
      journalGuidanceFor(role),
    );
  }

  let roleBlock = "";
  if (role === "coordinator") {
    roleBlock = COORDINATOR_RULES;
  } else {
    const subtype = workerSubtype(role);
    roleBlock = [WORKER_BASE_RULES, subtype ? SUBTYPE_PROMPTS[subtype] : ""]
      .filter(Boolean)
      .join("\n\n");
  }

  return buildCommunicationModel(
    picodeId,
    displayRole,
    parent,
    roleBlock,
    journalGuidanceFor(role),
  );
}
