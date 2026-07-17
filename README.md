# pi-threading

Cross-thread communication extension for [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Independent threads that coordinate work, share state, and converse — without losing context or forking their history.

## Features

### Threading

- **Stable Thread Identity** — Each `pi` process gets a durable id via `--thread-id <id>`, persisted across restarts.
- **Auto-Detected Roles** — Role inferred from thread-id prefix (`builder-1` → `builder`, `explorer-a` → `explorer`).
- **Hierarchical Parent/Child** — Parent defaults to `coordinator` for non-coordinator threads; escalation target.
- **Opt-In Activation** — Extension does nothing without `--thread-id`; no `.thread/` dir, no tools, no prompt changes.
- **Thread State Machine** — Six states (idle/thinking/working/open/on-hold/done/stopped) with cooperative transitions.
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
- **Fan-Out & Collect** — Send individually correlated requests to each target, then `thread_wait([ids])`.

### Tools (Model-Facing)

- **`thread_send`** — Send envelopes with expects/re/urgency/deliverAfter/deadline/wait.
- **`thread_wait`** — Arm barrier over envelope ids; wake on all/any reply with optional resolution message.
- **`thread_status`** — Read own id/role/state/obligations/owed/barriers/journal.
- **`thread_list`** — List all known threads with state, role, parent, liveness.
- **`thread_journal`** — Read any thread's journal with tail/lookbackMinutes filtering.
- **`thread_suspend`** — Mark On Hold with reason; inbox queues until resume.
- **`thread_resume`** — Return to Open and drain queued inbox.

### Slash Commands (Human-Facing)

- **`/thread-status`** — Show own state, obligations, owed replies, barriers, latest journal.
- **`/thread-journal`** — View, tail, trim, clear, or compact the journal.
- **`/thread-list`** — List all known threads in workspace.
- **`/thread-send`** — Send high-urgency note to another thread.
- **`/thread-suspend`** — Mark On Hold with optional reason.
- **`/thread-resume`** — Return to Open.
- **`/thread-models`** — Show, set, or reset per-role worker model config.

### Coordinator Mode

- **Read-Only Coordinator** — Write/edit tools disabled; coordinator reads, searches, delegates only.
- **Auto-Spawn Workers** — Via herdr terminal multiplexer; discovers idle/done panes for reuse.
- **Pane Layout** — 50/50 split (coordinator left, workers stacked right column).
- **Worker Dispatch Format** — Structured task body: Objective, Context, Constraints, Action Steps, Deliverables, Prerequisites.
- **Self-Improving Prompts** — Coordinator writes discovered gaps to `.thread/prompts/<role>.md` on the fly.

### Worker Roles

- **Builder** — Implements code; write/edit files; runs type checks.
- **Reviewer** — Reviews diffs for bugs/security/quality; read-only.
- **Scout / Explorer** — Explores codebase; finds files; answers architecture questions; read-only.
- **Designer** — Produces UI specs for builder; read-only.
- **Tester** — Writes and runs tests; reproduces bugs; test-first.
- **Generic Worker** — Catch-all role for unknown thread-ids; base worker rules only.

### Journal

- **Auto-Journaling** — Forked model call after each turn summarizes state; non-interrupting, background.
- **Cadence Control** — `--thread-journal turn|done|off`; rate-limited (max 1 per ~2 min) for same-task turns.
- **Journal Compaction** — Auto-summarizes oldest entries past threshold (500); 24h cooldown.
- **Duplicate Suppression** — Skips entry when Working on/Done lines match previous.
- **Pinned Journal Model** — `--thread-journal-model <model>`; defaults to thread's own model.
- **Journal CLI Management** — `/thread-journal tail N|trim N|clear|compact|status`.

### Storage Backends

- **Local Filesystem (Default)** — Zero-dependency: `.thread/threads/<id>/state.json`, `journal.md`, `inbox/` (atomic rename for enqueue; FIFO via ULID-sorted readdir).
- **Restate Backend** — Durable virtual objects; wakes stopped threads on `deliverAfter` envelopes.
- **Pluggable Adapter** — `StorageAdapter` interface; add backend via single factory registration.

### Human Tooling

- **`thread-cli.mjs`** — Zero-dep CLI: list, status, watch, tail, inbox, send (with expects/re/urgency), delete threads; human as full protocol citizen.
- **`postbox-mcp.mjs`** — MCP stdio server; any MCP-capable agent (Claude Code, Codex) becomes a Postbox thread; exposes six protocol tools.
- **`postbox-hook.mjs`** — Claude Code hook; push-style delivery: cold-start drain, turn-start, post-tool-use, stop-block.

### Customization

- **Per-Project Prompt Overrides** — `.thread/prompts/<role>.md` replaces bundled role prompt entirely; no code changes.
- **Worker Model Config** — `.thread/models.json` maps role → model; prefix-matched; `"default"` fallback.
- **Self-Improving Coordinator** — Writes discovered rule gaps to prompt override files; survives reinstalls.

### CLI Flags

- **`--thread-id`** — Stable thread identity; the opt-in trigger.
- **`--thread-role`** — Explicit role override (auto-detected from id otherwise).
- **`--thread-parent`** — Parent thread id (defaults to `coordinator`).
- **`--thread-journal`** — Journal cadence: `turn`, `done`, or `off`.
- **`--thread-journal-model`** — Model for journal fork entries.
- **`--thread-storage`** — Backend: `local` or `restate`.
- **`--thread-storage-url`** — Backend connection URL (Restate ingress).

## How it works

Each `pi` process becomes a **thread** with a stable identity. Threads communicate through durable per-thread mailboxes — one thread writes an envelope, the target drains it on startup or via live updates. By default the mailbox is local files (no central broker, no external dependencies); a pluggable `StorageAdapter` means the same tools/commands also work against a durable backend (Restate) that can wake a stopped thread — see [Running with the Restate adapter](#running-with-the-restate-adapter).

The extension is opt-in: it only activates for a session launched with `--thread-id <id>` (or resuming one that was). Without that flag, loading this extension has no effect at all — no `.thread/` directory, no `thread_*` tools, no system-prompt changes.

The protocol is specified in [PROTOCOL-FORMALISM.md](PROTOCOL-FORMALISM.md) (Postbox — the Thread Messaging Protocol); implementation notes live in [THREAD-MODEL.md](THREAD-MODEL.md).

## Install

```bash
# From your private GitHub repo:
pi install git:github.com/ktappdev/pi-threading@main

# Or try it without installing:
pi -e git:github.com/ktappdev/pi-threading@main --thread-id my-thread
```

## Usage

Start any number of pi processes in the same working directory, each with a unique `--thread-id`:

```bash
# Coordinator (role auto-detected from id)
minipi --thread-id coordinator

# Workers (role + parent auto-detected from id)
minipi --thread-id builder
minipi --thread-id explorer
minipi --thread-id tester

# Prefix matching: builder-1 → role "builder"
minipi --thread-id builder-1
minipi --thread-id reviewer-a

# Generic worker: any id not matching a known role
minipi --thread-id my-worker
```

`--thread-role` and `--thread-parent` are now optional. Role is auto-detected from `--thread-id` (exact match or prefix: `builder-1` → `builder`). Parent auto-defaults to `coordinator` for non-coordinator threads.

Threads share state via `.thread/threads/<id>/` in the project directory. Each thread gets a journal, a state file, and an inbox for cross-thread envelopes.

## Worker Roles

Each thread has a role that shapes its system prompt. The role is auto-detected from `--thread-id`:

| Role                 | Subtype | Description                                                                           |
| -------------------- | ------- | ------------------------------------------------------------------------------------- |
| `coordinator`        | —       | Directs workers, delegates tasks, maintains project context. Cannot write/edit files. |
| `builder`            | Worker  | Implements code changes, edits files, runs type checks.                               |
| `reviewer`           | Worker  | Reviews diffs, audits for bugs/security/quality. Read-only.                           |
| `scout` / `explorer` | Worker  | Explores codebase, finds files, answers architecture questions. Read-only.            |
| `tester`             | Worker  | Writes and runs tests, reproduces bugs, checks coverage.                              |
| `designer`           | Worker  | Designs UI specs for builder implementation. Read-only.                               |

Prefix matching: `builder-1`, `builder-a`, `builder_foo`, `builder.task` all resolve to role `builder`. Any id that doesn't match a known role (or prefix) defaults to a generic `worker` role with base worker rules only.

## Worker Models

Override which LLM model each worker role uses via `.thread/models.json`:

```json
{
  "builder": "anthropic/claude-sonnet-4",
  "reviewer": "anthropic/claude-haiku-4",
  "explorer": "anthropic/claude-haiku-4",
  "default": "anthropic/claude-sonnet-4"
}
```

- Roles match by prefix (e.g., `builder` key matches `builder-1`, `builder-a`)
- Falls back to `"default"` key, then to minipi's default model
- Coordinator reads this file on startup and passes the model to each worker spawn command
- Human operator can manage via slash command:

| Command                                            | Effect                        |
| -------------------------------------------------- | ----------------------------- |
| `/thread-models`                                   | Show current config           |
| `/thread-models builder anthropic/claude-sonnet-4` | Set model for a role          |
| `/thread-models --reset`                           | Delete file, restore defaults |

## Coordinator Mode

When a thread has role `coordinator` (auto-detected from `--thread-id coordinator`):

- **Write/edit tools are disabled** — coordinator reads, searches, and delegates only
- **Bash is read-only** — `ls`, `grep`, `find`, `cat`, plus `herdr` commands for pane management
- **Auto-spawns workers via [herdr](https://github.com/earendil-works/herdr)** — a terminal multiplexer that manages panes and tabs
- **Pane reuse** — checks existing panes first, reuses idle/done workers instead of spawning duplicates
- **Layout** — spawns workers in the same tab, 50/50 split (coordinator left, workers stacked in right column)
- **Model config** — reads `.thread/models.json` for per-role model overrides when spawning
- **Self-improving** — updates its per-project prompt override (`.thread/prompts/coordinator.md`) when it discovers gaps in rules, workflow, or defaults during operation

## Customizing Prompts

Each role's system prompt comes from a bundled default in `src/core/system-prompt.ts`. You can override a role's entire prompt block with a markdown file in your project — no code changes, no reinstall needed.

Create `.thread/prompts/<role>.md` at your project root (the git repo root, or cwd if not in a repo):

```
.thread/
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
- Loaded once at thread startup — no hot reload. Restart the thread after editing.

**Self-improvement:** When a coordinator discovers a gap in its rules during operation, it writes to these override files — not to the extension source. This survives reinstalls and is safe to commit to your project repo.

Sample overrides to copy: [`examples/prompts/`](examples/prompts/).

## Journal Compaction

Journal entries are append-only, so a long-running thread can grow `journal.md` without bound. Compaction keeps the file bounded by summarizing the oldest entries into a single block and keeping the most recent ones verbatim.

**Automatic:**

- Triggers at `agent_end` when the journal has more than 500 entries.
- Summarizes all but the most recent 100 entries into a single `<!-- COMPACTION <ts> -->` block.
- 24-hour cooldown between compactions (enforced by a marker in the file, no extra state).
- The summarization runs as a forked `pi` process — no in-process LLM call, fire-and-forget, never blocks the thread.
- The new content is re-read under the journal lock just before writing, so any entries appended during the fork are preserved.

**Manual control via `/thread-journal`:**

| Subcommand                | Effect                                                 |
| ------------------------- | ------------------------------------------------------ |
| `/thread-journal`         | Show last 12 entries                                   |
| `/thread-journal tail N`  | Show last N entries                                    |
| `/thread-journal status`  | Entry count, file size, oldest and newest timestamps   |
| `/thread-journal trim N`  | Keep only the last N entries (no fork)                 |
| `/thread-journal clear`   | Delete the journal file                                |
| `/thread-journal compact` | Force compact now (even under the 500-entry threshold) |

## The message model

There is **one message shape** — the envelope — and two optional fields give it meaning:

```
Envelope {
  id            own identity — minted per send, form <from>/<ulid>
  from, to      sender / target thread id
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

There are no message types on the wire and no locks anywhere: a thread that wants to block on a reply arms a **barrier** (`wait=true` or `thread_wait`) and ends its turn — the reply wakes it. A live back-and-forth (a "meeting") is a convention: request "meet?" → reply ok/busy → exchange of high-urgency notes → note "closing". A scheduled self-wake is just an envelope to your own id with `deliverAfter`.

Messages arrive as `[<kind> from <sender> #<id>]` — kind (request/reply/reply+request/note) is derived from the fields, and requests carry an explicit reply hint so receivers always know the id to echo back as `re`.

### Tools available to the LLM

| Tool             | Purpose                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread_send`    | Send an envelope — to one id, `a,b`, `*`, or `role:<role>`; `expects`, `re`, `urgency`, `deliverAfterSeconds`, `wait=true` (arm a barrier inline) |
| `thread_wait`    | Wait for all/any of several outstanding replies (barrier) — accepts `deadlineSeconds` and an optional `message` payload injected on resolution    |
| `thread_status`  | Read this thread's state, obligations, owed replies, barriers, and journal                                                                        |
| `thread_list`    | List all known threads in the workspace                                                                                                           |
| `thread_journal` | Read another thread's journal — filter by `tail`/`lookbackMinutes`                                                                                |
| `thread_suspend` | Mark thread On Hold — inbox queues until resume (client-local, not protocol)                                                                      |
| `thread_resume`  | Resume from On Hold and drain queued messages (client-local, not protocol)                                                                        |

### Slash commands

| Command                    | Purpose                                    |
| -------------------------- | ------------------------------------------ |
| `/thread-status`           | Show state and latest journal entry        |
| `/thread-list`             | List all known threads                     |
| `/thread-send <to> <body>` | Send a high-urgency note to another thread |
| `/thread-suspend`          | Mark On Hold                               |
| `/thread-resume`           | Resume from On Hold                        |
| `/thread-models`           | Show/set/reset worker model config         |
| `/thread-journal`          | View, trim, clear, or compact the journal  |

## Flags

- `--thread-id <id>` — stable identity for this thread (e.g., `coordinator`, `worker-a`); also the opt-in trigger — omit it and the extension does nothing
- `--thread-role <role>` — role label, targetable via `thread_send to="role:<role>"`. Optional — auto-detected from `--thread-id` (exact match or prefix: `builder-1` → `builder`). Known roles: coordinator, builder, reviewer, scout/explorer, tester, designer. Unknown ids default to `worker`.
- `--thread-parent <id>` — parent thread id, the escalation target ("I'm stuck" → request to parent at high urgency). Optional — auto-defaults to `coordinator` for non-coordinator threads.
- `--thread-journal <turn|done|off>` — journal cadence (default `turn`; each entry is one forked model call, rate-limited to one entry per ~2 minutes of same-task tool turns, plus a wrap-up entry when a run ends with unjournaled work; structural changes — new obligations, barriers — always journal immediately)
- `--thread-journal-model <model>` — model for the journal fork (e.g. `deepseek/deepseek-chat` to keep entries cheap). Default: the thread's own model. A pinned model must resolve on the machine the thread runs on, or journaling fails (loudly, on stderr)
- `--thread-storage <local|restate>` — storage backend (default `local`, the filesystem; see [Running with the Restate adapter](#running-with-the-restate-adapter))
- `--thread-storage-url <url>` — backend connection URL (e.g. a Restate ingress URL); ignored by the local backend

## Human monitoring & steering

`bin/thread-cli.mjs` lets a human act on the thread system without running pi — a full protocol citizen over plain files:

```bash
node bin/thread-cli.mjs list                      # table of all threads incl. coordination counts
node bin/thread-cli.mjs status link               # one thread's full coordination state:
                                                  #   obligations, owed replies, barriers,
                                                  #   pending inbox, last journal entry
node bin/thread-cli.mjs status link --json        # same, as machine-readable JSON
node bin/thread-cli.mjs watch                     # live coordination board
node bin/thread-cli.mjs tail link                 # follow one thread's state/journal/messages
                                                  #   (incl. +/- diffs of obligations/barriers)
node bin/thread-cli.mjs inbox link                # pending + recent messages
node bin/thread-cli.mjs send link "status?" --expects       # ask, tracked — thread owes you a reply
node bin/thread-cli.mjs send link "looks good" --re link/01ABC…  # reply, settles the debt
node bin/thread-cli.mjs send '*' "standup in 5"             # broadcast note
node bin/thread-cli.mjs delete link                         # remove a thread (refuses if it looks live)
node bin/thread-cli.mjs delete --stale --yes                # prune every stopped/stale thread
```

## Interop: MCP server for other coding agents

`bin/postbox-mcp.mjs` is a zero-dependency MCP (Model Context Protocol) stdio server: point any MCP-capable coding agent at it and that agent becomes a full Postbox thread over plain files — the same `.thread/threads/<id>/` binding pi and `thread-cli` speak, so a Claude Code or Codex session sends, receives, and settles reply debts with pi threads and each other, no pi process required on its side. It exposes the six protocol tools (`thread_send`, `thread_inbox`, `thread_wait`, `thread_status`, `thread_list`, `thread_journal`) and maintains the sending thread's presence and obligation/owed ledger in `state.json`. Identity comes from environment variables: `POSTBOX_THREAD_ID` (required), `POSTBOX_DIR` (workspace root, default cwd), and optional `POSTBOX_ROLE` / `POSTBOX_PARENT`.

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

Caveat — foreign agents are pull-delivery only: they see incoming messages when they call `thread_inbox` (drain now) or `thread_wait` (block until one arrives), and don't get pi's push injection into a live turn.

## State machine

```
IDLE → THINKING → WORKING → OPEN ──→ DONE

OPEN ──(suspend)──→ ON HOLD ──(resume)──→ OPEN
any ──(unclean exit)──→ STOPPED
```

There is no waiting state: debts and barriers are durable records, not states, so nothing needs repair on restart beyond `done/stopped → idle`. Full detail in [PROTOCOL-FORMALISM.md](PROTOCOL-FORMALISM.md) §11–§13.

## Running with the Restate adapter

The default `local` backend is the filesystem — durable enough for a crash, but a stopped `pi` process obviously can't watch its own inbox or fire its own heartbeat while it isn't running. The `restate` backend trades "no dependencies" for one real capability the local backend structurally cannot offer: **waking a stopped thread**. A `deliverAfter` envelope coming due for a stopped thread causes the companion service to spawn `pi` back up, because the mailbox and its timer live in Restate, not in the process that armed it.

This backend has a real operational footprint — three things need to be running:

1. **A self-hosted `restate-server`** (single binary or Docker), e.g. `docker run --rm -p 8080:8080 -p 9070:9070 docker.io/restatedev/restate:latest`.
2. **The companion service**, which hosts the `Thread`/`ThreadRegistry` virtual objects: `npm run restate:serve` (listens on port 9080 by default). Three environment variables shape how it revives a stopped thread: `RESTATE_INGRESS_URL` — the ingress URL the spawned `pi` connects back to (default `http://localhost:8080`); `PI_THREAD_EXTENSION` — the path to this extension's entry point, passed to the spawned `pi` as `--extension` (omit if your `pi` config already loads it); and `PI_BIN` — the pi executable to spawn (default `pi` from PATH; required on Windows, where the npm-installed `pi` is a `.cmd` shim `spawn()` can't execute). The revived `pi` runs in the thread's original working directory, recorded in its state.
3. **Register the deployment** with the server's admin API (one-time, or after changing `src/restate/service.ts`):
   ```bash
   curl -X POST http://localhost:9070/deployments -d '{"uri":"http://localhost:9080"}'
   ```

Then start `pi` pointed at it:

```bash
pi --thread-id coordinator --thread-storage restate --thread-storage-url http://localhost:8080
```

Known limitations versus the local backend: `watchInbox` polls (every 2s) instead of getting an instant `fs.watch` notification — cold-start delivery at session_start is unaffected either way. A future-dated envelope's delayed self-check (`deliverDue`) can't be un-armed once scheduled (Restate has no public "cancel a delayed send" API) — it no-ops if the envelope was already drained by the time it fires. `bin/thread-cli.mjs` (the human monitoring CLI above) is a standalone, zero-dependency script that only ever reads the local filesystem layout — it won't see threads running against the Restate backend.

## Tests

```bash
npm run test:unit         # ~120 cases, milliseconds, no API cost — deterministic logic
npm run test:e2e          # ~10 cases, minutes, real model calls — tool discovery & process boundaries
npm run test:e2e:restate  # ~6 cases, needs Docker, no API cost — RestateAdapter against a real restate-server
npm test                  # test:unit + test:e2e
```

Three tiers, deliberately: `test:unit` drives the extension's own tool/command/inbox/adapter logic directly against a stubbed `pi` (no subprocess), covering targeting, correlation, dedup, error handling, and — via a small fake in-memory `StorageAdapter` — that the core logic doesn't secretly depend on the filesystem. `test:e2e` spawns a real `pi` process per case and is kept small — each test there earns its place by proving something only a live model or a real subprocess boundary can (ambiguity resolution, envelope comprehension, cross-process durability, journal forking). `test:e2e:restate` is separate because it needs Docker rather than API credits — it proves `RestateAdapter` and the `Thread`/`ThreadRegistry` service actually work against a real `restate-server`, not just against the type checker. See [TESTING.md](TESTING.md) before adding a new test.

## License

MIT
