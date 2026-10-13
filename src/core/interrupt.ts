/** Preempt gate behind `urgency: "interrupt"` (PROTOCOL-FORMALISM.md §6).
 *
 *  Pi's steering queue delivers a message only after the current assistant
 *  turn has finished executing **every** tool call the model emitted for it,
 *  and the extension API has no lever that cancels one tool call. So a plain
 *  `high` steer is bounded by the longest tool call in the batch — a worker
 *  four minutes into a build does not read the correction until the build
 *  returns.
 *
 *  The one lever that is both immediate and safe is the `tool_call` hook: a
 *  handler that returns `{ block: true }` stops a tool call *before* it runs.
 *  An interrupt therefore arms this gate for the rest of the receiver's
 *  current batch. Every tool call the model already emitted but has not yet
 *  started is refused with a reason naming the interrupt, so the batch ends
 *  early; pi then pulls the steering message that rode with the interrupt into
 *  context before the next model request. The receiver reads the new direction
 *  without having executed the rest of the old plan.
 *
 *  What this deliberately does NOT do is call `ctx.abort()`.
 *  `docs/how-pi-works.md` ("Agent loop") states the contract: *"Aborting stops
 *  the current run and returns queued messages to the editor."* In an
 *  autonomous worker pane nobody presses Enter, so aborting strands whatever
 *  picode traffic was queued in an input box, and it can leave a half-written
 *  edit behind. Preemption trades exactly one thing for that safety: a tool
 *  call that is already executing still finishes.
 *
 *  Module-level state, like the quiet-TUI flag in `core/quiet-tui.ts` — one
 *  picode per process. `lifecycle.ts` owns the `tool_call` hook that reads it
 *  and disarms it at `turn_start` (the boundary at which the steering message
 *  is consumed, and which always precedes any tool call of a new turn). */

/** Backstop for a gate that was armed but never reached a `turn_start`.
 *
 *  `turn_start` is the real disarm — it covers every normal path, including a
 *  run that ends right after the arm (`agent_end` is followed by a fresh run's
 *  `turn_start`). This TTL only bounds the abnormal case where a tool call is
 *  prepared outside any run (for example a command handler's `ctx.executeTool`),
 *  so a stale gate can never refuse work minutes later. */
export const INTERRUPT_PREEMPT_TTL_MS = 5 * 60_000;

/** Why a refused tool call is refused. The receiver reads this as the tool
 *  result, so it must say what happened in the model's own terms. */
export const INTERRUPT_BLOCK_REASON =
  "picode interrupt — a direction change arrived during your current task. " +
  "This tool call was cancelled and not run so you can read it before continuing.";

let armedAt = 0;

/** Arm the gate for a receiver that is mid-run. Called only after the
 *  interrupt's steer message has actually been handed to pi, so an armed gate
 *  always has a message behind it waiting at the next turn boundary. */
export function armInterruptPreempt(now: number = Date.now()): void {
  armedAt = now;
}

/** Disarm. Called at every `turn_start`: that is the boundary where the
 *  steering message has been pulled into context, and tool calls after it
 *  belong to a response the model has not yet produced. */
export function clearInterruptPreempt(): void {
  armedAt = 0;
}

/** Whether the gate is armed and still inside its backstop window. Expiry
 *  disarms as a side effect — there is no timer to leak. */
export function isInterruptPreemptArmed(now: number = Date.now()): boolean {
  if (armedAt === 0) return false;
  if (now - armedAt > INTERRUPT_PREEMPT_TTL_MS) {
    armedAt = 0;
    return false;
  }
  return true;
}

/** The `tool_call` handler's return value: refuse the call while the gate is
 *  armed, otherwise `undefined` (pi treats undefined as "run it").
 *
 *  Intentionally not `terminate: true`. That field makes pi skip its automatic
 *  follow-up after the batch, but it only exists from pi 1.2.0 and this
 *  package type-checks against its declared devDependency — and it is only an
 *  optimization anyway: the steering message is consumed at the next turn
 *  boundary either way. */
export function interruptPreemptBlockResult(
  now: number = Date.now(),
): { block: true; reason: string } | undefined {
  if (!isInterruptPreemptArmed(now)) return undefined;
  return { block: true, reason: INTERRUPT_BLOCK_REASON };
}
