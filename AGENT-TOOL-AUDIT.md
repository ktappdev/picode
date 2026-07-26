# Agent and Tool Audit — Material Issues Only

**Date:** 2026-07-26  
**Scope:** Agent prompts, role loading/detection, lifecycle tool restrictions, messaging contract, Herdr pane tools, and related test coverage.  
**Status:** Findings captured before implementation. Fixes are now being applied in follow-up commits; this file remains the original material-issue checklist.

## Priority 1 — Broken behavior or security

### 1. `planner`, `runner`, and `explorer` do not get their intended roles

`picode <name>` launches Pi with `--picode-id`; `spawn_worker` also launches workers with `--picode-id` only. Role therefore depends on ID auto-detection.

`src/state.ts:159-168` auto-detects only:

```typescript
["builder", "reviewer", "scout", "designer", "tester", "bug-hunter"];
```

Consequences:

- `picode planner` becomes generic `worker`; planner prompt and read-only restrictions do not apply.
- `picode runner` becomes generic `worker`; runner prompt does not apply.
- `picode explorer` becomes generic `worker`, despite being documented as scout/explorer.
- Spawned planner/runner/explorer workers have same problem because `src/tools/spawn.ts:623-627` passes no `--picode-role`.
- Role-targeted messaging, role titles, role emoji, and model selection can diverge from requested role.

**Recommended direction:** Centralize canonical role/alias detection and use it in state initialization, prompt selection, model resolution, labels, cleanup, and spawn. Decide whether `explorer` is supported alias for `scout` or remove it everywhere.

---

### 2. Worker escalation instructions are rejected by messaging enforcement

Global communication prompt tells blocked workers to escalate with:

```text
picode_send(to=parent, expects=true, urgency="high")
```

See `src/core/system-prompt.ts:211` and `:299`.

Worker contract says workers must not send new requests to coordinator (`src/prompts/worker-base.md:9`), and `picode_send` enforces that prohibition in `src/tools/messaging.ts`.

A worker following the global escalation instruction therefore receives an error when parent is coordinator.

**Recommended direction:** Define one supported escalation path. Likely use a high-urgency note for unsolicited blockage, while retaining `re=<id>, expects=true` for follow-up on an existing coordinator request.

---

### 3. Pane IDs are interpolated into shell commands without validation

Model/user-provided `pane_id` values reach shell-built Herdr commands, including:

- `src/tools/cleanup-panes.ts:130`
- `src/tools/pane-read.ts` (`herdr pane read ${paneId} ...`)

The shared Herdr wrappers use `execSync("herdr " + args)`, so malformed pane IDs can inject shell syntax. `spawn_worker` validates role input, but pane tools do not apply equivalent validation.

**Recommended direction:** Validate pane IDs against Herdr's exact pane-ID grammar and/or invoke commands with argument arrays (`execFileSync`) rather than a shell string.

---

### 4. Prompt Markdown sections are concatenated without separators

`src/core/system-prompt.ts:158` and `:257` concatenate:

```typescript
WORKER_BASE_RULES + SUBTYPE_PROMPTS[subtype];
```

The outer template also places `roleBlock` immediately after the preceding sentence (`:174`, `:262`). Generated content can become:

```markdown
...multi-picode workspace.### Role: Worker
...
work lost.### Subtype: Builder
```

This can prevent headings from parsing and weakens role-boundary instructions for every agent.

**Recommended direction:** Join prompt blocks through one helper that guarantees `\n\n` separators. Build the shared communication block once rather than maintaining duplicate branches.

---

### 5. `spawn_worker` does not auto-suffix when same-role worker is busy

Coordinator prompt says a busy role auto-suffixes (`scout` → `scout-1`). Actual flow in `src/tools/spawn.ts:517-528` finds the existing matching pane and returns an error when status is `working` or `blocked`. It never reaches unique-ID generation.

This blocks intended parallel work unless coordinator knows to pass `reuse=false` or manually requests a suffixed ID.

**Recommended direction:** Reuse only idle/done panes. Treat a busy match as unavailable, then continue into unique-ID spawn automatically.

---

### 6. `spawn_worker` and roster-management tools are not coordinator-enforced

Worker prompt says only coordinator manages roster, but tool access does not enforce that rule. `spawn_worker` is registered without store/role context, and builders/generic workers retain it. Similar concern applies to cleanup and purge tools.

A worker that ignores or loses prompt instructions can spawn or remove panes and alter coordination structure.

**Recommended direction:** Enforce coordinator role in tool execution or remove coordinator-only tools from worker active-tool sets during lifecycle initialization.

---

### 7. Default cleanup closes `blocked` workers

Coordinator instructions define `blocked` as needing inspection/input (`src/prompts/coordinator.md:45`, `:161`, `:232`). Bulk cleanup in `src/tools/cleanup-panes.ts:187-199` protects only `working` and non-forced `idle`; `blocked` falls through to closure.

A proactive cleanup can destroy a worker precisely when coordinator should inspect its pane and unblock it.

**Recommended direction:** Protect `blocked` by default. Close it only through explicit targeted/forced action after inspection.

---

### 8. Non-blocking `picode_run` can delete its script before execution starts

`picode_run` writes a temporary script, sends `bash <script>` to a new pane, then returns immediately in non-blocking mode. The enclosing `finally` deletes the script immediately.

See `src/tools/run.ts`, especially non-blocking return followed by final temp-file cleanup. If the pane has not opened the script yet, the command fails because the file is gone.

**Recommended direction:** For non-blocking mode, make the launched shell own cleanup after reading/running the script, or retain the script until process completion.

## Priority 2 — Important contract/enforcement gaps

### 9. Prompt overrides omit supported roles

`OVERRIDABLE_ROLES` in `src/core/system-prompt.ts:85-95` omits at least `planner` and `explorer`, while `AGENTS.md` documents them as supported override roles.

`.picode/prompts/planner.md` and `.picode/prompts/explorer.md` therefore fall back to `worker.md` instead of loading the requested override.

**Recommended direction:** Derive overridable roles from the same canonical role registry used for role detection and prompt loading.

---

### 10. Ordinary Pi sessions keep Picode coordination tools active

When no Picode identity exists, lifecycle removes only active tools whose names begin with `picode_` (`src/lifecycle.ts:163-169`). These non-prefixed Picode tools remain visible:

- `spawn_worker`
- `cleanup_panes`

That conflicts with the extension's opt-in behavior and exposes Herdr coordination tools in unrelated Pi sessions.

**Recommended direction:** Maintain an explicit set of all extension-owned tools and remove that full set when Picode is inactive.

---

### 11. Runner safety and startup contract are not reliable

Runner is intended to be read-only but needs shell access. Lifecycle does not remove `write`/`edit` for runner, so this boundary is prompt-only.

Runner prompt also gives an invalid startup example:

```text
picode_send(body="Runner started. Awaiting tasks.")
```

`to` is required by the tool schema. The same prompt says all results use `re=<id>`, which a startup note cannot do before receiving a request.

**Recommended direction:** Disable write/edit for runner while retaining bash. Remove unsolicited startup send, or supply a valid parent target and clearly distinguish notes from request replies.

---

### 12. Targeted cleanup can close unrelated panes and can report false success

Targeted `cleanup_panes(pane_id=...)` intentionally skips worker-role validation. It protects current pane and `working` status, but can close unrelated idle/done panes if given their ID.

Both targeted and bulk close paths catch Herdr close failures and still report panes as closed (`src/tools/cleanup-panes.ts:128-134`, `:203-213`).

**Recommended direction:** Verify workspace/tab and worker ownership before closing. Return failed close operations separately rather than counting them as success.

---

### 13. Critical role and spawn behavior lacks behavioral tests

Current unit coverage does not execute key Herdr selection/spawn behavior. Missing regression coverage includes:

- Planner/runner/explorer role detection from `--picode-id`
- Busy same-role auto-suffix behavior
- Direction override preserving smart split target
- Coordinator pane preservation after first split
- Blocked-worker cleanup protection
- Non-blocking `picode_run` script lifetime
- Prompt block separation

Recent pane behavior changes therefore pass the suite without proving the behavior users depend on.

**Recommended direction:** Extract pure role and split-selection functions for deterministic unit tests. Add mocked Herdr command tests for spawn, cleanup, and run lifecycle behavior.

## Suggested repair order

1. Fix canonical role detection and explorer policy.
2. Fix worker escalation contract.
3. Remove pane-ID shell interpolation risk.
4. Fix prompt block assembly.
5. Fix busy-role suffix spawning.
6. Enforce coordinator-only roster tools.
7. Protect blocked workers during cleanup.
8. Fix non-blocking `picode_run` cleanup race.
9. Align overrides and inactive-session tool filtering.
10. Fix runner boundary/contract and targeted cleanup reporting.
11. Add behavioral regression tests alongside each repair.
