# picode

Cross-picode communication extension for [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Independent threads that coordinate work, share state, and converse — without losing context or forking their history.

## Requirements

### Required

- **[pi](https://github.com/earendil-works/pi-coding-agent)** — the coding agent this extension runs on
  ```bash
  npm install -g @earendil-works/pi-coding-agent
  ```
- **[Herdr](https://github.com/earendil-works/herdr)** — terminal multiplexer for coordinator mode (auto-spawns workers, manages panes)
  ```bash
  brew install earendil-works/tap/herdr   # macOS
  ```
  Without Herdr the coordinator cannot auto-spawn or manage worker panes. Manual multi-process setups (`pi --picode-id builder` in separate terminals) still work.
- **Node.js ≥ 20**
- **An LLM provider** — at minimum an [OpenRouter](https://openrouter.ai/) API key (free tier models work). Other supported providers: Anthropic, OpenAI, Google, local Ollama, etc.
  ```bash
  export OPENROUTER_API_KEY=sk-or-...    # or set in pi config
  ```

### Optional

- **Docker** — needed only for the Restate storage backend (`npm run restate:serve`)
- **[Restate](https://restate.dev/)** — pluggable durable backend (alternative to default local filesystem)
- **Claude Code / Codex** — connect external agents via the MCP server (`bin/postbox-mcp.mjs`)

## Quick Start

1. **Install** the extension:
   ```bash
   pi install git:github.com/ktappdev/picode@main
   ```
2. **Launch a worker** in a new terminal:
   ```bash
   pi --picode-id builder
   ```
3. **Launch the coordinator** in another terminal:
   ```bash
   pi --picode-id coordinator
   ```

That's it — workers self-label by their picode-id and can `picode_send` each other or the coordinator. See [Coordinator Mode](#coordinator-mode) and [Worker Roles](#worker-roles) for details.

## Requirements

### Required

- **[pi](https://github.com/earendil-works/pi-coding-agent)** — the coding agent
  ```bash
  npm i -g @earendil-works/pi-coding-agent
  ```
- **Node.js** ≥ 18
- **Model access** — at least one provider configured in pi:
  - [OpenRouter](https://openrouter.ai/) (free models available)
  - Anthropic (`ANTHROPIC_API_KEY`)
  - OpenAI (`OPENAI_API_KEY`)
  - Ollama (local, free)

### Required for Coordinator Mode

- **[herdr](https://github.com/earendil-works/herdr)** — terminal multiplexer for auto-spawning and managing worker panes
  ```bash
  npm i -g @earendil-works/herdr
  ```

### Optional

- **jq** — handy for inspecting JSON output from `picode-cli.mjs --json`
- **[Restate](https://restate.dev/)** — distributed backend (default is local filesystem)

## Features

### Threading

- **Stable Picode Identity** — Each `pi` process gets a durable id via `--picode-id <id>`, persisted across restarts.
- **Auto-Detected Roles** — Role inferred from picode-id prefix (`builder-1` → `builder`, `explorer-a` → `explorer`).
- **Hierarchical Parent/Child** — Parent defaults to `coordinator` for non-coordinator threads; escalation target.
- **Opt-In Activation** — Extension does nothing without `--picode-id`; no `.picode/` dir, no tools, no prompt changes.
- **Picode State Machine** — Six states (idle/thinking/working/open/on-hold/done/stopped) with cooperative transitions.
- **Graceful Suspend/Resume** — On Hold queues inbox; resume drains; reason persisted and visible.

### Communication

- **Envelope Message Model** — Single shape: note, request (`expects=true`), reply (`re=<id>`), or reply+request.
- **Urgency Levels** — `high` (interrupt at next Open) vs `low` (deliver when idle).
- **Scheduled Delivery** — `deliverAfterSeconds` holds envelope until due; self-addressed = scheduled self-wake.
- **Expiring Messages** — `expiresAfterSeconds` discards undelivered envelopes past TTL.
- **Dual Debt Ledgers** — Obligations (sender-side) and owed replies (receiver-side), both durable and sender-gated.
- **Deadline Enforcement** — Each request gets a deadline (default 15 min); one-time overdue reminder nudges.
- **Barriers (Async Wait)** — Arm a barrier on one or many envelope ids; wake when all/any reply lands.
- **Meeting Protocol** — Request "meet?" → ok/busy → high-urgency exchange → closing note; exclusivity advisory.
- **Broadcast & Role Targeting** — Send to `*` (all), comma-separated list, or `role:<role>`.
- **Fan-Out & Collect** — Send individually correlated requests to each target, then `picode_wait([ids])`.

### Tools (Model-Facing)

- **`picode_send`** — Send envelopes with expects/re/urgency/deliverAfter/deadline/wait.
- **`picode_wait`** — Arm barrier over envelope ids; wake on all/any reply with optional resolution message.
- **`picode_status`** — Read own id/role/state/obligations/owed/barriers/journal.
- **`picode_list`** — List all known threads with state, role, parent, liveness.
- **`picode_journal`** — Read any picode's journal with tail/lookbackMinutes filtering.
- **`picode_suspend`** — Mark On Hold with reason; inbox queues until resume.
- **`picode_resume`** — Return to Open and drain queued inbox.

### Slash Commands (Human-Facing)

- **`/picode-status`** — Show own state, obligations, owed replies, barriers, latest journal.
- **`/picode-journal`** — View, tail, trim, clear, or compact the journal.
- **`/picode-list`** — List all known threads in workspace.
- **`/picode-send`** — Send high-urgency note to another picode.
- **`/picode-suspend`** — Mark On Hold with optional reason.
- **`/picode-resume`** — Return to Open.
- **`/picode-models`** — Show, set, or reset per-role worker model config.

### Coordinator features

- **Read-Only Coordinator** — Write/edit tools disabled; coordinator reads, searches, delegates only.
- **Auto-Spawn Workers** — Via herdr terminal multiplexer; discovers idle/done panes for reuse.
- **Pane Layout** — Adaptive: workers split in the direction that halves the longer dimension (wide pane → right, tall pane → down), keeping new panes close to square. Coordinator stays at 50% left; worker area fills the right half.
- **Worker Dispatch Format** — Structured task body: Objective, Context, Constraints, Action Steps, Deliverables, Prerequisites.
- **Self-Improving Prompts** — Coordinator writes discovered gaps to `.picode/prompts/<role>.md` on the fly.
- **Silent-Worker Recovery** — If a worker owes a reply that hasn't arrived in ~10 min, the worker may have answered in plain text (which the coordinator can't see). Coordinator reads the worker's pane output, finds the plain-text reply, and either accepts it or resends the request reminding the worker to use `picode_send`.

### Worker role types

- **Builder** — Implements code; write/edit files; runs type checks.
- **Reviewer** — Reviews diffs for bugs/security/quality; read-only.
- **Scout / Explorer** — Explores codebase; finds files; answers architecture questions; read-only. Explorers follow a **summarization contract**: never dump raw grep/file contents — return TL;DR + key findings with file:line refs + next steps.
- **Bug Hunter** — Laser-focused bug finder: reads code, session entries, and picode journals; runs reproductions. Reports root cause with file:line references and a suggested fix (one paragraph). Does NOT implement the fix — the coordinator or builder does.
- **Designer** — Produces UI specs for builder; read-only.
- **Tester** — Writes and runs tests; reproduces bugs; test-first.
- **Generic Worker** — Catch-all role for unknown picode-ids; base worker rules only.

### Communication contract (v0.5.13+)

Workers reply to the coordinator **only** via `picode_send` — plain text in a worker's pane reaches the human user, not the coordinator. If a worker answers in plain text, the coordinator never sees the reply and the human must relay it. This contract is baked into every worker template.

If a worker has gone silent (no `picode_send` reply within ~10 minutes), the coordinator's recovery rule is: read the worker's pane output, find the plain-text reply, and either accept it or resend the request explicitly reminding the worker to use `picode_send`.

### Journal features

- **Auto-Journaling** — Forked model call after each turn summarizes state; non-interrupting, background.
- **Cadence Control** — `--picode-journal turn|done|off`; rate-limited (max 1 per ~2 min) for same-task turns.
- **Journal Compaction** — Auto-summarizes oldest entries past threshold (500); 24h cooldown.
- **Duplicate Suppression** — Skips entry when Working on/Done lines match previous.
- **Pinned Journal Model** — `--picode-journal-model <model>`; defaults to picode's own model.
- **Journal CLI Management** — `/picode-journal tail N|trim N|clear|compact|status`.

### Storage Backends

- **Local Filesystem (Default)** — Zero-dependency: `.picode/threads/<id>/state.json`, `journal.md`, `inbox/` (atomic rename for enqueue; FIFO via ULID-sorted readdir).
- **Restate Backend** — Durable virtual objects; wakes stopped threads on `deliverAfter` envelopes.
- **Pluggable Adapter** — `StorageAdapter` interface; add backend via single factory registration.

### Human Tooling

- **`picode-cli.mjs`** — Zero-dep CLI: list, status, watch, tail, inbox, send (with expects/re/urgency), delete threads; human as full protocol citizen.
- **`postbox-mcp.mjs`** — MCP stdio server; any MCP-capable agent (Claude Code, Codex) becomes a Postbox picode; exposes six protocol tools.
- **`postbox-hook.mjs`** — Claude Code hook; push-style delivery: cold-start drain, turn-start, post-tool-use, stop-block.

### Customization

- **Per-Project Prompt Overrides** — `.picode/prompts/<role>.md` replaces bundled role prompt entirely; no code changes.
- **Worker Model Config** — `.picode/models.json` maps role → model; prefix-matched; `"default"` fallback.
- **Self-Improving Coordinator** — Writes discovered rule gaps to prompt override files; survives reinstalls.

### Visual Identification

- **Role Emoji in Pane Label** — Each pane's herdr label shows the role with an emoji: `🧭 coordinator`, `🔨 builder`, `🔍 explorer`, `🛡️ reviewer`, `🎨 designer`, `🧪 tester`, `🐛 bug-hunter`, `👷 worker`.
- **Role in Terminal Title** — Terminal title (visible in tmux status, OS window list) shows `pi · <emoji> <role> · <cwd>`. Useful when not running inside herdr.
- **Coordination with herdr** — Herdr's pane label and the terminal title carry the same role info, so identification is consistent across surfaces.

### CLI Flags

- **`--picode-id`** — Stable picode identity; the opt-in trigger.
- **`--picode-role`** — Explicit role override (auto-detected from id otherwise).
- **`--picode-parent`** — Parent picode id (defaults to `coordinator`).
- **`--picode-journal`** — Journal cadence: `turn`, `done`, or `off`.
- **`--picode-journal-model`** — Model for journal fork entries.
- **`--picode-storage`** — Backend: `local` or `restate`.
- **`--picode-storage-url`** — Backend connection URL (Restate ingress).

## How it works

Each `pi` process becomes a **picode** with a stable identity. Threads communicate through durable per-picode mailboxes — one picode writes an envelope, the target drains it on startup or via live updates. By default the mailbox is local files (no central broker, no external dependencies); a pluggable `StorageAdapter` means the same tools/commands also work against a durable backend (Restate) that can wake a stopped picode — see [Running with the Restate adapter](#running-with-the-restate-adapter).

The extension is opt-in: it only activates for a session launched with `--picode-id <id>` (or resuming one that was). Without that flag, loading this extension has no effect at all — no `.picode/` directory, no `thread_*` tools, no system-prompt changes.

The protocol is specified in [THREAD-MODEL.md](THREAD-MODEL.md) (Postbox — the Picode Messaging Protocol).

## Install

```bash
# From your private GitHub repo:
pi install git:github.com/ktappdev/picode@main

# Or try it without installing:
pi -e git:github.com/ktappdev/picode@main --picode-id my-picode
```

## Usage

Start any number of pi processes in the same working directory, each with a unique `--picode-id`:

```bash
# Coordinator (role auto-detected from id)
pi --picode-id coordinator

# Workers (role + parent auto-detected from id)
pi --picode-id builder
pi --picode-id explorer
pi --picode-id tester

# Prefix matching: builder-1 → role "builder"
pi --picode-id builder-1
pi --picode-id reviewer-a

# Generic worker: any id not matching a known role
pi --picode-id my-worker
```

`--picode-role` and `--picode-parent` are now optional. Role is auto-detected from `--picode-id` (exact match or prefix: `builder-1` → `builder`). Parent auto-defaults to `coordinator` for non-coordinator threads.

Threads share state via `.picode/threads/<id>/` in the project directory. Each picode gets a journal, a state file, and an inbox for cross-picode envelopes.

## Developing Picode

If you're hacking on the picode extension itself, you have both a local checkout (`/Users/kentaylor/developer/picode/`) and a globally installed version (`~/.pi/agent/git/github.com/ktappdev/picode/`). Running `pi` inside the local checkout will **auto-load both extensions** and fail with a `Tool "X" conflicts` error.

**Workaround:** spawn test workers in a non-picode directory:

```bash
mkdir -p /tmp/picode-cwd
cd /tmp/picode-cwd
pi --picode-id builder-test
```

The worker has full access to picode tools (from the installed version) and can `cd /Users/kentaylor/developer/picode && <command>` to operate on the source tree. The local auto-load never fires because there's no `package.json` in `/tmp/picode-cwd`.

For the coordinator, the same applies — keep it in `/tmp/picode-cwd` or another non-picode dir while developing.

## Worker Roles

Each picode has a role that shapes its system prompt. The role is auto-detected from `--picode-id`:

| Role                 | Subtype | Description                                                                                                                                |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `coordinator`        | —       | Directs workers, delegates tasks, maintains project context. Cannot write/edit files.                                                      |
| `builder`            | Worker  | Implements code changes, edits files, runs type checks.                                                                                    |
| `reviewer`           | Worker  | Reviews diffs, audits for bugs/security/quality. Read-only.                                                                                |
| `scout` / `explorer` | Worker  | Explores codebase, finds files, answers architecture questions. Read-only. Summarizes findings — never dumps raw output.                   |
| `bug-hunter`         | Worker  | Hunts bugs: reads code, session entries, journals, runs reproductions. Reports root cause + suggested fix — does NOT implement. Read-only. |
| `tester`             | Worker  | Writes and runs tests, reproduces bugs, checks coverage.                                                                                   |
| `designer`           | Worker  | Designs UI specs for builder implementation. Read-only.                                                                                    |

Prefix matching: `builder-1`, `builder-a`, `builder_foo`, `builder.task` all resolve to role `builder`. Any id that doesn't match a known role (or prefix) defaults to a generic `worker` role with base worker rules only.

## Worker Models

Override which LLM model each worker role uses via `.picode/models.json`:

```json
{
  "builder": "anthropic/claude-sonnet-4",
  "reviewer": "anthropic/claude-haiku-4",
  "explorer": "anthropic/claude-haiku-4",
  "default": "anthropic/claude-sonnet-4"
}
```

- Roles match by prefix (e.g., `builder` key matches `builder-1`, `builder-a`)
- Falls back to `"default"` key, then to pi's default model
- Coordinator reads this file on startup and passes the model to each worker spawn command
- Human operator can manage via slash command:

| Command                                            | Effect                        |
| -------------------------------------------------- | ----------------------------- |
| `/picode-models`                                   | Show current config           |
| `/picode-models builder anthropic/claude-sonnet-4` | Set model for a role          |
| `/picode-models --reset`                           | Delete file, restore defaults |

## Coordinator Mode

When a picode has role `coordinator` (auto-detected from `--picode-id coordinator`):

- **Write/edit tools are disabled** — coordinator reads, searches, and delegates only
- **Bash is read-only** — `ls`, `grep`, `find`, `cat`, plus `herdr` commands for pane management
- **Auto-spawns workers via [herdr](https://github.com/earendil-works/herdr)** — a terminal multiplexer that manages panes and tabs
- **Pane reuse** — checks existing panes first, reuses idle/done workers instead of spawning duplicates
- **Layout** — spawns workers in the same tab, 50/50 split (coordinator left, workers stacked in right column)
- **Model config** — reads `.picode/models.json` for per-role model overrides when spawning
- **Self-improving** — updates its per-project prompt override (`.picode/prompts/coordinator.md`) when it discovers gaps in rules, workflow, or defaults during operation

## Customizing Prompts

Each role's system prompt comes from a bundled default in `src/core/system-prompt.ts`. You can override a role's entire prompt block with a markdown file in your project — no code changes, no reinstall needed.

Create `.picode/prompts/<role>.md` at your project root (the git repo root, or cwd if not in a repo):

```
.picode/
  prompts/
    coordinator.md   # overrides the coordinator rules
    builder.md       # overrides the builder rules
    reviewer.md      # overrides the reviewer rules
    worker.md        # catch-all for any generic worker role
```

**Supported role names:** `coordinator`, `builder`, `reviewer`, `scout`, `explorer`, `designer`, `tester`, `worker`.

- The override file **replaces** the bundled role block entirely (no merging).
- Leave the file empty to use the bundled default (empty files are ignored).
- Unknown roles (generic workers) fall back to `worker.md`.
- Loaded once at picode startup — no hot reload. Restart the picode after editing.

**Self-improvement:** When a coordinator discovers a gap in its rules during operation, it writes to these override files — not to the extension source. This survives reinstalls and is safe to commit to your project repo.

Sample overrides to copy: [`examples/prompts/`](examples/prompts/).

## Journal Compaction

Journal entries are append-only, so a long-running picode can grow `journal.md` without bound. Compaction keeps the file bounded by summarizing the oldest entries into a single block and keeping the most recent ones verbatim.

**Automatic:**

- Triggers at `agent_end` when the journal has more than 500 entries.
- Summarizes all but the most recent 100 entries into a single `<!-- COMPACTION <ts> -->` block.
- 24-hour cooldown between compactions (enforced by a marker in the file, no extra state).
- The summarization runs as a forked `pi` process — no in-process LLM call, fire-and-forget, never blocks the picode.
- The new content is re-read under the journal lock just before writing, so any entries appended during the fork are preserved.

**Manual control via `/picode-journal`:**

| Subcommand                | Effect                                                 |
| ------------------------- | ------------------------------------------------------ |
| `/picode-journal`         | Show last 12 entries                                   |
| `/picode-journal tail N`  | Show last N entries                                    |
| `/picode-journal status`  | Entry count, file size, oldest and newest timestamps   |
| `/picode-journal trim N`  | Keep only the last N entries (no fork)                 |
| `/picode-journal clear`   | Delete the journal file                                |
| `/picode-journal compact` | Force compact now (even under the 500-entry threshold) |

## The message model

There is **one message shape** — the envelope — and two optional fields give it meaning:

```
Envelope {
  id            own identity — minted per send, form <from>/<ulid>
  from, to      sender / target picode id
  body          content
  sentAt        ISO-8601
  re?           reply correlation: settles the debt on that envelope id
  expects?      true — sender needs a reply; tracked until one arrives
  urgency?      "high" (interrupt at next opening) | "low" (default: when idle)
  deliverAfter? not deliverable before this instant
}
```

- `expects: true` → a **request**. The receiver records an owed reply (durable, survives restarts); the sender records an obligation with a deadline (default 15 min) and gets a one-time overdue reminder.
- `re: <id>` → a **reply**. Settles the debt.
- Both together → a reply that asks a follow-up — "pass the ball" when you can't answer without more information.
- Neither → a plain **note**.

There are no message types on the wire and no locks anywhere: a picode that wants to block on a reply arms a **barrier** (`wait=true` or `picode_wait`) and ends its turn — the reply wakes it. A live back-and-forth (a "meeting") is a convention: request "meet?" → reply ok/busy → exchange of high-urgency notes → note "closing". A scheduled self-wake is just an envelope to your own id with `deliverAfter`.

Messages arrive as `[<kind> from <sender> #<id>]` — kind (request/reply/reply+request/note) is derived from the fields, and requests carry an explicit reply hint so receivers always know the id to echo back as `re`.

### Tools available to the LLM

| Tool             | Purpose                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `picode_send`    | Send an envelope — to one id, `a,b`, `*`, or `role:<role>`; `expects`, `re`, `urgency`, `deliverAfterSeconds`, `wait=true` (arm a barrier inline) |
| `picode_wait`    | Wait for all/any of several outstanding replies (barrier) — accepts `deadlineSeconds` and an optional `message` payload injected on resolution    |
| `picode_status`  | Read this picode's state, obligations, owed replies, barriers, and journal                                                                        |
| `picode_list`    | List all known threads in the workspace                                                                                                           |
| `picode_journal` | Read another picode's journal — filter by `tail`/`lookbackMinutes`                                                                                |
| `picode_suspend` | Mark picode On Hold — inbox queues until resume (client-local, not protocol)                                                                      |
| `picode_resume`  | Resume from On Hold and drain queued messages (client-local, not protocol)                                                                        |

### Slash commands

| Command                    | Purpose                                    |
| -------------------------- | ------------------------------------------ |
| `/picode-status`           | Show state and latest journal entry        |
| `/picode-list`             | List all known threads                     |
| `/picode-send <to> <body>` | Send a high-urgency note to another picode |
| `/picode-suspend`          | Mark On Hold                               |
| `/picode-resume`           | Resume from On Hold                        |
| `/picode-models`           | Show/set/reset worker model config         |
| `/picode-journal`          | View, trim, clear, or compact the journal  |

## Flags

- `--picode-id <id>` — stable identity for this picode (e.g., `coordinator`, `worker-a`); also the opt-in trigger — omit it and the extension does nothing
- `--picode-role <role>` — role label, targetable via `picode_send to="role:<role>"`. Optional — auto-detected from `--picode-id` (exact match or prefix: `builder-1` → `builder`). Known roles: coordinator, builder, reviewer, scout/explorer, tester, designer. Unknown ids default to `worker`.
- `--picode-parent <id>` — parent picode id, the escalation target ("I'm stuck" → request to parent at high urgency). Optional — auto-defaults to `coordinator` for non-coordinator threads.
- `--picode-journal <turn|done|off>` — journal cadence (default `turn`; each entry is one forked model call, rate-limited to one entry per ~2 minutes of same-task tool turns, plus a wrap-up entry when a run ends with unjournaled work; structural changes — new obligations, barriers — always journal immediately)
- `--picode-journal-model <model>` — model for the journal fork (e.g. `deepseek/deepseek-chat` to keep entries cheap). Default: the picode's own model. A pinned model must resolve on the machine the picode runs on, or journaling fails (loudly, on stderr)
- `--picode-storage <local|restate>` — storage backend (default `local`, the filesystem; see [Running with the Restate adapter](#running-with-the-restate-adapter))
- `--picode-storage-url <url>` — backend connection URL (e.g. a Restate ingress URL); ignored by the local backend

## Human monitoring & steering

`bin/picode-cli.mjs` lets a human act on the picode system without running pi — a full protocol citizen over plain files:

```bash
node bin/picode-cli.mjs list                      # table of all threads incl. coordination counts
node bin/picode-cli.mjs status link               # one picode's full coordination state:
                                                  #   obligations, owed replies, barriers,
                                                  #   pending inbox, last journal entry
node bin/picode-cli.mjs status link --json        # same, as machine-readable JSON
node bin/picode-cli.mjs watch                     # live coordination board
node bin/picode-cli.mjs tail link                 # follow one picode's state/journal/messages
                                                  #   (incl. +/- diffs of obligations/barriers)
node bin/picode-cli.mjs inbox link                # pending + recent messages
node bin/picode-cli.mjs send link "status?" --expects       # ask, tracked — picode owes you a reply
node bin/picode-cli.mjs send link "looks good" --re link/01ABC…  # reply, settles the debt
node bin/picode-cli.mjs send '*' "standup in 5"             # broadcast note
node bin/picode-cli.mjs delete link                         # remove a picode (refuses if it looks live)
node bin/picode-cli.mjs delete --stale --yes                # prune every stopped/stale picode
```

## Interop: MCP server for other coding agents

`bin/postbox-mcp.mjs` is a zero-dependency MCP (Model Context Protocol) stdio server: point any MCP-capable coding agent at it and that agent becomes a full Postbox picode over plain files — the same `.picode/threads/<id>/` binding pi and `picode-cli` speak, so a Claude Code or Codex session sends, receives, and settles reply debts with pi threads and each other, no pi process required on its side. It exposes the six protocol tools (`picode_send`, `picode_inbox`, `picode_wait`, `picode_status`, `picode_list`, `picode_journal`) and maintains the sending picode's presence and obligation/owed ledger in `state.json`. Identity comes from environment variables: `POSTBOX_THREAD_ID` (required), `POSTBOX_DIR` (workspace root, default cwd), and optional `POSTBOX_ROLE` / `POSTBOX_PARENT`.

Register it with Claude Code:

```bash
claude mcp add postbox -e POSTBOX_THREAD_ID=cc-1 -- node /path/to/pi-extension/bin/postbox-mcp.mjs
```

Or with Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.postbox]
command = "node"
args = ["/path/to/pi-extension/bin/postbox-mcp.mjs"]
env = { POSTBOX_THREAD_ID = "codex-1" }
```

Caveat — foreign agents are pull-delivery only: they see incoming messages when they call `picode_inbox` (drain now) or `picode_wait` (block until one arrives), and don't get pi's push injection into a live turn.

## State machine

```
IDLE → THINKING → WORKING → OPEN ──→ DONE

OPEN ──(suspend)──→ ON HOLD ──(resume)──→ OPEN
any ──(unclean exit)──→ STOPPED
```

There is no waiting state: debts and barriers are durable records, not states, so nothing needs repair on restart beyond `done/stopped → idle`. Full detail in [THREAD-MODEL.md](THREAD-MODEL.md) §11–§13.

## Running with the Restate adapter

The default `local` backend is the filesystem — durable enough for a crash, but a stopped `pi` process obviously can't watch its own inbox or fire its own heartbeat while it isn't running. The `restate` backend trades "no dependencies" for one real capability the local backend structurally cannot offer: **waking a stopped picode**. A `deliverAfter` envelope coming due for a stopped picode causes the companion service to spawn `pi` back up, because the mailbox and its timer live in Restate, not in the process that armed it.

This backend has a real operational footprint — three things need to be running:

1. **A self-hosted `restate-server`** (single binary or Docker), e.g. `docker run --rm -p 8080:8080 -p 9070:9070 docker.io/restatedev/restate:latest`.
2. **The companion service**, which hosts the `Picode`/`PicodeRegistry` virtual objects: `npm run restate:serve` (listens on port 9080 by default). Three environment variables shape how it revives a stopped picode: `RESTATE_INGRESS_URL` — the ingress URL the spawned `pi` connects back to (default `http://localhost:8080`); `PI_THREAD_EXTENSION` — the path to this extension's entry point, passed to the spawned `pi` as `--extension` (omit if your `pi` config already loads it); and `PI_BIN` — the pi executable to spawn (default `pi` from PATH; required on Windows, where the npm-installed `pi` is a `.cmd` shim `spawn()` can't execute). The revived `pi` runs in the picode's original working directory, recorded in its state.
3. **Register the deployment** with the server's admin API (one-time, or after changing `src/restate/service.ts`):
   ```bash
   curl -X POST http://localhost:9070/deployments -d '{"uri":"http://localhost:9080"}'
   ```

Then start `pi` pointed at it:

```bash
pi --picode-id coordinator --picode-storage restate --picode-storage-url http://localhost:8080
```

Known limitations versus the local backend: `watchInbox` polls (every 2s) instead of getting an instant `fs.watch` notification — cold-start delivery at session_start is unaffected either way. A future-dated envelope's delayed self-check (`deliverDue`) can't be un-armed once scheduled (Restate has no public "cancel a delayed send" API) — it no-ops if the envelope was already drained by the time it fires. `bin/picode-cli.mjs` (the human monitoring CLI above) is a standalone, zero-dependency script that only ever reads the local filesystem layout — it won't see threads running against the Restate backend.

## Tests

```bash
npm run test:unit         # ~120 cases, milliseconds, no API cost — deterministic logic
npm run test:e2e          # ~10 cases, minutes, real model calls — tool discovery & process boundaries
npm run test:e2e:restate  # ~6 cases, needs Docker, no API cost — RestateAdapter against a real restate-server
npm test                  # test:unit + test:e2e
```

Three tiers, deliberately: `test:unit` drives the extension's own tool/command/inbox/adapter logic directly against a stubbed `pi` (no subprocess), covering targeting, correlation, dedup, error handling, and — via a small fake in-memory `StorageAdapter` — that the core logic doesn't secretly depend on the filesystem. `test:e2e` spawns a real `pi` process per case and is kept small — each test there earns its place by proving something only a live model or a real subprocess boundary can (ambiguity resolution, envelope comprehension, cross-process durability, journal forking). `test:e2e:restate` is separate because it needs Docker rather than API credits — it proves `RestateAdapter` and the `Picode`/`PicodeRegistry` service actually work against a real `restate-server`, not just against the type checker. See [TESTING.md](TESTING.md) before adding a new test.

## License

MIT
