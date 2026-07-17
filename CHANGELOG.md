# Changelog

All notable changes to picode are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.5.15] — 2026-07-17

### Fixed

- **`/thread-send` body-size guard gap** — the slash command previously called `inbox.sendToMany` directly, bypassing the 256KB body-size guard added to `thread_send` in v0.5.14. An operator could `/thread-send alice <5MB blob>` and overflow the inbox dir. Now the command applies the same `checkBodySize` guard before queuing, with the same error message format. `src/commands.ts:150-156`.

## [0.5.14] — 2026-07-17

### Added

- **`thread_send` body-size guard** — `src/tools/messaging.ts:8` exports `MAX_BODY_BYTES = 256 * 1024` (256 KB) and a `checkBodySize(body)` helper that returns an error string when the UTF-8 byte length of the body exceeds the limit. The `thread_send` executor (`src/tools/messaging.ts:117-120`) calls the guard before any inbox work, so oversize payloads never touch the disk. `sendToMany` is transitively covered since it calls `send`. Error message includes the actual size, the limit, and a recovery hint ("split into multiple sends, or use file refs for large content"). 5 new unit tests covering boundary, UTF-8 multibyte, empty body, and sendToMany.

## [0.5.13] — 2026-07-17

### Added

- **Strict-reply contract for all worker subtypes** — `WORKER_BASE_RULES` in `src/core/system-prompt.ts` now leads with a "Communication contract" block reminding every worker (builder, reviewer, scout, explorer, designer, tester, bug-hunter) that they must reply via `thread_send` with `re=<id>`. Plain text output in a worker's pane reaches only the human user, not the coordinator.

- **Silent-recovery coordinator rule** — COORDINATOR_RULES now includes "Worker silent? Check their pane": if a worker hasn't sent a `thread_send` reply within 5–10 minutes, the coordinator should read the worker's pane output (visible to the human user) to find any plain-text reply, then either accept it or resend the request explicitly reminding the worker to use `thread_send`.

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
- **`bug-hunter` worker subtype** — read-only bug-finding specialist. Reports root cause with `file:line` refs and suggested fix (one paragraph); does NOT implement. Auto-detected from `bug-hunter` or `bug-hunter-*` thread-id. Emoji: 🐛. Model: `deepseek/deepseek-v4-pro`.
- **"Use explorer or bug-hunter for bug investigations" coordinator rule** — coordinator delegates bug investigations, never spelunks code itself.
- **"Parallelize unrelated new tasks" coordinator rule** — spawn new workers in parallel instead of queuing on busy ones.

### Changed
- **Explorer summarization contract** — explorers now follow an output contract: return TL;DR + numbered findings with `file:line` refs + suggested next steps. Must not dump raw grep output or full file contents.
