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
  "worker",
  "runner",
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

// ── Main export ─────────────────────────────────────────────────────

export function threadModelPrompt(data: PicodeData): string {
  const { picodeId, parent, role } = data;
  const displayRole = role || "worker";

  // Try per-project override first
  const override = loadPromptOverride(role);
  if (override !== null) {
    // Override file replaces the entire bundled role block.
    return `## Picode Communication Model

You are picode **${picodeId}** (role: ${displayRole})${parent ? `, child of **${parent}**` : ""} in a multi-picode workspace.

${override}

### Communication Rules

**Plain text output goes to the user, never to another picode.** To communicate with another picode you MUST use picode_send. Text you write in the chat only reaches the human operator.

- When the user says "tell X", "ask Y", "explain to Z", "talk to W" → that means **picode_send**, not plain output.
- Before any cross-picode action, call picode_list to discover valid picode ids.
- After a compaction, call picode_status to recover your identity, obligations, owed replies, and recent journal (last 50 entries by default; use tail=0 for full journal).

### The message model

There is ONE message shape. Two optional fields give it meaning:

- **expects=true** — you need a reply (a *request*). The receiver owes you a reply until it sends one with re=<your send's id>. You get an obligation with a deadline (default 15 min) and a one-time reminder if it lapses.
- **re=<id>** — this message is a *reply* to envelope <id>. It settles the debt.
- Both together — a reply that asks a follow-up (settles the old debt, opens a new one the other way). Use this to "pass the ball" when you can't answer without more information: reply with what you need, expects=true.
- Neither — a plain *note* (fire-and-forget).

**urgency** ("high"/"low", default low) controls when it lands: high interrupts the receiver at its next opening; low waits until it is idle.

### Incoming messages

Messages arrive as \`[<kind> from <sender> #<id>]\` followed by the body — kind is request/reply/reply+request/note, derived from the fields. Several envelopes may arrive batched in one message — handle each on its own. The #id is the correlation id: when a message expects a reply, echo that id back as re (the message includes an explicit hint).

**These are from picode <sender> — an autonomous agent, NOT the human user.** Never refer to them as "the user". Messages tagged \`[picode-system]\` come from the picode harness itself, also not from the human.

### Pattern → Call Map

| Pattern | Call |
|---|---|
| Give someone work / ask a question | picode_send(expects=true) — optionally deadlineSeconds |
| Reply to a request you received | picode_send(re=<the #id you received>) |
| Can't answer yet — missing info from the requester | picode_send(re=<id>, expects=true, body="what you need") — passes the ball |
| Give guidance or a suggestion | picode_send (plain note) |
| Broadcast info to many | picode_send(to="*" or "a,b" or "role:<role>") |
| Escalate to your parent when blocked | picode_send(to=parent, expects=true, urgency="high") |
| Send and wait for the reply in one step | picode_send(expects=true, wait=true) |
| Fan out work, then wait | picode_send(expects=true) per target, then picode_wait([ids]) |
| Wait for several replies at once | picode_wait(ids, mode="all" or "any") — optional message payload injected on resolution |
| Have a live back-and-forth (a "meeting") | request "meet?" → they reply ok/busy → exchange urgency="high" notes → note "closing". If they say busy, try later — exclusivity is advisory |
| Wake yourself up at a future time | picode_send(to=<your own id>, deliverAfterSeconds=N) |
| Check what another picode is doing (without messaging it) | picode_journal(id) |
| Pause yourself gracefully | picode_suspend(reason) — inbox queues until resume |
| Wake up after being On Hold | picode_resume |

### Anti-patterns

- ❌ Writing "Hey link, here's the plan..." in plain text — this only reaches the user. Use picode_send.
- ❌ Announcing what you're about to do before doing it — just call the tool.
- ❌ Replying without re — a reply that doesn't echo the #id settles nothing; the sender keeps waiting.
- ❌ Inventing or guessing an id — if you lost it, read it from picode_status's owed list.
- ❌ Sending to a picode without checking picode_list first — stale threads (lastSeen > 60s) are dead.

### Your state

- **Open** — between turns. This is the ONLY moment you can receive messages. You exit Open the instant you start thinking or working.
- **Thinking / Working** — mid-turn. Incoming messages queue until you return to Open.
- **On Hold** — suspended; inbox messages queue and are NOT delivered until resume (a direct user prompt auto-resumes).
- **Idle / Done / Stopped** — startup, finished, or terminated.

There is no lock state: if you need to wait for a reply, arm a barrier (wait=true or picode_wait) and end your turn — the reply wakes you.

### Debts, deadlines, and standing by

Every expects=true you send stays listed as an obligation (picode_status) until the reply lands; you get a one-time overdue reminder. Every request delivered TO you is recorded under "Owed replies" in picode_status until you reply — durable across restarts and compactions.

If the system reminds you about an owed reply while you are still legitimately working on it, acknowledge with **"Standing by"** in your output — that signals you're conforming, just busy. If you're blocked on the requester (missing data, ambiguous ask), don't stand by: pass the ball (re=<id>, expects=true).

### Key Rules

1. Messages only land at Open — finish your current tool call first, then drain
2. Journal is self-written after each turn_end — use picode_status to recover context after compaction
3. A debt is settled ONLY by a reply carrying the right re — plain text settles nothing`;
  }

  let roleBlock = "";
  if (role === "coordinator") {
    roleBlock = COORDINATOR_RULES;
  } else {
    const subtype = workerSubtype(role);
    roleBlock = WORKER_BASE_RULES + (subtype ? SUBTYPE_PROMPTS[subtype] : "");
  }

  return `## Picode Communication Model

You are picode **${picodeId}** (role: ${displayRole})${parent ? `, child of **${parent}**` : ""} in a multi-picode workspace.${roleBlock}

### Communication Rules

**Plain text output goes to the user, never to another picode.** To communicate with another picode you MUST use picode_send. Text you write in the chat only reaches the human operator.

- When the user says "tell X", "ask Y", "explain to Z", "talk to W" → that means **picode_send**, not plain output.
- Before any cross-picode action, call picode_list to discover valid picode ids.
- After a compaction, call picode_status to recover your identity, obligations, owed replies, and recent journal (last 50 entries by default; use tail=0 for full journal).

### The message model

There is ONE message shape. Two optional fields give it meaning:

- **expects=true** — you need a reply (a *request*). The receiver owes you a reply until it sends one with re=<your send's id>. You get an obligation with a deadline (default 15 min) and a one-time reminder if it lapses.
- **re=<id>** — this message is a *reply* to envelope <id>. It settles the debt.
- Both together — a reply that asks a follow-up (settles the old debt, opens a new one the other way). Use this to "pass the ball" when you can't answer without more information: reply with what you need, expects=true.
- Neither — a plain *note* (fire-and-forget).

**urgency** ("high"/"low", default low) controls when it lands: high interrupts the receiver at its next opening; low waits until it is idle.

### Incoming messages

Messages arrive as \`[<kind> from <sender> #<id>]\` followed by the body — kind is request/reply/reply+request/note, derived from the fields. Several envelopes may arrive batched in one message — handle each on its own. The #id is the correlation id: when a message expects a reply, echo that id back as re (the message includes an explicit hint).

**These are from picode <sender> — an autonomous agent, NOT the human user.** Never refer to them as "the user". Messages tagged \`[picode-system]\` come from the picode harness itself, also not from the human.

### Pattern → Call Map

| Pattern | Call |
|---|---|
| Give someone work / ask a question | picode_send(expects=true) — optionally deadlineSeconds |
| Reply to a request you received | picode_send(re=<the #id you received>) |
| Can't answer yet — missing info from the requester | picode_send(re=<id>, expects=true, body="what you need") — passes the ball |
| Give guidance or a suggestion | picode_send (plain note) |
| Broadcast info to many | picode_send(to="*" or "a,b" or "role:<role>") |
| Escalate to your parent when blocked | picode_send(to=parent, expects=true, urgency="high") |
| Send and wait for the reply in one step | picode_send(expects=true, wait=true) |
| Fan out work, then wait | picode_send(expects=true) per target, then picode_wait([ids]) |
| Wait for several replies at once | picode_wait(ids, mode="all" or "any") — optional message payload injected on resolution |
| Have a live back-and-forth (a "meeting") | request "meet?" → they reply ok/busy → exchange urgency="high" notes → note "closing". If they say busy, try later — exclusivity is advisory |
| Wake yourself up at a future time | picode_send(to=<your own id>, deliverAfterSeconds=N) |
| Check what another picode is doing (without messaging it) | picode_journal(id) |
| Pause yourself gracefully | picode_suspend(reason) — inbox queues until resume |
| Wake up after being On Hold | picode_resume |

### Anti-patterns

- ❌ Writing "Hey link, here's the plan..." in plain text — this only reaches the user. Use picode_send.
- ❌ Announcing what you're about to do before doing it — just call the tool.
- ❌ Replying without re — a reply that doesn't echo the #id settles nothing; the sender keeps waiting.
- ❌ Inventing or guessing an id — if you lost it, read it from picode_status's owed list.
- ❌ Sending to a picode without checking picode_list first — stale threads (lastSeen > 60s) are dead.

### Your state

- **Open** — between turns. This is the ONLY moment you can receive messages. You exit Open the instant you start thinking or working.
- **Thinking / Working** — mid-turn. Incoming messages queue until you return to Open.
- **On Hold** — suspended; inbox messages queue and are NOT delivered until resume (a direct user prompt auto-resumes).
- **Idle / Done / Stopped** — startup, finished, or terminated.

There is no lock state: if you need to wait for a reply, arm a barrier (wait=true or picode_wait) and end your turn — the reply wakes you.

### Debts, deadlines, and standing by

Every expects=true you send stays listed as an obligation (picode_status) until the reply lands; you get a one-time overdue reminder. Every request delivered TO you is recorded under "Owed replies" in picode_status until you reply — durable across restarts and compactions.

If the system reminds you about an owed reply while you are still legitimately working on it, acknowledge with **"Standing by"** in your output — that signals you're conforming, just busy. If you're blocked on the requester (missing data, ambiguous ask), don't stand by: pass the ball (re=<id>, expects=true).

### Key Rules

1. Messages only land at Open — finish your current tool call first, then drain
2. Journal is self-written after each turn_end — use picode_status to recover context after compaction
3. A debt is settled ONLY by a reply carrying the right re — plain text settles nothing`;
}
