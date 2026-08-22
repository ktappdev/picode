# AGENTS.md — Picode Project Conventions

## Project Overview

**Picode** is a cross-picode communication extension for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). It enables independent threads that coordinate work, share state, and converse — without losing context or forking their history.

**Key Features:**

- Picode-based multi-agent coordination (coordinator + worker roles)
- Durable per-picode mailboxes with envelope message model
- Auto-journaling with compaction
- Read-only coordinator mode with auto-spawned workers
- Pluggable storage backends (local filesystem, Restate)
- Per-project prompt overrides and worker model configuration

**Version:** 0.5.19 (as of this writing)

## Architecture

### Directory Structure

```
picode/
├── src/
│   ├── adapter/          # Storage backends (local-fs.ts, restate)
│   ├── core/             # System prompt loader, types, roles, time utilities
│   ├── prompts/          # Role prompts as markdown files (coordinator, builder, reviewer, etc.)
│   ├── tools/            # Picode tools (send, wait, status, list, journal, suspend, resume, purge, spawn, cleanup-panes, pane-read)
│   ├── restate/          # Restate backend adapter + service
│   ├── commands.ts       # Slash commands (/picode-status, /picode-journal, etc.)
│   ├── inbox.ts          # Envelope delivery, barriers, obligations, injection gate
│   ├── index.ts          # Extension entry point (registers all tools/commands)
│   ├── journal.ts        # Auto-journaling with compaction (turn/done/off modes, default done)
│   ├── lifecycle.ts      # Picode lifecycle (startup, footer, widget, state machine, auto-purge)
│   └── state.ts          # Picode state management, heartbeats, watcher
├── bin/
│   ├── picode-cli.mjs    # Human monitoring CLI (list, status, watch, tail, send)
│   └── postbox-mcp.mjs  # MCP server for external agents (Claude Code, Codex)
├── themes/               # Bundled TUI themes (7 themes)
├── skills/               # Bundled skills (herdr, cleanup-panes)
├── examples/
│   ├── briefs/           # Role briefs (dev.md, lead.md)
│   ├── prompts/          # Sample prompt overrides
│   └── two-teams.sh      # Multi-team setup script
├── test/
│   ├── unit.test.ts      # ~196 unit tests
│   ├── e2e.test.ts       # ~10 end-to-end tests (real model calls)
│   └── e2e-restate.test.ts # Restate backend tests
├── integrations/         # Integration helpers
├── package.json
├── tsconfig.json
├── THREAD-MODEL.md       # Protocol specification
├── TESTING.md            # Testing guidelines
├── CHANGELOG.md          # Version history
└── README.md             # Full documentation
```

### Key Components

| Component                   | Purpose                                                                          |
| --------------------------- | -------------------------------------------------------------------------------- |
| `src/prompts/*.md`          | Role prompts as markdown files — **edit these to change agent behavior**         |
| `src/core/system-prompt.ts` | Prompt loader — reads from `src/prompts/`, adds dynamic context (picodeId, role) |
| `src/inbox.ts`              | Envelope delivery, barrier resolution, obligation tracking                       |
| `src/lifecycle.ts`          | Picode startup, state machine, footer rendering, widget injection                |
| `src/state.ts`              | Picode state persistence, heartbeats, journal storage                            |
| `src/commands.ts`           | Slash command handlers                                                           |
| `src/journal.ts`            | Auto-journaling, compaction logic                                                |
| `src/adapter/local-fs.ts`   | Local filesystem storage backend                                                 |

## Development Commands

### Build & Type Check

```bash
npx tsc --noEmit              # TypeScript type check (no output = clean)
```

### Testing

```bash
npm run test:unit             # ~196 unit tests (fast, deterministic, no API cost)
npm run test:e2e              # ~10 E2E tests (real model calls, 5-25s each)
npm run test:e2e:restate      # ~6 Restate tests (needs Docker)
npm test                      # Run all tests (unit + e2e)
```

### Linting & Formatting

```bash
npm run lint                  # ESLint check
npm run format                # Prettier format (writes)
npm run format:check          # Prettier check (no writes)
```

### Other

```bash
npm run live                  # Live development mode
npm run restate:serve         # Start Restate companion service
npm run mcp                   # Start MCP server
```

## Testing

### Test Layers

| Layer    | What it proves                                                          | How                                                | Cost        |
| -------- | ----------------------------------------------------------------------- | -------------------------------------------------- | ----------- |
| **Unit** | Deterministic logic: state transitions, correlation, dedup, file writes | `makeHarness()` — stub pi, call functions directly | ~1ms        |
| **E2E**  | Model discovers correct tool from ambiguous language                    | Real pi subprocess + model call                    | 5-25s + API |
| **Eval** | Aggregate model judgment quality (not implemented)                      | N-sample runs, pass-rate threshold                 | Expensive   |

### Testing Rules (from TESTING.md)

1. **Every assertion must answer a question nothing else answers** — no redundant checks
2. **Pick the cheapest layer that proves the behavior** — unit if deterministic, E2E only if model judgment matters
3. **Assert behavior, not implementation** — what a caller depends on, not internals
4. **Negative paths aren't optional** — malformed JSON, duplicate replies, etc.
5. **One test, one reason to fail** — split if it can fail for two unrelated reasons
6. **Fixture hygiene** — per-test tmpDir isolation, no shared mutable state

### Adding Tests

- New E2E tests require justification (real model cost + flakiness liability)
- Default to unit tests for deterministic logic
- Every real bug becomes a permanent test at the cheapest layer

## Code Conventions

### TypeScript

- **ESM modules** (`"type": "module"` in package.json)
- **Strict type checking** via tsconfig.json
- **Import style:** Use `node:` prefix for Node.js built-ins (`node:fs`, `node:path`, `node:url`)
- **Path aliases:** Configured in tsconfig.json for `@/*` → `src/*`

### Naming Conventions

- **Files:** kebab-case for multi-word (`local-fs.ts`, `system-prompt.ts`)
- **Functions:** camelCase (`loadPromptOverride`, `checkDeadlines`)
- **Constants:** UPPER_SNAKE_CASE (`MAX_BODY_BYTES`, `JOURNAL_COMPACT_THRESHOLD`)
- **Types/Interfaces:** PascalCase (`StorageAdapter`, `Envelope`, `PicodeState`)
- **Role constants:** SCREAMING_SNAKE with `_RULES` suffix (`BUILDER_RULES`, `COORDINATOR_RULES`)

### Code Style

- **Prettier** enforced (`npm run format:check` must pass)
- **ESLint** with typescript-eslint
- **No unused imports** — clean import lists
- **Early returns** over deep nesting
- **Document non-obvious decisions** with comments

### Prompt Files

- Prompts live in `src/prompts/*.md` as plain markdown — no escaping needed
- Edit markdown files directly; `system-prompt.ts` loads them at module init
- Dynamic context (picodeId, parent, role) is added by the wrapper in `system-prompt.ts`
- Per-project overrides (`.picode/prompts/<role>.md`) extend the bundled prompt by default (append after bundled rules). Use `mode: replace` in frontmatter to replace entirely.

## Key Files

### Core Logic

| File                         | Responsibility                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/prompts/coordinator.md` | Coordinator rules + full herdr reference — **the prompt agents see at startup**                                                                                 |
| `src/prompts/worker-base.md` | Shared worker communication contract — all workers inherit this                                                                                                 |
| `src/prompts/<role>.md`      | Role-specific prompts (builder, reviewer, explorer, tester, designer, visionary, bug-hunter, scout, planner)                                                    |
| `src/core/system-prompt.ts`  | Prompt loader — reads markdown files, adds dynamic context, handles overrides                                                                                   |
| `src/inbox.ts`               | Envelope delivery, barrier resolution, obligation tracking, dead-letter handling. **Injection gate blocks during compaction**                                   |
| `src/lifecycle.ts`           | Picode startup, state machine, footer rendering, widget injection. **Auto-purges stale threads on coordinator startup. Footer shows model, ctx usage, io, t/s** |
| `src/state.ts`               | Picode state persistence, heartbeats, journal storage. **Heartbeat re-attempts inbox drain**                                                                    |
| `src/commands.ts`            | Slash command handlers (status, journal, send, models, suspend, resume)                                                                                         |
| `src/journal.ts`             | Auto-journaling, compaction logic, duplicate suppression. **Fires at turn_end or agent_end depending on mode**                                                  |
| `src/tools/spawn.ts`         | spawn_worker tool — splits pane, launches pi, waits for idle. **Reuses dead panes, validates role, multi-tab via `tab` param, returns `tab_full` signal**       |
| `src/tools/tab-create.ts`    | picode_tab_create tool — opens new Herdr tab in current workspace. **Coordinator-only, returns tab_id + root_pane_id**                                          |
| `src/tools/tab-close.ts`     | picode_tab_close tool — closes empty/stale Herdr tab. **Refuses coordinator tab, protects working panes, force=true for idle**                                  |
| `src/tools/cleanup-panes.ts` | cleanup_panes tool — closes stale herdr worker panes. **dry_run + targeted pane_id option available**                                                           |
| `src/tools/panes.ts`         | picode_panes tool — surveys all Herdr panes with status, role, position. **Read-only workspace surveillance**                                                   |
| `src/tools/pane-read.ts`     | picode_pane_read tool — reads worker pane terminal output. **Silent worker recovery, inspect blocked workers**                                                  |
| `src/tools/purge.ts`         | picode_purge tool + `purgeStalePcodes()` helper. **Called on coordinator startup**                                                                              |

### Storage & Backend

| File                      | Responsibility                                    |
| ------------------------- | ------------------------------------------------- |
| `src/adapter/local-fs.ts` | Local filesystem storage (default backend)        |
| `src/adapter/types.ts`    | StorageAdapter interface                          |
| `src/restate/adapter.ts`  | Restate virtual object adapter                    |
| `src/restate/service.ts`  | Restate companion service (Picode/PicodeRegistry) |

### CLI & Integration

| File                   | Responsibility                           |
| ---------------------- | ---------------------------------------- |
| `bin/picode-cli.mjs`   | Human monitoring CLI (zero dependencies) |
| `bin/postbox-mcp.mjs`  | MCP server for external agents           |
| `bin/postbox-hook.mjs` | Claude Code hook integration             |

## Safety Rules

### What NOT to Change

1. **Envelope format** — `Envelope` interface in `src/core/types.ts` is the wire format; changes break compatibility
2. **State file layout** — `.picode/threads/<id>/state.json` structure; other tools depend on it
3. **Tool names** — `picode_send`, `picode_wait`, `picode_status`, `picode_list`, `picode_journal`, `picode_suspend`, `picode_resume`
4. **Slash command names** — `/picode-status`, `/picode-journal`, `/picode-list`, `/picode-send`, `/picode-suspend`, `/picode-resume`, `/picode-models`
5. **Role names** — `coordinator`, `builder`, `reviewer`, `explorer`/`scout`, `tester`, `designer`, `visionary`, `bug-hunter`, `planner`, `runner`, `gauntlet`
6. **Message model** — Envelope shape with `expects`, `re`, `urgency`, `deliverAfterSeconds` fields

### Sensitive Areas

- **`src/prompts/*.md`** — Prompt changes affect all agents; test thoroughly with real model calls
- **`src/core/system-prompt.ts`** — Prompt loader; changes affect how prompts are assembled
- **`src/inbox.ts`** — Obligation/barrier logic; bugs cause silent message drops
- **`src/lifecycle.ts`** — State machine transitions; bugs cause picode death or stuck states
- **`src/adapter/local-fs.ts`** — File operations must be atomic (rename for enqueue)
- **`src/state.ts`** — Heartbeat and state persistence; corruption = picode identity loss

### Security Considerations

- **No secrets in prompts** — system-prompt.ts is user-facing
- **No shell injection** — sanitize any user input passed to bash commands
- **No file writes in coordinator mode** — coordinator tools are read-only by design
- **Picode IDs are user-controlled** — validate format, prevent directory traversal

## Extension Points

### Adding Themes

1. Create `themes/<name>.json` with the pi theme schema
2. Add to `package.json` `pi.themes` array if external, or place in `themes/` directory
3. Reference in `.picode/models.json` or spawn with `--theme <name>`

**Bundled themes:** tokyo-night, matrix, nord, dracula, gruvbox-dark, catppuccin-mocha, rose-pine

### Adding Skills

1. Create `skills/<name>/SKILL.md` with skill documentation
2. Add to `package.json` `pi.skills` array if external, or place in `skills/` directory
3. Skills are available to agents via the `read` tool

**Bundled skills:** herdr (terminal multiplexer), cleanup-panes

### Adding Prompt Overrides

1. Create `.picode/prompts/<role>.md` in your project root
2. **Default mode (extend):** Your file is appended after the bundled role prompt, wrapped in a "Project-Specific Rules (USER-ENFORCED)" section. Bundled rules stay active; your rules take precedence.
3. **Replace mode:** Add frontmatter `mode: replace` to fully swap the bundled prompt (legacy behavior):
   ```
   ---
   mode: replace
   ---
   ```
4. Supported roles: `coordinator`, `builder`, `reviewer`, `scout`, `explorer`, `designer`, `visionary`, `tester`, `bug-hunter`, `planner`, `runner`, `gauntlet`, `worker`
5. Empty files are ignored; unknown roles fall back to `worker.md`
6. Bundled prompts are in `src/prompts/*.md` — edit those to change defaults

### Adding Slash Commands

1. Add command handler in `src/commands.ts`
2. Register in the `registerCommands` function
3. Add to system prompt if model needs to know about it

### Adding Picode Tools

1. Create tool file in `src/tools/<name>.ts`
2. Register in `src/tools/index.ts`
3. Add to system prompt documentation

## Git Workflow

### Branch Naming

- `main` — stable, production-ready
- `feature/*` — new features
- `fix/*` — bug fixes
- `docs/*` — documentation changes
- `refactor/*` — code restructuring
- `test/*` — test additions/improvements

### Commit Conventions

Use conventional commits:

```
feat: add new tool for X
fix: resolve Y bug in Z
docs: update README for X
refactor: simplify W logic
test: add coverage for X
chore: update dependencies
```

### PR Process

1. Create feature/fix branch from `main`
2. Make changes, ensure `npx tsc --noEmit` passes
3. Run `npm run test:unit` (E2E tests optional for small changes)
4. Run `npm run format:check` and `npm run lint`
5. Commit with conventional message
6. Push and create PR
7. Squash merge to `main`

### Version Bumping

- Update `version` in `package.json`
- Add entry to `CHANGELOG.md`
- Commit with `chore: bump version to X.Y.Z`

## Common Tasks

### Adding a New Tool

1. Create `src/tools/<name>.ts` with tool definition
2. Export registration function
3. Add to `src/tools/index.ts`
4. Document in `src/core/system-prompt.ts` (COORDINATOR_RULES or role-specific)
5. Add unit tests in `test/unit.test.ts`
6. Update README.md if user-facing

### Modifying Coordinator Behavior

1. Edit `src/prompts/coordinator.md` (plain markdown, no escaping needed)
2. Test with real coordinator + workers (E2E)
3. Update `AGENTS.md` if conventions change

### Adding a Role

1. Create `src/prompts/<role>.md` with the role prompt
2. Add role to `WorkerSubtype` type, prompt loading, and `SUBTYPE_PROMPTS` map in `src/core/system-prompt.ts`
3. Add role detection in `src/core/roles.ts`
4. Add role emoji in `ROLE_EMOJI` map
5. Add read-only roles to `src/lifecycle.ts` when role cannot modify files
6. Add role to worker-pane cleanup/reclaim patterns and `/picode-models` display order
7. Update coordinator prompt, README, and `.picode/prompts/` documentation
8. Add unit coverage for detection, prompt composition, and role-specific wiring

### Fixing a Bug

1. Write a test that reproduces the bug (unit if possible)
2. Fix the bug
3. Verify test passes
4. Run full test suite to check for regressions
5. Commit with `fix: description` and reference issue if applicable

## Troubleshooting

### TypeScript Errors

```bash
npx tsc --noEmit 2>&1 | head -20  # Show first 20 errors
```

### Test Failures

```bash
node --import tsx --test test/unit.test.ts 2>&1 | tail -30  # Last 30 lines of output
```

### Format Issues

```bash
npm run format  # Auto-fix
npm run format:check  # Verify
```

### Picode Issues

```bash
node bin/picode-cli.mjs list  # See all threads
node bin/picode-cli.mjs status <id>  # Check specific picode
```

## Additional Resources

- [THREAD-MODEL.md](THREAD-MODEL.md) — Protocol specification
- [TESTING.md](TESTING.md) — Testing guidelines (read before adding tests)
- [CHANGELOG.md](CHANGELOG.md) — Version history
- [README.md](README.md) — Full documentation
- `src/prompts/` — Source of truth for all agent prompts (markdown files)
- `src/core/system-prompt.ts` — Prompt loader and dynamic context wrapper
