# Changelog

All notable changes to picode are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **New `presenter` worker role** — pure communication bridge between coordinator and user. Displays completed work in a clean, separate pane. Relays user messages/questions back to coordinator. Does no work on its own (no research, no edits, no code, no spawning workers). Spawn at task wrap-up via `spawn_worker(role="presenter")`.
- **Coordinator: "use the internet when in doubt" rule** — when uncertain, needs more info, or about to assume, coordinator should search using any available web search or URL fetch tools before directing workers. Works with any web extension (e.g. pi-web-access).
- **Journal model + cadence configurable via `/picode-models`** — the interactive model selector now includes a `journal` role and a `(journal cadence)` entry. Set a cheap model for journal forks and choose cadence (`turn`/`done`/`off`) without CLI flags. Both also configurable via `.picode/models.json` keys `"journal"` and `"journal-cadence"`. CLI flags (`--picode-journal-model`, `--picode-journal`) still override.
- **Journal model + cadence in auto-created default `models.json`** — fresh installs now get `"journal": "deepseek/deepseek-v4-flash"` and `"journal-cadence": "done"` out of the box, preventing 402 balance errors when the coordinator's model is out of quota.

### Changed

- **Journal cadence default is now `done`** — was `turn` (one forked LLM call per ~2 min of work). Now defaults to one entry per run at agent_end, drastically reducing background model calls. Still switchable to `turn` or `off`.

### Fixed

- **Journal fork 402 errors** — when the coordinator's model is out of balance, journal forks (and compaction forks) that inherited it would die silently. Now: fresh installs get a cheap journal model, users can set one via `/picode-models`, and 402/balance errors produce an actionable message pointing to `/picode-models`.

## [0.5.19] — 2026-07-18

### Removed

- **Custom picode footer** — removed the custom footer implementation (computeTps, buildStatsRows, formatTokens, etc.) and all footer reactivity. Picode now falls back to whatever footer the user has installed for pi. 430 lines removed.

### Fixed

- **cleanup_panes never closes coordinator** — added `HERDR_PANE_ID` check to skip the current pane unconditionally, preventing the coordinator from closing itself.
- **Coordinator sets agent_status to working** — coordinators now stamp their status as `working` at startup so cleanup_panes never considers them stale.

## [0.5.18] — 2026-07-17

### Added

- **Current-task widget** — workers now show the first line of their most recent incoming `picode_send` request above the input box (🎯 prefix), via `ctx.ui.setWidget("current-task", ...)`. Updates on new task arrival, workers only (coordinator excluded). `extractFirstLine` helper strips markdown headers/bold and truncates to 80 chars. 8 unit tests. `src/lifecycle.ts`.

### Fixed

- **Theme declaration in package manifest** — added `pi.themes` to `package.json` so pi discovers and loads picode's bundled themes on install. `e95d842`.

### Docs

- **Quick Start section** — added a top-level install + run walkthrough to `README.md` with fenced code blocks for `pi install`, worker launch, and coordinator launch. Links to Coordinator Mode and Worker Roles sections.
- **Duplicate README section headings** — renamed `###` under Features to `Coordinator features`, `Worker role types`, and `Journal features` to avoid confusion with the `##` top-level sections (`Coordinator Mode`, `Worker Roles`, `Journal Compaction`).

## [0.5.17] — 2026-07-17

### Fixed

- **Slash command error handling** — 5 commands (`/picode-status`, `/picode-journal`, `/picode-list`, `/picode-suspend`, `/picode-resume`) now wrap their handler bodies in try/catch with `ctx.ui.notify` on error, matching the pattern from `/picode-send` and `/picode-models`. Previously, errors propagated to pi's command wrapper silently.

### Added

- **4 missing unit tests** — `/picode-list` and `/picode-models` had zero test coverage. Both now have tests. Added `cwd` to test harness ctx (was `undefined`, caused `/picode-models` handler to crash in tests).

## [0.5.16] — 2026-07-17

### Changed

- **Example prompts refreshed** — `examples/prompts/worker.md` now includes the Communication contract block (`picode_send` mandate, plain-text warning) that the bundled `WORKER_BASE_RULES` ships with since v0.5.13. `examples/prompts/coordinator.md` now includes bug-hunter delegation + the four coordinator rules (bug-investigation, parallelize, always-be-working, silent-recovery). `examples/prompts/builder.md` is unchanged in behavior (minor genericization only).

## [0.5.15] — 2026-07-17

### Fixed

- **`/picode-send` body-size guard gap** — the slash command previously called `inbox.sendToMany` directly, bypassing the 256KB body-size guard added to `picode_send` in v0.5.14. An operator could `/picode-send alice <5MB blob>` and overflow the inbox dir. Now the command applies the same `checkBodySize` guard before queuing, with the same error message format. `src/commands.ts:150-156`.

## [0.5.14] — 2026-07-17

### Added

- **`picode_send` body-size guard** — `src/tools/messaging.ts:8` exports `MAX_BODY_BYTES = 256 * 1024` (256 KB) and a `checkBodySize(body)` helper that returns an error string when the UTF-8 byte length of the body exceeds the limit. The `picode_send` executor (`src/tools/messaging.ts:117-120`) calls the guard before any inbox work, so oversize payloads never touch the disk. `sendToMany` is transitively covered since it calls `send`. Error message includes the actual size, the limit, and a recovery hint ("split into multiple sends, or use file refs for large content"). 5 new unit tests covering boundary, UTF-8 multibyte, empty body, and sendToMany.

## [0.5.13] — 2026-07-17

### Added

- **Strict-reply contract for all worker subtypes** — `WORKER_BASE_RULES` in `src/core/system-prompt.ts` now leads with a "Communication contract" block reminding every worker (builder, reviewer, scout, explorer, designer, tester, bug-hunter) that they must reply via `picode_send` with `re=<id>`. Plain text output in a worker's pane reaches only the human user, not the coordinator.

- **Silent-recovery coordinator rule** — COORDINATOR_RULES now includes "Worker silent? Check their pane": if a worker hasn't sent a `picode_send` reply within 5–10 minutes, the coordinator should read the worker's pane output (visible to the human user) to find any plain-text reply, then either accept it or resend the request explicitly reminding the worker to use `picode_send`.

## [0.5.12] — 2026-07-17

### Fixed

- **tokens-per-second in custom footer** — was using `m.timestamp` (message start) as the end time, producing 1000x inflated values (~430000 t/s). Now captures real end time via `message_end` handler. `computeTps` helper with 7 unit tests.
- **`deadlineFromSeconds` no-op guard** — time.ts had an obfuscated multiplication-by-1 unit conversion and no protection against zero/negative inputs. Now explicit and validates.

### Changed

- **Dynamic footer layout** — 2 rows on terminals ≥100 cols (`dir` / `model • thinking  ctx  ↑in ↓out  t/s`), 3 rows on narrower terminals (splits stats into two lines). Prevents truncation in small panes. `buildStatsRows` helper with 6 unit tests.

### Added

- **"Always be working" coordinator rule** — workers should be reassigned or shut down, not left idle when work is pending.

## [0.5.11] — 2026-07-17

### Added

- **`bug-hunter` worker subtype** — read-only bug-finding specialist. Reports root cause with `file:line` refs and suggested fix (one paragraph); does NOT implement. Auto-detected from `bug-hunter` or `bug-hunter-*` picode-id. Emoji: 🐛. Model: `deepseek/deepseek-v4-pro`.
- **"Use explorer or bug-hunter for bug investigations" coordinator rule** — coordinator delegates bug investigations, never spelunks code itself.
- **"Parallelize unrelated new tasks" coordinator rule** — spawn new workers in parallel instead of queuing on busy ones.

### Changed

- **Explorer summarization contract** — explorers now follow an output contract: return TL;DR + numbered findings with `file:line` refs + suggested next steps. Must not dump raw grep output or full file contents.
