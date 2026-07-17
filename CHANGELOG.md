# Changelog

All notable changes to picode are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.5.13] — 2026-07-17

### Added

- **Strict-reply contract for all worker subtypes** — every worker prompt (builder, reviewer, scout, explorer, designer, tester, bug-hunter) now includes an explicit communication contract block: always reply to coordinator requests, report results, then await next task. Prevents silent workers from dropping tasks.

- **Silent-recovery coordinator rule** — coordinator now has explicit guidance for detecting and recovering from silent workers: check `thread_status` for owed replies, re-send if no response within deadline window.

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
