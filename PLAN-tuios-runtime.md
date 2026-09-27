# TUIOS Runtime Backend Migration Plan

**Status:** Experimental dual-runtime implementation; isolated multi-worker acceptance passed, restart/replay and saved-session revival still open
**Goal:** Let Picode run under either Herdr or TUIOS, selected explicitly or detected from the host environment, while preserving Picode's tool names, mailbox protocol, lifecycle behavior, and durable state.

## Outcome

Picode should support:

```text
PICODE_RUNTIME=auto    # default
PICODE_RUNTIME=herdr
PICODE_RUNTIME=tuios
```

`auto` selects the runtime from the current process environment. An explicit value always wins. If both runtime signatures are present and no explicit value was supplied, startup must fail clearly rather than controlling the wrong multiplexer.

The migration replaces only the **pane/process runtime**. It must not replace Picode's durable envelopes, barriers, obligations, journals, or `.picode` state with TUIOS's separate agent Inbox.

## Current Herdr surface

Herdr is currently called directly from multiple tools; there is no runtime abstraction yet.

| Concern                                                             | Current source                                                                   | Behavior to preserve                                                                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup guard, labels, stale cleanup, listener, sit-rep eligibility | `src/lifecycle.ts:87-98`, `src/lifecycle.ts:181-200`, `src/lifecycle.ts:388-440` | Coordinator requires a managed runtime; own pane is labeled; stale workers are cleaned before event subscription; listener stops on shutdown |
| Worker launch and reuse                                             | `src/tools/spawn.ts:42-883`                                                      | Reuse idle/done workers, reclaim empty/dead panes, split safely, launch `pi`, wait for readiness, return exact IDs, track created panes      |
| Workspace inventory and layout                                      | `src/tools/spawn.ts:176-408`, `src/tools/panes.ts:42-225`                        | Scope to the current workspace; report role/status/cwd; optionally report layout; never select the coordinator as a split target             |
| Pane output inspection                                              | `src/tools/pane-read.ts:26-129`                                                  | Read recent/visible output with line and style options; refuse own/out-of-scope panes                                                        |
| Cleanup                                                             | `src/tools/cleanup-panes.ts:38-319`                                              | Protect working/blocked workers, own pane, and user-owned `don't close` tabs; support targeted, bulk, dry-run, and force modes               |
| Tabs                                                                | `src/tools/tab-create.ts:32-116`, `src/tools/tab-close.ts:27-164`                | Create/close worker tabs without touching the coordinator or protected tabs                                                                  |
| Revive                                                              | `src/tools/revive.ts:120-426`                                                    | Reclaim/split a pane, resume the saved Pi session, send continuation mail, report freshness and warnings                                     |
| Scope/normalization helpers                                         | `src/tools/shared.ts:47-157`                                                     | Validate IDs, enforce workspace ownership, normalize stale agent status, preserve protected-tab rules                                        |
| Death notification                                                  | `src/herdr/listener.ts:102-319`                                                  | Subscribe to close/exit events, filter to tracked panes, inject system notices, reconnect, and stop cleanly                                  |

## Design decisions

1. **Keep Picode tool names stable.** `spawn_worker`, `picode_panes`, `picode_pane_read`, `cleanup_panes`, `picode_tab_create`, `picode_tab_close`, and `revive_closed_session` remain the public API.
2. **Use an adapter, not TUIOS-compatible Herdr shell commands.** TUIOS exposes a typed JSON socket protocol; use it as the primary implementation surface instead of parsing CLI text or pretending TUIOS is Herdr.
3. **Keep Herdr working first.** Add a `HerdrRuntime` adapter around the existing behavior, then add `TuiosRuntime`. This makes the refactor reversible and allows both backends to be tested against the same normalized contract.
4. **Resolve the runtime once per Picode process.** Tools must not independently infer the backend from whichever environment variable happens to be present at call time.
5. **Treat IDs as opaque.** Herdr's `workspace:resource` format must not leak into the generic contract. TUIOS IDs are different and must be validated by the adapter's scope lookup.
6. **Keep coordinator safety in Picode.** TUIOS grants are useful defense in depth, but they do not replace Picode's coordinator-only checks, workspace locks, protected-tab rules, or own-pane protection.

## Proposed runtime model

Add a small internal runtime contract, likely under `src/runtime/`:

```text
src/runtime/types.ts       normalized IDs, panes, tabs/workspaces, statuses, snapshots, events
src/runtime/detect.ts      explicit/auto runtime selection and environment validation
src/runtime/herdr.ts       current Herdr operations behind the contract
src/runtime/tuios.ts       TUIOS JSON-socket implementation
src/runtime/index.ts       selected runtime factory and lifecycle handle
```

The contract should cover only operations Picode actually needs:

- current runtime identity and scope
- snapshot/list panes, tabs/workspaces, and optional layout
- create/split/reclaim/close a pane
- create/close a worker tab equivalent
- rename a pane/window
- send interrupt keys
- run a command in a pane/window
- capture pane output
- inspect foreground process information
- wait for an agent state/readiness condition
- subscribe to relevant lifecycle events
- track/untrack Picode-owned pane IDs
- stop the subscription cleanly

Normalize runtime records into Picode-facing data:

```text
RuntimePane {
  id, scopeId, tabId, label, status, cwd,
  processRunning, foregroundProcesses?, rect?
}
```

The generic layer should not know whether a record came from a Herdr pane or a TUIOS window.

## Runtime selection

Implement the following precedence:

1. Read `PICODE_RUNTIME`.
2. If it is `herdr`, require the Herdr identity variables and use Herdr.
3. If it is `tuios`, require the TUIOS identity/socket variables and use TUIOS.
4. If it is `auto`, detect one runtime from its markers.
5. If no managed runtime is present, use `none` only for sessions that do not need pane management; preserve the current coordinator safety rule by refusing coordinator startup without a usable runtime.
6. If both signatures are present under `auto`, return an actionable ambiguity error naming both override values.
7. Display the resolved runtime in the startup/footer diagnostics.

The exact TUIOS identity variables must be confirmed against the installed daemon, but the current documentation identifies `TUIOS_SOCKET`, `TUIOS_PANE_ID`/`TUIOS_WINDOW_ID`, `TUIOS_PANE_TOKEN`, and session/workspace context. Do not infer scope from a TUIOS window ID; resolve it through the protocol when necessary.

Add tests for every branch, including inherited Herdr variables, missing sockets, malformed explicit values, and both runtimes present.

## TUIOS mapping to verify

Use this as the working model, then validate it with a live TUIOS session before implementation is considered complete:

| Picode concept            | Proposed TUIOS concept                                                 | Verification needed                                                                                             |
| ------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Herdr workspace           | TUIOS session                                                          | Confirm session is the stable isolation boundary for all worker windows                                         |
| Herdr tab                 | TUIOS workspace                                                        | Confirm workspaces can be created, named, selected, and closed with the required safety semantics               |
| Herdr pane                | TUIOS window/pane                                                      | Confirm IDs, process ownership, naming, and close/exit events                                                   |
| `working`                 | `working`                                                              | Direct mapping                                                                                                  |
| `blocked`                 | `needs_input`                                                          | Normalize to Picode's existing `blocked` status                                                                 |
| `idle`, `done`            | `idle`, `done`                                                         | Direct mapping                                                                                                  |
| `unknown`/stale process   | `unknown`/`errored`/heartbeat override                                 | Preserve `effectiveAgentStatus` behavior and define cleanup treatment for each state                            |
| pane split                | `split-window` or an equivalent `new-window` operation                 | Confirm target and direction behavior                                                                           |
| tab create                | TUIOS workspace creation or an explicitly documented equivalent        | Do not silently map this to an ordinary window if that breaks tab isolation                                     |
| pane read                 | `capture-pane`                                                         | Map `visible`, `recent`, styled output, and line limits; document any unavailable `recent-unwrapped` equivalent |
| pane close                | `close-window`/equivalent                                              | Confirm it emits a reliable exit/close event                                                                    |
| pane command launch       | `run`, `new-window`, `start-agent`, or command-bearing window creation | Prefer structured JSON parameters over shell interpolation                                                      |
| readiness wait            | `wait-for` with agent state or a launch-specific readiness check       | Confirm Pi reaches the state expected by existing spawn/revive behavior                                         |
| Herdr socket subscription | TUIOS `subscribe`                                                      | Filter to the selected session and tracked windows; handle sequence replay and daemon restarts                  |

TUIOS's documented protocol sources are:

- `/tmp/pi-github-repos/Gaurav-Gosain/tuios@main/docs/protocol.md`
- `/tmp/pi-github-repos/Gaurav-Gosain/tuios@main/docs/AGENT_STATE.md`
- `/tmp/pi-github-repos/Gaurav-Gosain/tuios@main/docs/HOOKS.md`

The live daemon's `list-verbs` response is authoritative. Record the verified verb/field names in the adapter tests rather than relying only on the checked-out documentation.

## Implementation status (experimental)

The Herdr code path remains intact, selected independently from the TUIOS backend rather than being mechanically wrapped in a new `HerdrRuntime`. TUIOS uses fixed workspace slots (no create/delete tab verb), and the compatibility `.herdr` socket accepts agent-state reports only. An isolated disposable daemon with TUIOS's Pi integration confirmed protocol responses, Pi readiness, two worker launches, same-directory reuse, different-directory non-reuse, pane capture, `picode_run` exit status, workspace clearing, and a tracked window-close notice. These calls were made through registered Picode tools with an isolated test coordinator context, **not** through a full interactive coordinator Pi session. TUIOS currently reports empty `cwd` for daemon-created Pi windows; Picode remembers the requested launch directory for windows it launched in this process and declines to reuse other windows without reliable cwd metadata. This does not detect a later cwd change inside the worker and is not persisted across coordinator restarts. Listener reconnect/replay across interruption or daemon restart and exact saved-session revival remain **unverified live**. Without the TUIOS Pi agent-state integration, running Pi windows can report `unknown`, so automated cleanup and tab-close refuse them. Use `PICODE_RUNTIME=herdr` for production rollback until all live acceptance gates pass.

## Implementation phases

### Phase 0 — Resolve remaining protocol questions

- [ ] Install/build the target TUIOS version used for testing.
- [ ] Start a disposable TUIOS session containing Pi workers.
- [ ] Record the outputs of `hello` and `list-verbs`.
- [ ] Confirm session, workspace, window, and current-pane identity resolution.
- [ ] Confirm workspace creation/rename/select/close behavior and whether it is sufficient to represent Picode tabs.
- [ ] Confirm split direction, layout metadata, and whether TUIOS can expose enough geometry to preserve grid-aware target selection.
- [ ] Confirm `capture-pane` source/style/line behavior.
- [ ] Confirm launch, interrupt, foreground-process inspection, and readiness wait behavior.
- [ ] Confirm close/exit event names and payload fields; test reconnect and `after_seq`/`boot_id` replay.
- [ ] Confirm Pi integration installation and whether Picode's own lifecycle state reports conflict with or complement TUIOS agent state.
- [ ] Confirm TUIOS permissions/grants needed by coordinator-launched workers.
- [ ] Write down any upstream TUIOS gaps before coding around them.

**Gate:** Do not begin the adapter until every operation needed by `spawn_worker`, `picode_panes`, pane read, cleanup, tabs, lifecycle, and revive has either a verified TUIOS verb or an explicitly accepted fallback.

### Phase 1 — Introduce selection and the normalized contract

- [ ] Add runtime types and the resolver.
- [ ] Add `PICODE_RUNTIME=auto|herdr|tuios` documentation in code comments.
- [ ] Add `HerdrRuntime` around existing Herdr calls without changing behavior.
- [ ] Refactor `src/lifecycle.ts` to use the selected runtime for its coordinator guard, own-pane label, stale cleanup, listener, and sit-rep eligibility.
- [ ] Replace direct `trackPane`/Herdr listener imports with a generic runtime event handle.
- [ ] Keep Herdr-specific environment cleanup in tests and add TUIOS environment cleanup to the test harness.
- [ ] Add unit tests for runtime selection and Herdr parity.

**Gate:** All existing unit tests pass with `PICODE_RUNTIME=herdr` or the normal Herdr test stubs; no tool directly decides the runtime.

### Phase 2 — Implement the TUIOS transport and read path

- [ ] Implement a line-delimited JSON Unix-socket client with request IDs, response validation, timeouts, and structured error handling.
- [ ] Perform `hello`/`list-verbs` capability discovery once per runtime connection.
- [ ] Implement list/snapshot normalization for sessions, workspaces, windows, agent states, labels, cwd, process information, and available layout data.
- [ ] Enforce scope using resolved TUIOS session/workspace identity, not string-prefix checks.
- [ ] Map TUIOS states to Picode statuses and preserve the Picode heartbeat override for dead workers.
- [ ] Implement `picode_panes` through the normalized snapshot.
- [ ] Implement `picode_pane_read` through `capture-pane`, including source/style/line validation and an explicit fallback for unsupported sources.
- [ ] Add adapter tests with mocked JSON protocol responses for success, malformed responses, missing fields, out-of-scope IDs, daemon errors, and timeouts.

**Gate:** Read-only Picode tools work against a live disposable TUIOS session and Herdr regression tests remain green.

### Phase 3 — Implement worker creation, reuse, and cleanup

- [ ] Implement TUIOS window creation/splitting with a structured Pi launch command.
- [ ] Ensure `PICODE_RUNTIME=tuios` is inherited by workers, while TUIOS identity variables are supplied by TUIOS itself.
- [ ] Preserve role/picode labels and unique ID generation.
- [ ] Reimplement idle/done reuse and empty/dead-pane reclamation using normalized records.
- [ ] Preserve the no-coordinator-split rule.
- [ ] Decide how to handle missing geometry:
  - retain grid-aware selection if TUIOS exposes rectangles; otherwise
  - use a deterministic safe target and let TUIOS manage layout; do not claim `tab_full` without a verified capacity rule.
- [ ] Map `send-keys C-c`, command launch, and readiness waiting.
- [ ] Implement `cleanup_panes` with all existing safety rules: active/blocked protection, own-pane protection, protected user tabs, dry-run, targeted close, and force mode.
- [ ] Add unit coverage for normalized status/safety decisions and a live integration test for spawn/reuse/readiness/close.

**Gate:** A coordinator can spawn, inspect, reuse, and clean at least two TUIOS Pi workers without touching an unrelated workspace or user-owned workspace.

### Phase 4 — Tabs, lifecycle events, and revival

- [ ] Implement the verified TUIOS equivalent of `picode_tab_create` and return exact IDs in the existing result shape.
- [ ] Implement `picode_tab_close` with coordinator-tab, active-worker, force, and protected-tab checks.
- [ ] Implement a TUIOS event listener using `subscribe`.
- [ ] Filter events to the selected Picode scope and tracked worker windows.
- [ ] Handle startup grace, reconnect backoff, daemon restart, sequence gaps, and `boot_id` changes by resynchronizing current state before injecting notices.
- [ ] Preserve clean shutdown and test that no socket/timer keeps Node alive.
- [ ] Adapt `revive_closed_session` to reclaim/create a TUIOS window, resume the exact Pi session file, send the continuation through Picode's durable mailbox, and retain freshness warnings.
- [ ] Verify whether TUIOS's `resume-agent` can be used; prefer Picode's existing explicit Pi session command if it gives more predictable session selection.
- [ ] Add live tests for close/exit notification, listener reconnect, tab safety, and revive success/failure paths.

**Gate:** A stopped worker can be revived with the same saved Pi session, and worker death is observable without polling-only behavior.

### Phase 5 — Documentation and rollout

- [ ] Update `README.md` installation and runtime configuration sections.
- [ ] Replace Herdr-only public descriptions in the tool docs with runtime-neutral language; retain backend-specific troubleshooting where useful.
- [ ] Update `src/prompts/coordinator.md` so agents use Picode tools and exact IDs without assuming Herdr topology.
- [ ] Document TUIOS setup, Pi integration, required grants, and `PICODE_RUNTIME` examples.
- [ ] Document that TUIOS's own Inbox/mail is not Picode's durable mailbox.
- [ ] Update `AGENTS.md` architecture/key-file notes and test hermeticity guidance.
- [ ] Add a changelog entry and migration/rollback instructions.
- [ ] Keep Herdr as the default fallback until TUIOS passes the live acceptance suite; only then consider changing the default from environment-driven `auto` behavior.

## Test plan

### Unit tests

- Runtime resolver: explicit values, auto detection, no runtime, both runtimes, incomplete variables, invalid values.
- JSON socket client: request correlation, line framing, malformed JSON, protocol errors, timeout, disconnect, and capability checks.
- Normalization: IDs, scope, statuses, labels, cwd, layout, protected workspaces/tabs.
- Tool safety: own pane, active/blocked workers, out-of-scope IDs, dry-run/force behavior, protected user-owned areas.
- Event listener: tracked-window filtering, startup grace, reconnect, sequence replay, daemon restart, clean stop.
- Launch command: model/theme/thinking/session/revive arguments and safe argument boundaries.

Follow `TESTING.md`: use the cheapest layer, assert structured behavior, add negative paths, isolate environment variables, and never let a unit test connect to the developer's real daemon.

### Live TUIOS integration tests

Gate these behind an explicit environment variable such as `PICODE_TUIOS_INTEGRATION=1`; do not require TUIOS or an API cost for normal unit tests.

1. Start an isolated disposable TUIOS daemon/session.
2. Launch coordinator and workers with real Pi-compatible commands.
3. Verify list/status/label/scope behavior.
4. Spawn a worker, capture output, interrupt it, and observe readiness/exit.
5. Reuse an idle worker and reclaim an empty/dead window.
6. Create/close a worker workspace/tab equivalent safely.
7. Restart or disconnect the daemon and verify listener resynchronization.
8. Stop and revive a worker using its saved Pi session.
9. Tear down the daemon and assert no process/socket/timer leak.

### Quality gates

```bash
npx tsc --noEmit
npm run test:unit
npm run lint
npm run format:check
```

Run the TUIOS integration suite separately after the local daemon contract is stable.

## Acceptance criteria

- `PICODE_RUNTIME=herdr` preserves current behavior and all existing tests.
- `PICODE_RUNTIME=tuios` starts a coordinator, identifies its own scope, and launches workers in that same TUIOS scope.
- `PICODE_RUNTIME=auto` selects the correct runtime from a clean Herdr or TUIOS environment and refuses ambiguous environments.
- Public Picode tool names and result contracts remain stable.
- Picode mailbox/state/journal behavior is unchanged.
- Pane listing, output inspection, cleanup, worker reuse, tabs/workspace equivalents, lifecycle notices, and revival all work under TUIOS.
- No tool can operate on another runtime's scope by guessing or string-constructing IDs.
- No listener or reconnect timer leaks after shutdown or tests.
- Documentation explains setup, selection, limitations, and rollback.

## Rollback strategy

Keep `HerdrRuntime` available and retain the runtime override. If a TUIOS operation is not safe or sufficiently equivalent, fail that operation with an actionable message rather than silently falling back to Herdr. Switching back is then immediate:

```bash
PICODE_RUNTIME=herdr pi ...
```

Do not migrate or rewrite existing Picode state files as part of the runtime change.

## Effort estimate

- Protocol verification and disposable live harness: **1–2 days**
- Runtime abstraction and Herdr refactor: **1–2 days**
- TUIOS transport/read path: **1–2 days**
- Spawn, reuse, cleanup, tabs, listener, and revive: **3–6 days**
- Tests, documentation, and hardening: **2–4 days**

Expected total for production-quality dual-backend support: **1–2 weeks**, assuming no required TUIOS upstream changes. Confidence in this estimate: **~75%** until Phase 0 resolves workspace/tab semantics, geometry, and revive behavior.
