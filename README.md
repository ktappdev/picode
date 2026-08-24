# picode

picode lets you run several [pi](https://github.com/earendil-works/pi-coding-agent) sessions at once and have them talk to each other. Each session becomes a "picode" with a stable name. One can be the coordinator that hands out work, and the rest are workers that build, review, explore, or test. They pass messages through durable mailboxes stored on disk, so nothing is lost when a picode restarts.

The point is simple: split a big task across multiple AI threads without any of them losing context or forking their own history.

## What you get

- A coordinator that delegates work and reads results, without ever writing files itself.
- Workers that self-label by name (builder-1, explorer-a) and know their role automatically.
- A single message shape called an envelope, with replies tracked as durable "debts" so nothing falls through the cracks.
- A live journal per picode, auto-summarized so it stays readable.
- A human command line tool to watch, steer, and message any picode.
- A pluggable storage backend: plain files by default, or Restate if you need to wake stopped picodes.

## Requirements

You need a few things installed first:

- **[pi](https://github.com/earendil-works/pi-coding-agent)**, the coding agent this extension runs on:
  ```bash
  npm install -g @earendil-works/pi-coding-agent
  ```
- **Node.js 20 or newer.**
- **An LLM provider.** At minimum an [OpenRouter](https://openrouter.ai/) key works (free models are fine). Anthropic, OpenAI, Google, and local Ollama are also supported.
  ```bash
  export OPENROUTER_API_KEY=sk-or-...
  ```
- **[Herdr](https://github.com/earendil-works/herdr)**, a terminal multiplexer, if you want the coordinator to spawn and manage workers automatically.
  ```bash
  brew install earendil-works/tap/herdr   # macOS
  ```
  Without Herdr you can still run workers manually in separate terminals. The coordinator just can't auto-spawn panes.
- **[Hypa](https://github.com/earendil-works/hypa)** (optional) — compression extension that reduces context usage for read, grep, find, and ls operations. Scouts and explorers prefer it automatically when installed, keeping exploration outputs lean and fast.
  ```bash
  pi install git:github.com/earendil-works/hypa@main
  ```
- **Docker** is only needed for the optional Restate backend.

## A note on commands in this guide

The examples below use a shell alias called `picode` that expands to `pi --picode-id`. So:

```bash
picode coordinator
```

is the same as:

```bash
pi --picode-id coordinator
```

Set up the alias once in your shell config if you like:

```bash
alias picode='pi --picode-id'
```

If you would rather not, just type the full `pi --picode-id <name>` form everywhere you see `picode <name>`. Installing the extension itself still uses the `pi install` command.

## Install

```bash
pi install git:github.com/ktappdev/picode@main
```

Or try it without installing:

```bash
pi -e git:github.com/ktappdev/picode@main --picode-id my-picode
```

## Quick start

Open a few terminals. In each one, start a picode with a unique name:

```bash
# Terminal 1: the coordinator
picode coordinator

# Terminal 2: a builder
picode builder

# Terminal 3: an explorer
picode explorer

# Terminal 4: a visual reader (requires a multimodal model)
picode visionary --model YOUR_PROVIDER/YOUR_VISION_MODEL
```

That is the whole setup. Each picode figures out its role from its name. A name like `builder-1` or `reviewer-a` becomes the `builder` or `reviewer` role automatically. Any name that does not match a known role becomes a generic worker.

The extension does nothing unless you pass a name. Without `--picode-id` (or the `picode` alias), there is no `.picode/` directory, no tools, and no prompt changes. It stays completely out of your way.

All picodes in the same working directory share state through `.picode/picodes/<name>/`.

## How it works

Each pi process becomes a picode with a stable identity. Picodes talk through durable per-picode mailboxes. One picode writes an envelope, and the target drains it on startup or as new messages arrive.

By default the mailbox is just files on disk. No central broker, no extra services. The storage layer is a pluggable adapter, so the exact same tools also work against Restate, a durable backend that can wake a stopped picode.

The protocol (called Postbox) is fully specified in [THREAD-MODEL.md](THREAD-MODEL.md).

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

| Tool                | Purpose                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `picode_send`       | Send an envelope to one name, `a,b`, `*`, or `role:<role>`. Supports `expects`, `re`, `urgency`, `deliverAfterSeconds`, `wait=true` to arm a barrier inline.                                |
| `picode_wait`       | Wait for all or any of several outstanding replies (a barrier). Accepts `deadlineSeconds` and an optional `message` injected on resolution.                                                 |
| `picode_status`     | Read this picode's state, obligations, owed replies, barriers, and journal.                                                                                                                 |
| `picode_list`       | List all known threads in the workspace.                                                                                                                                                    |
| `picode_journal`    | Read another picode's journal, filtered by `tail` or `lookbackMinutes`.                                                                                                                     |
| `picode_suspend`    | Mark this picode On Hold. The inbox queues until resume.                                                                                                                                    |
| `picode_resume`     | Resume from On Hold and drain queued messages.                                                                                                                                              |
| `picode_panes`      | Survey all Herdr panes: status, role, position, reuse/cleanup suggestions. Read-only workspace surveillance.                                                                                |
| `picode_pane_read`  | Read a worker pane's terminal output (scrollback). Use for silent worker recovery — when a worker owes a reply but hasn't sent via picode_send.                                             |
| `spawn_worker`      | Spawn a new worker pane: splits, names, launches pi, waits for idle. Auto-reuses idle workers, claims empty panes, grid-aware split direction. Optional `tab` param for multi-tab spawning. |
| `picode_tab_create` | Open a new Herdr tab in the current workspace for spawning workers when the current tab is full. Returns `tab_id` + `root_pane_id`. Coordinator-only.                                       |
| `picode_tab_close`  | Close an empty or stale Herdr tab. Refuses coordinator's own tab and tabs with working panes. `force=true` to close idle/done panes too. Coordinator-only.                                  |
| `cleanup_panes`     | Close stale herdr worker panes. `dry_run=true` to preview. `pane_id="<id>"` to close one. `force=true` to close idle workers too (e.g. "close all").                                        |
| `picode_purge`      | Delete stale picode data directories. Safe — only removes threads with no pending debts.                                                                                                    |

## Slash commands for humans

| Command                    | Purpose                                           |
| -------------------------- | ------------------------------------------------- |
| `/picode-status`           | Show state and the latest journal entry.          |
| `/picode-list`             | List all known threads.                           |
| `/picode-send <to> <body>` | Send a high-urgency note to another picode.       |
| `/picode-suspend`          | Mark On Hold.                                     |
| `/picode-resume`           | Resume from On Hold.                              |
| `/picode-models`           | Show, set, or reset per-role worker model config. |
| `/picode-journal`          | View, trim, clear, or compact the journal.        |

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
| `designer`           | Worker  | Designs UI specs for the builder to implement. Read-only.                                                                                                                             |
| `visionary`          | Worker  | Reads attached or local images and reports grounded observations. Read-only; requires a multimodal model.                                                                             |
| `gauntlet`           | Worker  | Adversarial production hardener with split personalities (review → fix → test). Finds realistic production failures, fixes them, leaves regression tests. Full tools except dispatch. |

Prefix matching means `builder-1`, `builder-a`, `builder_foo`, and `builder.task` all resolve to the `builder` role. Any name that does not match a known role (or prefix) becomes a generic `worker` with base worker rules only.

### The communication contract

Workers reply to the coordinator only through `picode_send`. Plain text typed in a worker's pane reaches the human user, not the coordinator. If a worker answers in plain text, the coordinator never sees it and the human has to relay it. This contract is built into every worker prompt.

If a worker goes silent (no `picode_send` reply within about 10 minutes), the coordinator's recovery rule kicks in: read the worker's pane output, find the plain-text reply, and either accept it or resend the request while reminding the worker to use `picode_send`.

## Coordinator mode

When a picode has the `coordinator` role (auto-detected from the name `coordinator`):

- **Write, edit, and bash are disabled.** The coordinator cannot run shell commands or modify files. Quick targeted lookups (single grep, read known file path) go through [Hypa](https://github.com/earendil-works/hypa) tools when installed. Anything deeper — multi-file exploration, git operations, herdr commands — goes through workers via `spawn_worker` or `picode_send`.
- **Auto-spawns workers via [herdr](https://github.com/earendil-works/herdr).** A terminal multiplexer that manages panes and tabs.
- **Reuses panes.** It checks existing panes first and reuses idle or done workers instead of spawning duplicates.
- **Adaptive layout.** Workers split in the direction that keeps new panes close to square. Grid-aware splitting avoids tall stacks. Empty panes are claimed instead of splitting. The coordinator stays at 50 percent on the left and the worker area fills the right half.
- **Structured dispatch.** Tasks go out as Objective, Context, Constraints, Action Steps, Deliverables, and Prerequisites.
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

## Visual identification

- **Role emoji in the pane label.** Each herdr pane label shows the role with an emoji: `🧭 coordinator`, `🔨 builder`, `🔍 explorer`, `🛡️ reviewer`, `🎨 designer`, `👁️ visionary`, `🧪 tester`, `🐛 bug-hunter`, `👷 worker`.
- **Role in the terminal title.** The terminal title shows `pi · <emoji> <role> · <cwd>`, which is useful when you are not running inside herdr.
- **Coordination with herdr.** Herdr's pane label and the terminal title carry the same role info, so identification is consistent across surfaces.

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
