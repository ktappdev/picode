# Changelog

All notable changes to picode are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.5.12] — 2026-07-17

### Fixed

- **Tokens-per-second** in custom footer used message start time as end time, producing 1000x inflated values (e.g., 430000 t/s). Now captures real end time via `message_end` handler. New `computeTps` helper with 7 unit tests. Branch-filtered iteration.

- **`deadlineFromSeconds`** had an obfuscated no-op unit conversion and no guard for zero/negative inputs — now explicit and validates.

### Changed

- **Footer layout** is now dynamic: 2 rows on terminals ≥100 cols, 3 rows on narrower terminals. Threshold driven by `buildStatsRows(width)`. Prevents stats-line truncation in small panes.

### Added

- **"Never be idle when work is pending"** coordinator rule — workers should be reassigned or shut down, not left idle.

## [0.5.11] — 2026-07-17

### Added

- **`bug-hunter`** worker subtype — read-only, focused on finding bugs and reporting with `file:line` refs. Emoji: 🐛. Auto-detected from `bug-hunter` or `bug-hunter-*` thread-id prefix.

- **"Use explorer or bug-hunter for bug investigations"** coordinator rule — coordinator delegates spelunking, preserves its own context for routing.

- **"Parallelize unrelated new tasks"** coordinator rule — new work arriving while a worker is mid-task gets a fresh worker pane, not queued.

### Changed

- **Explorer** subtype now has an explicit summarization output contract — return TL;DR + numbered findings with `file:line` refs + suggested next steps. Never dump raw grep output or full file contents. Goal: keep coordinator context lean.
