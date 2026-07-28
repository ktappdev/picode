import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PicodeData } from "./types";

/** Worker subtypes that get specialized prompts. Any role not matching
 *  "coordinator" or a known subtype is treated as a generic worker. */
export type WorkerSubtype =
  "builder" | "reviewer" | "scout" | "designer" | "tester" | "bug-hunter" | "planner" | "runner";

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
 *  Placeholders: {{picodeId}}, {{displayRole}}, {{parentLine}}, {{roleBlock}} */
function buildCommunicationModel(
  picodeId: string,
  displayRole: string,
  parent: string | null,
  roleBlock: string,
): string {
  const parentLine = parent ? `, child of **${parent}**` : "";
  return COMMUNICATION_MODEL
    .replace("{{picodeId}}", picodeId)
    .replace("{{displayRole}}", displayRole)
    .replace("{{parentLine}}", parentLine)
    .replace("{{roleBlock}}", roleBlock);
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

    return buildCommunicationModel(picodeId, displayRole, parent, roleBlock);
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

  return buildCommunicationModel(picodeId, displayRole, parent, roleBlock);
}
