# Picode + Herdr

**Herdr gives your coding agents a place to run. Picode gives those agents a way to work together.** Together, they turn a set of independent [Pi](https://github.com/earendil-works/pi-coding-agent) sessions into a coordinated team: a Picode coordinator assigns work, Herdr launches and manages worker panes, and the workers report back through durable Picode mailboxes.

Picode is designed to work **fully with [Herdr](https://herdr.dev/)**. Herdr handles the live runtime—workspaces, tabs, panes, agent status, and session recovery. Picode handles team coordination—roles, task messages, reply tracking, journals, and handoffs. Each tool has a distinct job; together they let you delegate across agents without losing the work or the conversation.

**Start here:** [Install Herdr](https://herdr.dev/docs/install/) · [Install Picode](#install) · [How the integration works](#how-picode-and-herdr-work-together)

## The relationship: Herdr runs the team; Picode coordinates it

|                                          | Herdr                                                                                                    | Picode                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Owns**                                 | Agent runtime and terminal layout: workspaces, tabs, panes, process/session lifecycle, and agent status. | Cross-agent collaboration: identities and roles, durable messages, reply obligations, journals, and task handoffs. |
| **When the coordinator delegates**       | Creates or reuses a worker pane, launches Pi, and keeps the worker visible and manageable.               | Chooses the worker role, sends its task, tracks the reply, and preserves coordination state across restarts.       |
| **When a worker finishes or gets stuck** | Reports pane/agent lifecycle and exposes the worker's terminal and session.                              | Records the worker's report and handoff; lets the coordinator inspect or recover the work.                         |

Herdr is not a replacement for Picode's mailboxes, and Picode is not a terminal multiplexer. Herdr controls **where and when agents run**; Picode controls **how they communicate and coordinate**. Worker panes remain ordinary Herdr-managed Pi sessions, with their own session histories and Picode identities.

## What you get

- A Herdr-managed coordinator that delegates work without writing project files itself.
- Workers launched into Herdr panes, automatically assigned roles such as `builder`, `reviewer`, or `explorer`.
- Durable Picode messages with correlated replies, so a worker's response is not just transient terminal text.
- Herdr-aware pane and tab management: reuse workers, open tabs when a tab is full, inspect pane output, and clean up stale panes.
- Worker journals and handoff notes that help the coordinator continue work across turns and sessions.
- A human CLI and slash commands for monitoring and steering the team.

## Install

For the full, supported Picode + Herdr workflow, install both tools and the Pi integration:

1. **Install Herdr** using the [official installation guide](https://herdr.dev/docs/install/). On macOS or Linux:
   ```bash
   curl -fsSL https://herdr.dev/install.sh | sh
   ```
   Windows instructions and other installation methods are in the [Herdr install docs](https://herdr.dev/docs/install/).
2. **Install Pi** and make sure an LLM provider is configured:
   ```bash
   npm install -g @earendil-works/pi-coding-agent
   ```
   Pi supports providers including [OpenRouter](https://openrouter.ai/), Anthropic, OpenAI, Google, and local Ollama models. For example, configure an OpenRouter key with `export OPENROUTER_API_KEY=sk-or-...`.
3. **Install Herdr's Pi integration.** It reports Pi session identity and lifecycle to Herdr, and allows Herdr to restore Pi sessions after a Herdr server restart:
   ```bash
   herdr integration install pi
   ```
   See Herdr's [Pi integration documentation](https://herdr.dev/docs/integrations/).
4. **Install Picode into Pi:**
   ```bash
   pi install git:github.com/ktappdev/picode@main
   ```
5. **Start Herdr**, open a pane in your project, and start the coordinator there. Use `picode coordinator` if you set up the optional shortcut below, or `pi --picode-id coordinator` otherwise. The coordinator can now use Herdr to start and manage its worker panes. See [Quick start](#quick-start).

**Requirements:** Node.js 20 or newer and a configured LLM provider. Docker is only needed for the optional Restate backend. Herdr is required for automatic coordinator-managed worker orchestration; without Herdr, Picode's messaging protocol and manual worker workflows are still available, but Herdr pane/tab tools and automatic spawning are not.

### Optional: `picode` shell shortcut

Picode does not edit your shell configuration or create aliases automatically. To type `picode coordinator` instead of `pi --picode-id coordinator`, add a shortcut to your shell profile.

For Bash or Zsh, add this line to `~/.bashrc` or `~/.zshrc`:

```bash
alias picode='pi --picode-id'
```

Then reopen the terminal (or reload the profile with `source ~/.bashrc` / `source ~/.zshrc`). For PowerShell, add this function to the profile shown by `$PROFILE`:

```powershell
function picode { pi --picode-id @args }
```

Without the shortcut, use the full `pi --picode-id <name>` command shown in the examples.

### Optional: Hypa

[Hypa](https://github.com/earendil-works/hypa) is a Pi extension that compresses file lookup output and helps scouts and explorers keep their context lean. Picode works without it:

```bash
pi install git:github.com/earendil-works/hypa@main
```

## Quick start

Run Pi inside a Herdr pane. Start one session as the coordinator:

```bash
picode coordinator
# Without the optional shell shortcut: pi --picode-id coordinator
```

The coordinator is the command center. Describe the work; it delegates to workers through Picode and Herdr. Workers are launched as separate Pi sessions in Herdr-managed panes, with a Picode identity and role. You do not need to manually open a terminal for each worker.

To start a worker manually instead, open another Herdr pane in the same project and give it its own identity:

```bash
picode builder
# Without the optional shell shortcut: pi --picode-id builder
```

Other examples include `reviewer`, `explorer`, and `visionary` (the latter needs a multimodal model). Names such as `builder-1` and `reviewer-a` inherit their role from the prefix; other names become generic workers.

Picode is opt-in: a Pi session becomes a picode only when started with `--picode-id` (or resumed from a session that already has a Picode identity). All Picode sessions in the same working directory share coordination data under `.picode/`.

## How Picode and Herdr work together

1. **You start a coordinator in Herdr.** Picode detects the Herdr pane identity and enables its Herdr-aware coordinator tools.
2. **The coordinator dispatches a task.** Picode selects a role and creates a durable task message; its `spawn_worker` tool asks Herdr to reuse a suitable pane or create a worker pane, then launches Pi with the worker's Picode identity.
3. **Herdr manages the running worker.** It owns the pane and session lifecycle. Picode labels the pane with the worker's role, tracks relevant worker panes, and can react to pane-exit events.
4. **The worker reports through Picode.** The worker sends its result to the coordinator using `picode_send` / `picode_finish`. Messages, outstanding replies, journals, and handoff notes live in the project’s Picode data—not in Herdr’s terminal output.
5. **The coordinator follows up.** It can check Herdr pane status/output, reuse or revive a worker when appropriate, and clean up stale worker panes. Picode's durable state lets coordination survive individual Pi turns and process restarts.

This division is important: **Herdr's agent status is not the same as a Picode reply.** A pane can be idle or done without having sent its required message. Picode tracks the reply obligation separately and can inspect the Herdr pane when a worker goes silent.

By default, Picode stores mailboxes and coordination state in local files under `.picode/`; it needs no message broker. The optional Restate backend can wake stopped picodes, while Herdr continues to manage their agent panes. The protocol (Postbox) is specified in [THREAD-MODEL.md](THREAD-MODEL.md).

### Runtime notes

Picode detects Herdr automatically when Pi runs inside a Herdr-managed pane. Set `PICODE_RUNTIME=herdr` if you want startup to fail unless that Herdr context is present; the default is `auto`. Picode remains useful outside Herdr for messaging and manually started workers, but **automatic worker spawning, pane/tab operations, pane inspection, and Herdr lifecycle events require Herdr**.

To try Picode without installing it, use Pi's extension option:

```bash
pi -e git:github.com/ktappdev/picode@main --picode-id my-picode
```

The extension does nothing to a session that has not opted in with a Picode identity.

## The message model

There is only one message shape: the envelope. Two optional fields give it meaning.

```
Envelope {
  id            its own identity, minted per send, looks like <from>/<ulid>
  from, to      sender and target picode names
  body          the content
  sentAt        ISO-8601 timestamp
  re?           reply correlation: settles the debt on that envelope id
  expects?      true means the sender needs a reply, tracked until one arrives
  urgency?      "high" interrupts at the next opening, "low" waits until idle
  deliverAfter? not deliverable before this instant
  expiresAt?    not deliverable after this instant
}
```

Here is how it reads in practice:

- `expects: true` makes a **request**. The receiver records an owed reply. The sender records an obligation with a deadline (15 minutes by default) and gets a one-time nudge if it is not answered in time.
- `re: <id>` makes a **reply**. It settles the debt.
- Both together is a reply that asks a follow-up, useful when you can't answer without more information.
- Neither is a plain **note**.

There are no message types on the wire and no locks. If a picode wants to block on a reply, it arms a barrier (with `wait=true` or `picode_wait`) and ends its turn. The reply wakes it. A scheduled self-wake is just an envelope to your own name with `deliverAfter`.

Messages show up as `[<kind> from <sender> #<id>]`. The kind (request, reply, reply+request, or note) is derived from the fields, and requests carry the id you should echo back as `re`.

## Tools the model can use

| Tool                | Purpose                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `picode_send`       | Send an envelope to one name, `a,b`, `*`, or `role:<role>`. Supports `expects`, `re`, `urgency`, `deliverAfterSeconds`, `wait=true` to arm a barrier inline.                                      |
| `picode_wait`       | Wait for all or any of several outstanding replies (a barrier). Accepts `deadlineSeconds` and an optional `message` injected on resolution.                                                       |
| `picode_status`     | Read this picode's state, obligations, owed replies, barriers, and journal.                                                                                                                       |
| `picode_list`       | List all known threads in the workspace. `recent=true` adds the recent-workers digest (exact ids, derived areas, context age, what each left unverified) — use it before `revive_closed_session`. |
| `picode_journal`    | Read another picode's journal, filtered by `tail` or `lookbackMinutes`.                                                                                                                           |
| `picode_suspend`    | Mark this picode On Hold. The inbox queues until resume.                                                                                                                                          |
| `picode_resume`     | Resume from On Hold and drain queued messages.                                                                                                                                                    |
| `picode_panes`      | Survey panes/windows in the current runtime scope: status, role, and cleanup suggestions. Read-only surveillance.                                                                                 |
| `picode_pane_read`  | Read a worker pane's terminal output (scrollback). Use for silent worker recovery — when a worker owes a reply but hasn't sent via picode_send.                                                   |
| `spawn_worker`      | Spawn a new worker pane: splits, names, launches pi, waits for idle. Auto-reuses idle workers, claims empty panes, grid-aware split direction. Optional `tab` param for multi-tab spawning.       |
| `picode_tab_create` | Open a Herdr tab. Coordinator-only.                                                                                                                                                               |
| `picode_tab_close`  | Close a Herdr tab. Refuses working or coordinator panes. Coordinator-only.                                                                                                                        |
| `cleanup_panes`     | Close known stale worker panes in the current runtime scope. `dry_run=true` previews; `pane_id="<id>"` targets one; `force=true` permits idle workers.                                            |
| `picode_purge`      | Delete stale picode data directories. Default skips local debts and coordinator references; `force=true` also reconciles this picode's ledgers.                                                   |

## Slash commands for humans

| Command                    | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `/picode-status`           | Show state and the latest journal entry.             |
| `/picode-list`             | List all known threads.                              |
| `/picode-send <to> <body>` | Send a high-urgency note to another picode.          |
| `/picode-suspend`          | Mark On Hold.                                        |
| `/picode-resume`           | Resume from On Hold.                                 |
| `/picode-models`           | Show, set, or reset per-role worker model config.    |
| `/picode-thinking`         | Show, set, or reset per-role worker thinking levels. |
| `/picode-journal`          | View, trim, clear, or compact the journal.           |
| `/picode-quiet`            | Toggle the quiet operator screen (display only).     |

`/picode-quiet` hides picode's traffic rows — envelope batches, system prompts, and quiet-tool call rows — without changing behavior: messages, obligations, journal, status, and the model's context are untouched. High-urgency (⚠) envelopes stay visible, and expanding any row still shows it. Usage: `/picode-quiet [on | off | status] [--project]`. The saved setting resolves `PICODE_QUIET_TUI=1|0` env → project `<git-root>/.picode/quiet-tui.json` → global `~/.pi/agent/.picode/quiet-tui.json` → loud (default).

## Worker roles

Each picode has a role that shapes its system prompt. The role is auto-detected from the name you give it.

| Role                 | Subtype | Description                                                                                                                                                                           |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coordinator`        | -       | Directs workers, delegates tasks, keeps project context. Cannot write, edit, or run bash. Uses Hypa tools for quick lookups when installed.                                           |
| `builder`            | Worker  | Implements code changes, edits files, runs type checks.                                                                                                                               |
| `reviewer`           | Worker  | Reviews diffs, audits for bugs, security, and quality. Read-only.                                                                                                                     |
| `scout` / `explorer` | Worker  | Explores the codebase, finds files, answers architecture questions. Read-only. Summarizes findings instead of dumping raw output.                                                     |
| `bug-hunter`         | Worker  | Hunts bugs by reading code, session entries, and journals. Reports root cause and a suggested fix but does not implement it. Read-only.                                               |
| `tester`             | Worker  | Writes and runs tests, reproduces bugs, checks coverage.                                                                                                                              |
| `designer`           | Worker  | Designs and implements frontend UI. Reads existing frontend patterns, keeps scope to UI work, and reports any required cross-layer changes.                                           |
| `visionary`          | Worker  | Reads attached or local images and reports grounded observations. Read-only; requires a multimodal model.                                                                             |
| `gauntlet`           | Worker  | Adversarial production hardener with split personalities (review → fix → test). Finds realistic production failures, fixes them, leaves regression tests. Full tools except dispatch. |

UI work can route directly to `designer`: it reads the existing frontend, designs and implements its own UI plan. Use `reviewer` only when risk or diff size warrants a narrow functional-preservation audit; reviewer checks that existing behavior still works, not visual direction. Use `planner` or `builder` when the change is complex, cross-cutting, or explicitly split into design and implementation.

Prefix matching means `builder-1`, `builder-a`, `builder_foo`, and `builder.task` all resolve to the `builder` role. Any name that does not match a known role (or prefix) becomes a generic `worker` with base worker rules only.

### The communication contract

Workers reply to the coordinator only through `picode_send`. Plain text typed in a worker's pane reaches the human user, not the coordinator. If a worker answers in plain text, the coordinator never sees it and the human has to relay it. This contract is built into every worker prompt.

If a worker goes silent (no `picode_send` reply within about 10 minutes), the coordinator's recovery rule kicks in: read the worker's pane output, find the plain-text reply, and either accept it or resend the request while reminding the worker to use `picode_send`.

## Coordinator mode

When a picode has the `coordinator` role (auto-detected from the name `coordinator`):

- **Write, edit, and bash are disabled.** The coordinator cannot run shell commands or modify files. Quick targeted lookups (single grep, read known file path) go through [Hypa](https://github.com/earendil-works/hypa) tools when installed. Anything deeper — multi-file exploration, git operations, herdr commands — goes through workers via `spawn_worker` or `picode_send`.
- **Herdr-native orchestration.** The coordinator uses Herdr to create and reuse worker panes, open tabs when needed, inspect output and lifecycle, and clean up stale workers. Picode handles roles, task messages, reply obligations, and handoffs; Herdr handles the live agent runtime. See [How Picode and Herdr work together](#how-picode-and-herdr-work-together).
- **Reuses panes.** It checks existing panes first and reuses idle or done workers instead of spawning duplicates.
- **Adaptive layout.** Workers split in the direction that keeps new panes close to square. Grid-aware splitting avoids tall stacks. Empty panes are claimed instead of splitting. The coordinator stays at 50 percent on the left and the worker area fills the right half.
- **Structured dispatch.** Tasks go out as Objective, Context, Constraints, Action Steps, Deliverables, and Prerequisites.
- **Recall Round Table.** For ambiguous decisions, `picode_round_table` resumes one exact stopped worker as a read-only consultation. It can use retained context only, replies with a contribution or `PASS`, and shuts down immediately. Recall records are local to `.picode/recall-sessions.json`; they require the same host and saved Pi session file, including when Picode uses Restate for mail storage.
- **Revivable workers.** Worker prompts carry a **Recent workers** digest: the last few workers, the directories each one actually touched (derived from its saved session, not self-reported), whether it is still live, and what it left unverified. When new work lands in territory a stopped worker already mapped, the coordinator can bring that same agent back on duty with `revive_closed_session(picode_id, task)` — full tools, its journal, its mailbox, and its own conversation context intact — instead of starting a fresh worker cold. It is deliberately harder to reach for than `spawn_worker`: a task is required, and the result reports how stale the revived context is (`context_age_minutes`, `head_moved_since_exit`), because a worker resuming an outdated view of the tree will edit confidently and wrongly. One at a time, never in parallel.
- **Worker handoff notes.** Workers close an assigned task with `picode_finish` rather than a plain "done" send: one call records a durable handoff (what landed, what was left unverified) and sends the final report. The note lives at `.picode/picodes/<id>/handoff.json` and is written by the worker, never the coordinator — it knows what actually happened, whereas the coordinator only knows what it asked for. A worker whose pane was killed leaves no note, and still appears in the ledger.
- **Self-improving.** When the coordinator finds a gap in its own rules, it writes the fix to a per-project prompt override file.

## Worker models

Model defaults live globally at `~/.pi/agent/.picode/models.json`. Optional project overrides live at `<git-root>/.picode/models.json`.

```json
{
  "builder": "anthropic/claude-sonnet-4",
  "reviewer": "anthropic/claude-haiku-4",
  "explorer": "anthropic/claude-haiku-4",
  "visionary": "opencode-go/mimo-v2.5",
  "default": "anthropic/claude-sonnet-4",
  "journal": "deepseek/deepseek-v4-flash",
  "journal-cadence": "done"
}
```

Resolution order: **project role/default → global role/default → built-in role/default**. Project files are sparse; setting only `scout` leaves every other role inherited. Existing project files remain project overrides until reset.

- Roles match by prefix, so a `builder` key matches `builder-1` and `builder-a`.
- It falls back to the `default` key, then to the built-in default model.
- The coordinator reads the merged config and passes the resolved model to each spawned worker.
- `visionary` must point to a multimodal model; do not leave it on a text-only `default` model.
- `"journal"` sets the model for journal fork entries. If unset, inherits the picode's own model — use a cheap model to avoid quota/balance errors on the coordinator's model.
- `"journal-cadence"` sets the journal cadence: `"turn"`, `"done"` (default), or `"off"`.
- `/picode-models` asks whether to edit global defaults or project overrides.

| Command                                            | Effect                                     |
| -------------------------------------------------- | ------------------------------------------ |
| `/picode-models`                                   | Choose scope, then open selector.          |
| `/picode-models builder anthropic/claude-sonnet-4` | Set project override (legacy behavior).    |
| `/picode-models --global builder MODEL`            | Set one global default.                    |
| `/picode-models --project scout MODEL`             | Set one project-only override.             |
| `/picode-models --project --reset`                 | Remove project overrides; inherit global.  |
| `/picode-models --global --reset`                  | Clear global overrides; restore built-ins. |

## Worker thinking levels

Thinking levels are configured separately from worker models. Global defaults live at `~/.pi/agent/.picode/thinking.json`; optional project overrides live at `<git-root>/.picode/thinking.json`. The built-in role defaults are preserved unless overridden: builder/reviewer/bug-hunter `high`, planner/designer/gauntlet `max`, scout/explorer/visionary `medium`, tester/runner `low`. Other roles inherit Pi's default. Pi clamps a requested level to the maximum supported by the selected model.

Supported levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

| Command                                 | Effect                                                              |
| --------------------------------------- | ------------------------------------------------------------------- |
| `/picode-thinking`                      | Show effective levels, with project → global → built-in precedence. |
| `/picode-thinking builder low`          | Set the project override for builder.                               |
| `/picode-thinking --global builder max` | Set a global default.                                               |
| `/picode-thinking --project scout high` | Set a project-only override.                                        |
| `/picode-thinking --project --reset`    | Remove project overrides; inherit global/default levels.            |
| `/picode-thinking --global --reset`     | Clear global overrides; restore built-ins.                          |

Role names match by prefix, so `builder` applies to `builder-1` and `builder-a`.

## Customizing prompts

Each role's system prompt ships as a bundled default in `src/core/system-prompt.ts`. You can extend or replace a role's prompt with a markdown file in your project. No code changes and no reinstall needed.

Create `.picode/prompts/<role>.md` at your project root (the git repo root, or the cwd if you are not in a repo):

```
.picode/
  prompts/
    coordinator.md   # extends or replaces the coordinator rules
    builder.md       # extends or replaces the builder rules
    reviewer.md      # extends or replaces the reviewer rules
    visionary.md     # extends or replaces the visual-analysis rules
    worker.md        # catch-all for any generic worker role
```

### Extend mode (default)

Your override file is **appended after** the bundled role prompt, wrapped in a `### Project-Specific Rules (USER-ENFORCED)` section. Bundled rules stay active; your rules take precedence. This is the default — no frontmatter needed.

### Replace mode

Add frontmatter to fully swap the bundled prompt (legacy behavior):

```
---
mode: replace
---

Your custom prompt content here...
```

### Notes

- Empty files are ignored, so you get the bundled default.
- Unknown roles fall back to `worker.md`.
- Prompts are loaded once at startup. Restart the picode after editing.
- When a coordinator discovers a gap in its rules during operation, it writes to these override files rather than to the extension source. Those changes survive reinstalls and are safe to commit to your project.

Sample overrides to copy live in [`examples/prompts/`](examples/prompts/).

## The journal

The coordinator keeps a journal: a forked model call that summarizes its state. Workers don't journal — their context is the task envelope, and nobody reads a worker's journal. Runs in the background, never interrupts work.

- **Cadence control.** Default is `done` — one entry per run at agent_end. Set to `turn` for one entry per turn (rate-limited to one per two minutes on same-task turns), or `off` to disable. Configure via `/picode-models` → `(journal cadence)`, `--picode-journal <turn|done|off>`, or the `"journal-cadence"` key in either global or project `models.json`.
- **Journal model.** The model used for journal forks. Set via `/picode-models` → `journal`, `--picode-journal-model <model>`, or the `"journal"` key in either global or project `models.json`. If unset, inherits the picode's own model — which can fail (e.g. 402 balance errors) if that model is out of quota. Fresh installs default to a cheap model (`deepseek/deepseek-v4-flash`).
- **Compaction.** When the journal passes 200 entries, the oldest ones are summarized into a single block, keeping the most recent 50 verbatim. There is a 24-hour cooldown between compactions.
- **Duplicate suppression.** An entry is skipped when its Working on or Done line matches the previous one.

Manage it through the slash command:

| Subcommand                | Effect                                                    |
| ------------------------- | --------------------------------------------------------- |
| `/picode-journal`         | Show the last 12 entries.                                 |
| `/picode-journal tail N`  | Show the last N entries.                                  |
| `/picode-journal status`  | Entry count, file size, oldest and newest timestamps.     |
| `/picode-journal trim N`  | Keep only the last N entries.                             |
| `/picode-journal clear`   | Delete the journal file.                                  |
| `/picode-journal compact` | Force compaction now, even under the 200-entry threshold. |

## Prompt-cache diagnostics

Active Picode sessions write a local trace to `.picode/cache-diagnostics/`. It records prompt-component and request-body fingerprints plus provider usage counters (input, cache-read, cache-write, and reported cost), never prompt text, message text, tool descriptions, or worker notes. Traces are bounded to about 1 MB per picode.

When provider usage indicates a cache miss larger than Pi's 1,024-token noise floor, Picode warns whether its prompt changed since the previous request (for example, the worker digest) or stayed unchanged. A changed fingerprint is a correlation, not proof of provider causation; an unchanged Picode prompt points toward cache retention, session/model changes, or another extension. Traces mark whether the preceding cache request was an assistant response or Pi's cache warmer, including the warm request's reported cost when available. The warning includes the trace path for follow-up.

On Pi versions with structured system-prompt sections, Picode stores its thread rules as a transcript-backed section so custom-message-triggered turns retain the same rules. Older Pi versions keep the existing per-run prompt override behavior.

See [CACHE-DIAGNOSTICS.md](CACHE-DIAGNOSTICS.md) for the runbook: what the trace fields mean, how to read a miss, what the tracker cannot prove, and the experiment that settles whether a miss comes from prompt content or from a new provider cache key.

## Human monitoring and steering

`bin/picode-cli.mjs` lets a human act on the picode system without running pi. It is a full protocol citizen working over plain files.

```bash
node bin/picode-cli.mjs list                      # table of all threads
node bin/picode-cli.mjs status link               # one picode's full coordination state
node bin/picode-cli.mjs status link --json        # same, as machine-readable JSON
node bin/picode-cli.mjs watch                     # live coordination board
node bin/picode-cli.mjs tail link                 # follow one picode's state, journal, and messages
node bin/picode-cli.mjs inbox link                # pending and recent messages
node bin/picode-cli.mjs send link "status?" --expects       # ask, tracked
node bin/picode-cli.mjs send link "looks good" --re link/01ABC…  # reply, settles the debt
node bin/picode-cli.mjs send '*' "standup in 5"   # broadcast note
node bin/picode-cli.mjs delete link               # remove a picode (refuses if it looks live)
node bin/picode-cli.mjs delete --stale --yes      # prune every stopped or stale picode
```

## Connecting other coding agents (MCP)

`bin/postbox-mcp.mjs` is a zero-dependency MCP (Model Context Protocol) stdio server. Point any MCP-capable agent at it and that agent becomes a full Postbox picode over plain files, speaking the same `.picode/picodes/<id>/` layout that pi and `picode-cli` use. A Claude Code or Codex session can then send, receive, and settle reply debts with pi threads and each other, with no pi process required on its side.

It exposes the six protocol tools (`picode_send`, `picode_inbox`, `picode_wait`, `picode_status`, `picode_list`, `picode_journal`) and keeps the sending agent's presence and obligation ledger in `state.json`. Identity comes from environment variables: `POSTBOX_THREAD_ID` (required), `POSTBOX_DIR` (workspace root, defaults to cwd), and optional `POSTBOX_ROLE` or `POSTBOX_PARENT`.

Register it with Claude Code:

```bash
claude mcp add postbox -e POSTBOX_THREAD_ID=cc-1 -- node /path/to/picode/bin/postbox-mcp.mjs
```

Or with Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.postbox]
command = "node"
args = ["/path/to/picode/bin/postbox-mcp.mjs"]
env = { POSTBOX_THREAD_ID = "codex-1" }
```

One caveat: foreign agents are pull-delivery only. They see incoming messages when they call `picode_inbox` or `picode_wait`, not through pi's push injection into a live turn.

There is also `bin/postbox-hook.mjs`, a Claude Code hook that does push-style delivery: cold-start drain, turn-start, post-tool-use, and stop-block.

## Storage backends

**Local filesystem (default).** Zero dependencies. State lives in `.picode/picodes/<id>/state.json`, `journal.md`, and `inbox/` (messages are enqueued atomically with a rename, and read in FIFO order thanks to ULID-sorted filenames).

**Restate backend.** A durable backend that can wake a stopped picode. A `deliverAfter` envelope coming due for a stopped picode causes the companion service to spawn pi back up, because the mailbox and its timer live in Restate rather than in the process that armed it.

**Pluggable adapter.** The `StorageAdapter` interface means you can add a backend with a single factory registration.

### Running with the Restate adapter

The default local backend is durable enough to survive a crash, but a stopped pi process obviously cannot watch its own inbox or fire its own heartbeat while it is not running. The Restate backend trades "no dependencies" for one real capability the local backend structurally cannot offer: waking a stopped picode.

This backend has a real operational footprint. Three things need to be running:

1. **A self-hosted `restate-server`** (single binary or Docker), for example:
   ```bash
   docker run --rm -p 8080:8080 -p 9070:9070 docker.io/restatedev/restate:latest
   ```
2. **The companion service**, which hosts the `Picode` and `PicodeRegistry` virtual objects:

   ```bash
   npm run restate:serve
   ```

   It listens on port 9080 by default. Three environment variables shape how it revives a stopped picode:
   - `RESTATE_INGRESS_URL` is the ingress URL the spawned pi connects back to (default `http://localhost:8080`).
   - `PI_THREAD_EXTENSION` is the path to this extension's entry point, passed to the spawned pi as `--extension` (omit if your pi config already loads it).
   - `PI_BIN` is the pi executable to spawn (default `pi` from PATH; required on Windows, where the npm-installed `pi` is a `.cmd` shim that `spawn()` cannot execute).

   The revived pi runs in the picode's original working directory, recorded in its state.

3. **Register the deployment** with the server's admin API (one time, or after changing `src/restate/service.ts`):
   ```bash
   curl -X POST http://localhost:9070/deployments -d '{"uri":"http://localhost:9080"}'
   ```

Then start pi pointed at it:

```bash
picode coordinator --picode-storage restate --picode-storage-url http://localhost:8080
```

Known limitations versus the local backend: `watchInbox` polls every two seconds instead of getting an instant `fs.watch` notification (cold-start delivery at session start is unaffected either way). A future-dated envelope's delayed self-check cannot be un-armed once scheduled, since Restate has no public "cancel a delayed send" API. It no-ops if the envelope was already drained by the time it fires. The `bin/picode-cli.mjs` human monitoring CLI only ever reads the local filesystem layout, so it will not see threads running against the Restate backend.

## CLI flags

- `--picode-id <id>`: stable identity for this picode, for example `coordinator` or `worker-a`. This is also the opt-in trigger. Omit it and the extension does nothing.
- `--picode-role <role>`: role label, targetable via `picode_send to="role:<role>"`. Optional. Auto-detected from the id (exact match or prefix: `builder-1` becomes `builder`).
- `--picode-parent <id>`: parent picode id, the escalation target. Optional. Auto-defaults to `coordinator` for non-coordinator threads.
- `--picode-journal <turn|done|off>`: journal cadence. Default is `done`. Overrides `.picode/models.json` `"journal-cadence"` key.
- `--picode-journal-model <model>`: model for the journal fork. Default is the picode's own model. Overrides `.picode/models.json` `"journal"` key. A pinned model must resolve on the machine the picode runs on, or journaling fails loudly on stderr.
- `--picode-storage <local|restate>`: storage backend. Default is `local`.
- `--picode-storage-url <url>`: backend connection URL. Ignored by the local backend.

## State machine

```
IDLE -> THINKING -> WORKING -> OPEN -> DONE

OPEN -(suspend)-> ON HOLD -(resume)-> OPEN
any -(unclean exit)-> STOPPED
```

There is no waiting state. Debts and barriers are durable records rather than states, so nothing needs repair on restart beyond `done` or `stopped` going back to `idle`. Full detail is in [THREAD-MODEL.md](THREAD-MODEL.md).

## Herdr integration details

- **Pane labels:** Picode labels its Herdr panes with the worker role and emoji, such as `🧭 coordinator`, `🔨 builder`, `🔍 explorer`, or `🛡️ reviewer`. The Pi terminal title also shows the role and working directory.
- **Pane and tab lifecycle:** `spawn_worker` uses Herdr to find/reuse a suitable pane, choose an adaptive split, launch Pi, and wait for it to become ready. When the tab is full, the coordinator can create another Herdr tab. Picode also provides pane inspection, pane reads, cleanup, and controlled revival tools.
- **Status and events:** Picode uses Herdr's pane/workspace identity and event API to scope operations and notice tracked worker pane exits. Herdr's own Pi integration reports Pi session identity and lifecycle so Herdr can restore and identify sessions.
- **Install both pieces:** Install Picode in Pi, then install Herdr's Pi integration with `herdr integration install pi`. See the [Herdr integration docs](https://herdr.dev/docs/integrations/) and the [Herdr agent automation guide](https://herdr.dev/docs/agent-automation/).

## Developing picode

If you are hacking on the extension itself, you have both a local checkout at `/Users/kentaylor/developer/picode/` and a globally installed version at `~/.pi/agent/git/github.com/ktappdev/picode/`. Running pi inside the local checkout auto-loads both extensions and fails with a `Tool "X" conflicts` error.

Workaround: spawn test workers in a directory that is not a picode project:

```bash
mkdir -p /tmp/picode-cwd
cd /tmp/picode-cwd
picode builder-test
```

The worker has full access to picode tools (from the installed version) and can `cd /Users/kentaylor/developer/picode && <command>` to operate on the source tree. The local auto-load never fires because there is no `package.json` in `/tmp/picode-cwd`.

The same applies to the coordinator. Keep it in `/tmp/picode-cwd` or another non-picode directory while developing.

## Tests

```bash
npm run test:unit         # ~120 cases, milliseconds, no API cost, deterministic logic
npm run test:e2e          # ~10 cases, minutes, real model calls, tool discovery and process boundaries
npm run test:e2e:restate  # ~6 cases, needs Docker, no API cost, RestateAdapter against a real restate-server
npm test                  # test:unit + test:e2e
```

Three tiers, deliberately. `test:unit` drives the extension's own tool, command, inbox, and adapter logic directly against a stubbed pi (no subprocess), covering targeting, correlation, dedup, and error handling. `test:e2e` spawns a real pi process per case and is kept small, because each test there earns its place by proving something only a live model or a real subprocess boundary can. `test:e2e:restate` is separate because it needs Docker rather than API credits. See [TESTING.md](TESTING.md) before adding a new test.

## License

MIT
