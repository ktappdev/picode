# Prompt-cache diagnostics

Runbook for the intermittent "large cache miss" reports in Picode sessions — what
was observed, what the cause turned out to be, what the tracker records, how to read
it, and what is still unproven. Read this before changing anything in
`src/cache-diagnostics.ts` or `src/lifecycle.ts`'s `before_agent_start` handler.

**Cause found.** Picode returned a forced `systemPrompt` from `before_agent_start`.
Pi's projection for a forced prompt discards every persisted system message and
rebuilds the leading prompt from freshly computed text — including a worker roster
digest that changes whenever a worker moves. Because the system prompt precedes the
conversation, a moving digest re-billed the **entire conversation** on every turn it
moved. Fixed in `a240998`; the mechanism is in
[Candidate A](#candidate-a--the-forced-whole-prompt-override-root-cause). Plain Pi
has no such moving prefix head, which is why the symptom appeared only with Picode.

What remains unproven is not the mechanism but the endorsement: no trace yet shows
a **roster change** under the fixed code. The one live sample had no workers, so it
is the case that was already healthy — see
[the honest ledger](#what-would-close-it).

## The symptom

A running Picode coordinator logged repeated provider cache-miss notices with
almost no idle time between them:

```
~79,000   ~80,000   ~81,000   ~83,000   tokens re-billed
```

Each number is the size of the _whole_ prompt, not a slice of it. A miss that
covers nearly every prompt token means the cacheable prefix diverged at or very
near its start — not that one block near the end changed. The working suspicion was
that something was interrupting or rebuilding the session between requests. It was:
Picode was rebuilding the leading prompt on every prompt-driven run, and the text it
rebuilt from changed with the worker roster.

## What was established in the repo

| Question                                             | Finding                                                                                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Does Picode clear a provider cache anywhere?         | No. Nothing in `src/` touches cache keys, TTLs, or retention.                                                                                   |
| Is the coordinator prompt identical across requests? | No. `before_agent_start` computes a fresh worker roster digest per prompt-driven run (`src/lifecycle.ts:813-816`, `src/core/worker-ledger.ts`). |
| Did that digest invalidate the whole prefix?         | **Yes, on the pre-2026-09-22 code** — see below. The earlier "only a suffix" answer was wrong and is what kept this bug alive.                  |
| What changes the _start_ of the prompt?              | Candidate A, now explained. Candidate B (cache key) remains open.                                                                               |

### Candidate A — the forced whole-prompt override (**root cause**)

The handler used to return `{ systemPrompt: base + "\n\n" + picode }`. Pi treats a
returned `systemPrompt` as a **forced prompt**, and the projection is more
destructive than "overrides the leading prompt" suggests:

```js
_installAgentForcedPromptProjection() {
    this.agent.transformContext = async (messages, signal) => {
        const forced = this._runSystemPromptOptions?.forceSystemPrompt;
        if (forced === undefined) return transformed;
        const current = getCurrentSystemMessage(transformed);
        const head = { role: "system", content: forced, ... };
        return [head, ...transformed.filter((message) => message.role !== "system")];
    };
}
```

`dist/core/agent-session.js:1044-1058`

Two consequences, and the second is the one that cost money:

1. **Every persisted system message is discarded** from the body — including the
   transcript's own `sections` patches. Turns that took this path and turns that
   did not therefore carried structurally different bodies.
2. **The head is rebuilt from freshly computed text on every run.** `picode`
   contains the worker roster digest, which changes whenever a worker spawns,
   finishes, dies, or changes status. The system prompt is the _first_ thing in
   the request, so changing its tail does not invalidate a suffix — it
   invalidates **everything after it, which is the entire conversation**.

That is the shape of the original symptom: the re-bill equals the whole prompt
(~79k, then ~80k, ~81k, ~83k as the conversation grew), because the provider
matched no prefix at all. Picode's earlier analysis reasoned "the digest is
appended at the end of the system prompt, so on its own it can only invalidate a
suffix" — true of the system prompt's own length, false of the request, because
the system prompt precedes every message.

This also explains why the symptom appears **with Picode and not with plain Pi**.
No built-in Pi path varies the system prompt mid-session, so plain Pi never has a
moving prefix head. Picode's roster digest is exactly that, and it moves precisely
when workers are churning — the busiest, most expensive sessions.

**Fixed in `a240998`.** The rules now travel as a structured section
(`src/lifecycle.ts:831-840`). Pi diffs sections against the transcript and
persists only a patch (`dist/core/system-prompt.js:135-146`,
`dist/core/agent-session.js:1031`), which `convertResponsesMessages` appends at
its transcript position — the **end** of `input` — leaving the leading
`instructions` and every earlier message byte-identical
(`pi-ai/dist/api/openai-responses-shared.js:126-137`). A roster change now costs
one small appended system delta instead of the conversation.

Older Pi versions without `systemPromptOptions.sections` keep the legacy override
(`src/lifecycle.ts:844-856`). That branch is the only remaining path where Picode
rewrites the leading prompt, and it is pinned by a test
(`test/unit.test.ts`, "keeps the forced-prompt fallback only for Pi without
structured sections").

### Candidate B — the provider cache key (revive does **not** change it)

For the Codex Responses adapter the cache key is derived from the Pi session ID:

```js
const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
// ...
prompt_cache_key: cacheSessionId,
```

(`@earendil-works/pi-ai/dist/api/openai-codex-responses.js:171`, `:397`)

Paths in this file are relative to the Picode repo unless they start with `dist/`,
which is the installed `pi` package root.

The open question was whether `revive_closed_session` moves that key. **It does
not.** Revive launches `pi --session <state.sessionFile>` (`src/tools/spawn.ts:137`),
and Pi's `SessionManager._loadEntries` restores the identity from the file itself:

```js
const header = entries.find((e) => e.type === "session");
if (header) {
    this.fileEntries = entries;
    this.sessionId = header.id;
```

`dist/core/session-manager.js:718-722`

The session id changes only when Pi mints a new session: a fresh session, or a
fork/branch that writes a new header (`:1273`, `:1307`). Resume is not that path.
So a revived worker keeps its `prompt_cache_key`, and `revive_closed_session` —
whose commit message says "with its session intact" — means it literally.

Two consequences, in opposite directions:

- **A revived worker's first request is cold because of time, not identity.** If
  the cache entry expired or was evicted while the pane was stopped, the request
  re-reads everything under the _same_ key. That is a TTL story, and the fix is
  retention, not prompt hygiene. Budget for it: revive exists precisely for workers
  that have been stopped a while, which is exactly when the entry is gone.
- **The trace stays comparable across a revive.** `sessionHash` is continuous, so
  `payloadChanges` and `findPreviousPromptSnapshot` still match the pre-revive
  request. A revived worker's first response can be compared directly against what
  it sent before it stopped, which is not true of a genuinely new session.

What B still cannot explain: a genuinely cold session has no previous request in
its branch, so it is assessed `no-baseline` and Pi raises **no miss notice** at all.
Cold starts are invisible to the notice channel. Every notice the operator sees is
a _within-session_ re-bill — Candidate A's territory, not B's.

**Candidate A is fixed. Candidate B is a TTL cost, inherent, and still unmeasured.**

## What the tracker records

Enabled automatically for every active Picode. One file per picode id, at:

```
<picode cwd>/.picode/cache-diagnostics/<sha256(picodeId)[0..16]>.jsonl
```

The id is hashed so a user-controlled id cannot become a path segment
(`src/core/cache-diagnostics.ts:262-264`). Files are written `0600`, capped at
1 MB, and rewritten to keep the newest half on overflow.

Three record kinds, one per line:

**`kind: "prompt"`** — written from `before_agent_start`, one per prompt-driven run.

| Field                               | Meaning                                                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionHash`                       | SHA-256 of the Pi session id. The raw session id is never stored.                                                                                                                                          |
| `role`                              | `coordinator`, `builder`, …                                                                                                                                                                                |
| `snapshot.fullPromptHash`           | Base prompt + Picode's rendered contribution, in Pi's render order. A synthetic reconstruction for change detection, **not** the literal request payload (extensions loaded after Picode may append more). |
| `snapshot.basePromptHash`           | Everything Pi rendered before Picode's contribution — file context, skills, cwd, every preceding extension.                                                                                                |
| `snapshot.picodePromptHash`         | Picode's own rules, including the worker digest.                                                                                                                                                           |
| `snapshot.picodeWithoutWorkersHash` | Same, with the roster digest suffix stripped.                                                                                                                                                              |
| `snapshot.workerDigestHash`         | The roster digest alone.                                                                                                                                                                                   |
| `snapshot.fullPromptChars`          | Length of the reconstructed full prompt, a proxy for cacheable prefix size.                                                                                                                                |
| `snapshot.workerCount`              | Rows in the roster digest.                                                                                                                                                                                 |

**`kind: "payload"`** — written from `before_provider_request`, one per real provider
request. Pi's cache warmer calls the model runtime directly and is not observed
here (`core/sdk.js:210`), so payloads stay paired 1:1 with the responses below.

| Field                                             | Meaning                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `snapshot.payloadHash`                            | Instructions + tools + input messages, as one hash.                                                                        |
| `snapshot.instructionsHash` / `instructionsChars` | The leading system field. `null` when the adapter omitted it.                                                              |
| `snapshot.toolsHash` / `toolsCount`               | The tool definitions, in send order.                                                                                       |
| `snapshot.cacheKeyHash`                           | The provider cache key. `null` means no cache key was sent, i.e. caching was off.                                          |
| `snapshot.segmentCount`                           | Total input/messages entries.                                                                                              |
| `snapshot.segments`                               | First 8 entries only (`PAYLOAD_SEGMENTS_KEPT`): `index`, `role`, `type`, `hash`, `chars`. The prefix break is at the head. |

**`kind: "response"`** — written from `message_end` for each assistant message.

| Field                                                 | Meaning                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input` / `cacheRead` / `cacheWrite` / `promptTokens` | Provider-reported counters for that request.                                                                                                                                                                              |
| `cost`                                                | That message's total reported cost.                                                                                                                                                                                       |
| `previousRequest`                                     | The request this one is compared against, or `null`. Carries `source` (`"assistant"` or `"cache_warm"`), `promptTokens`, `cacheRead`, `modelKey`, `timestamp`, `reportedCache`, and the warm request's `cost` when known. |
| `assessment`                                          | Verdict — see the table below.                                                                                                                                                                                            |
| `promptChanges`                                       | Picode-visible components that differ from the previous snapshot, or `null` when no comparison was possible.                                                                                                              |
| `payloadChanges`                                      | Parts of the real request body that differ from the previous one, or `null` when no comparison was possible.                                                                                                              |
| `snapshot`                                            | The snapshot current at that request, or `null`.                                                                                                                                                                          |

No prompt text, message text, tool description, or worker note is ever written.
Fingerprints only.

### The two ways a cache read can look wrong

`assessment` reports three numbers, and only the first is waste:

| Field               | Meaning                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `reBilledTokens`    | Tokens the provider had already seen that were charged at full price this time. **This is the waste.**                |
| `newTokens`         | Tokens beyond the largest prompt the provider has seen. Legitimately new content; always full price.                  |
| `missedTokens`      | Pi's own figure (`min(previous, current) - cacheRead`). Kept for parity with Pi's notice; it conflates the two above. |
| `cacheReadAdvanced` | Whether this request read more of the prefix than the last one did.                                                   |

`cacheReadAdvanced: false` with `payloadChanges: []` is the signature of a cache
whose prefix is **frozen**: nothing in the request changed, yet the read did not
grow. `cacheReadAdvanced: true` with a small `reBilledTokens` is the opposite —
the prefix is being re-anchored as the conversation grows, which is normal.

`missedTokens` alone cannot tell these apart, and gets worse as a session grows:
while the prefix is frozen it degenerates to `previousPrompt − cacheRead`, so the
notice climbs even though the real waste is the same handful of tokens each turn.

## Reading the trace

List which picodes have traces, then dump the last responses of each:

```bash
node --input-type=module -e '
import { readdirSync, readFileSync } from "node:fs";
const dir = ".picode/cache-diagnostics";
for (const name of readdirSync(dir).sort()) {
  const rows = readFileSync(`${dir}/${name}`, "utf8").split("\n").filter(Boolean)
    .map(line => JSON.parse(line)).filter(r => r.kind === "response");
  console.log(`\n== ${name} — ${rows.length} response(s)`);
  for (const r of rows.slice(-12)) {
    const a = r.assessment;
    const re = a.reBilledTokens ?? a.missedTokens ?? "-";
    const split = `re=${re} new=${a.newTokens ?? "-"} adv=${a.cacheReadAdvanced ?? "-"}`;
    console.log([
      new Date(r.messageTimestamp).toISOString().slice(11, 19),
      r.role,
      `${r.provider}/${r.model}`,
      `in=${r.input}`,
      `read=${r.cacheRead}`,
      `write=${r.cacheWrite}`,
      a.status === "miss" ? `MISS ${split} idle=${Math.round(a.idleMs / 1000)}s` : `${a.status} ${split}`,
      `prev=${r.previousRequest ? `${r.previousRequest.source}@${r.previousRequest.promptTokens}` : "none"}`,
      `chg=${(r.promptChanges ?? []).join("|") || "none"}`,
      `body=${(r.payloadChanges ?? []).join("|") || "none"}`,
    ].join("  "));
  }
}
'
```

To find a specific picode's file by id:

```bash
printf 'coordinator' | shasum -a 256 | cut -c1-16
```

To see the full record for one miss, including hashes and the previous request:

```bash
rg '"status":"miss"' .picode/cache-diagnostics/*.jsonl | tail -n 1
```

To see what the request body actually looked like around a break, pair each
response with the payload that preceded it:

```bash
node --input-type=module -e '
import { readdirSync, readFileSync } from "node:fs";
const dir = ".picode/cache-diagnostics";
for (const name of readdirSync(dir).sort()) {
  for (const line of readFileSync(`${dir}/${name}`, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.kind !== "payload") continue;
    const s = r.snapshot;
    console.log([
      new Date(r.timestamp).toISOString().slice(11, 19), r.role,
      `seg=${s.segmentCount}`, `tools=${s.toolsCount}`,
      `key=${s.cacheKeyHash ? s.cacheKeyHash.slice(0, 8) : "none"}`,
      `payload=${s.payloadHash.slice(0, 8)}`, `instr=${s.instructionsChars}`,
    ].join("  "));
  }
}
'
```

## Interpreting a reading

`assessment.status` is one of:

| Status               | Meaning                                                                                                   | Action                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `no-prompt`          | The request reported zero prompt tokens.                                                                  | Nothing to compare.                                |
| `no-baseline`        | First request, after compaction, or after a branch summary — Pi resets its baseline at those boundaries.  | Expected. Not a miss.                              |
| `cache-unreported`   | No cache activity has ever been reported for this session — the provider may simply not cache this model. | Check the model, not Picode.                       |
| `within-noise-floor` | Missed tokens ≤ 1,024, Pi's own granularity floor (`dist/core/cache-stats.js:7`).                         | Expected. Not a miss.                              |
| `miss`               | More than 1,024 _previously-sent_ tokens were re-billed.                                                  | Read `reBilledTokens` against `cacheReadAdvanced`. |

For a `miss`, the useful question is not "how big" but "which of the two
evils":

| `reBilledTokens` | `cacheReadAdvanced`                     | Reading                                                                                                                                                                                       |
| ---------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| large            | `false`                                 | The prefix is frozen. Nothing new is being cached and the same tokens are charged every turn. This is the expensive case.                                                                     |
| small            | `true`                                  | The prefix re-anchored and one block was charged twice. Normal block granularity — the same shape recurs every turn, so the size of the number is a function of prompt length, not of damage. |
| any              | `false`, `idleMs` past the model's tier | TTL expiry — the prefix was evicted while idle, then had to be re-sent. Normal, and unavoidable without raising retention.                                                                    |

Then combine with `promptChanges` and `payloadChanges`:

| `promptChanges`                                 | `payloadChanges` | `previousRequest`                            | Reading                                                                                                                                                                                                                            |
| ----------------------------------------------- | ---------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `["Pi or preceding-extension system prompt"]`   | any              | any                                          | Something _before_ Picode's block changed the leading prompt. Picode's rules are not the cause — check project context files, skills, `AGENTS.md`, or another extension.                                                           |
| `["Picode worker digest"]`                      | any              | any                                          | Only the trailing roster digest moved. A miss this large cannot be caused by that alone; look for a prefix-level cause repeating at the same time.                                                                                 |
| `["Picode rules, override, or revival notice"]` | any              | any                                          | Picode's own rules text changed — a `mode: replace` override taking effect, or a revival notice appearing.                                                                                                                         |
| `[]` (empty)                                    | `[]` (empty)     | `source: "assistant"`, `modelChanged: false` | The request body was byte-identical where this trace can see it. Nothing Picode did. Check retention tier, session identity, and provider-side granularity.                                                                        |
| `[]` (empty)                                    | names a part     | any                                          | The break is in the real payload. `request message N` is where the cached prefix ends — usually the appending of the newest turn, which is expected; `provider instructions`, `tool definitions`, or `provider cache key` are not. |
| `[]` (empty)                                    | `null`           | any                                          | No earlier payload was compared — the first request after a resume or restart. Compare against the trace's own previous `kind: "payload"` line by hand.                                                                            |
| `[]` (empty)                                    | any              | `source: "cache_warm"`                       | Pi warmed the cache and the next real request still missed. Points at TTL expiry or a cache-key change, not prompt content.                                                                                                        |
| `null`                                          | any              | any                                          | No earlier fingerprint was available — first miss of a session, or the trace was trimmed.                                                                                                                                          |
| any                                             | any              | `modelChanged: true`                         | The provider or model changed. A full re-bill is expected; `cost` is real.                                                                                                                                                         |

`idleMs` is the gap since the previous request. A miss after an idle gap longer
than the model's `promptCache` tier (see [docs/models.md](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/models.md#prompt-cache-lifetimes))
is TTL expiry, which is normal and expected.

## Known limits — what this trace cannot prove

- **It sees only what Picode renders.** Extensions loaded after Picode can still
  change the final request. An unchanged `basePromptHash` does not prove the
  payload was byte-identical.
- **Hashes are not the payload.** `fullPromptHash` is a reconstruction of
  base + Picode's contribution. `payloadHash` is the real body, but reduced to
  hashes and lengths. Pair `payloadChanges: []` with the matching
  `kind: "payload"` lines before concluding two requests were identical.
- **`payloadChanges` is in-memory only.** On the first miss after a Pi resume or
  restart the process has no earlier payload, so the field is `null` even though
  a payload line for it exists on disk.
- **Only the first 8 request entries are fingerprinted** (`PAYLOAD_SEGMENTS_KEPT`),
  and only as hashes. A break past entry 8 reads as `payloadChanges: []`.
  Deliberate: the prefix break this runbook chases is at the head.
- **`cache_warm` entries have neither a snapshot nor a payload.** Pi's warmer
  makes its own request without firing `before_provider_request`
  (`dist/core/cache-warmer.js`, `core/sdk.js:210`), so a miss can be attributed
  to a warm request without knowing what that request contained.
- **`sendMessage`-triggered turns do not write a prompt record.** They reuse the
  last snapshot, which is correct only because the rules now live in the
  transcript as a section. Do not "fix" this by re-adding a per-run override.
- **A changed fingerprint is correlation, not causation.** Provider caching is
  prefix-exact and depends on request parameters this trace does not see.
- **Block granularity is invisible here.** The provider reports how much it read,
  not why. A read that stops short of the previous prompt looks the same whether
  the prefix broke or the provider simply rounds to a granule; the difference is
  that a granule-rounded read advances next turn and a broken one does not.

## Observed 2026-09-23 — workerless coordinator, first live trace

From a real session, recorded before the payload and waste-split fields existed,
so these numbers come from `input` / `cacheRead` / `previousRequest` alone.

| Fact                                       | Value                                          |
| ------------------------------------------ | ---------------------------------------------- |
| Role                                       | `coordinator`, `workerCount: 0` throughout     |
| Provider/model                             | `openai-codex` / `gpt-5.6-luna`                |
| `fullPromptHash`                           | Identical (`e03b35c2`) on all 7 prompt records |
| `promptChanges`                            | `[]` on every comparable response              |
| Pi version, retention tier, `cacheWarming` | Not captured then — see "What to re-record"    |

Seven requests, one session, ~7 minutes:

```
cacheRead      0  24064  24064  25088  25088  25088  25088
prompt     24777  25166  25222  25880  26068  26117  26144
missed         -    713   1102    134    792    980   1029
prev@read      -  24777@0  25166@24064  25222@24064  25880@25088  26068@25088  26117@25088
```

Reading it:

- **`cacheRead` is healthy here, but this sample does not validate the fix.** With
  `workerCount: 0` the roster digest is empty and constant, so the leading prompt
  was stable under _both_ the old and the new code. The sample is the one shape
  where the bug could not appear. See the note below.
- **Reading A was right, B was not.** `cacheRead` is not frozen. It advanced by
  exactly 1,024 tokens (one granule) once the conversation outgrew the old anchor:
  24,064 → 25,088. The 1,102-token miss on turn 3 was the anchor lagging the
  transcript, not a broken prefix.
- **`missedTokens` is the wrong number to watch.** Re-derived with the split,
  turn 3 is 1,102 re-billed + 56 new, and turn 7 is 1,029 re-billed + 27 new. The
  re-bill is about one granule of the prompt's tail. It recurs while the prompt
  keeps growing and scales with prompt length, not with damage.
- **Not TTL.** The last miss came after 100 s idle, and `cacheRead` was 25,088 on
  both sides of it, so the prefix survived the gap. Only an `idleMs` past the
  configured tier should be read as eviction.
- **No payload evidence.** This trace predates the payload records, so it cannot
  say whether the request body was byte-identical. The next one can.

What the sample does establish is the **contrast**. These misses are one granule
of tails on a stable prompt, 95–97% read from cache. The incident re-billed the
whole prompt, 79k–83k, with almost nothing shared. Those are not the same disease,
and the difference lines up with the one variable this run held constant: a
workerless roster.

So the honest ledger is:

| Claim                                                     | Status                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| The forced-prompt path invalidates the whole prefix       | **Read from the code** (`_installAgentForcedPromptProjection`) |
| The roster digest is what moved inside that forced prompt | **Read from the code** (`sections.picode` carries the digest)  |
| That is why the incident re-billed the whole prompt       | **Inferred from the symptom shape, not traced**                |
| The section path preserves the prefix under roster churn  | **Inferred from Pi's diff + append path, not measured**        |
| Revive preserves the provider cache key                   | **Read from the code** (`--session` restores the header id)    |
| The 2026-09-23 sample proves the fix works                | **No — it cannot, `workerCount: 0`**                           |

A session that never spawned a worker before this fix would also have shown
`fullPromptHash` identical across turns, because an empty digest does not move.
That is the gap: the evidence for the fix is mechanistic, and the one live sample
is the case that was already healthy.

### What would close it

One coordinator run **with workers**, under an unchanged prompt, read for
`reBilledTokens` against `payloadChanges`. Specifically: spawn a worker, watch the
roster digest change, and check whether the next response re-bills the
conversation (`payloadChanges` naming `request message 0`, i.e. the head moved) or
only a small appended delta (`payloadChanges` naming the digest's own message).
That is the measurement nobody has taken yet.

## The decisive experiment

Run this when you have a spare session and want to settle A vs B.

1. **Ignore cache warming on OpenAI models — it is inert.** It only runs when the
   model declares a `promptCache` lifetime, and no `openai`/`openai-codex`/
   `azure-openai` model in the catalog declares one (`docs/models.md:99`).
   `getPromptCacheTtlMs` returns `undefined` and the warmer stops with "cache
   lifetime unavailable" before scheduling anything
   (`dist/core/cache-warmer.js:128-132`). On `gpt-5.6-luna` the setting has no
   effect in either direction, so there is nothing to remove for the test — and
   nothing to gain by setting it to `"off"`. It matters only if you move to an
   Anthropic model, where the default `"streaming"` is the right choice and a
   coordinator's per-worker warmers are the thing to watch, not the mode.

   ```json
   { "showCacheMissNotices": true }
   ```

   Keep `PI_CACHE_RETENTION` at whatever you normally run, and note it — retention
   tier changes the control condition.

   Also worth knowing before blaming anything else: `pi-cache-optimizer` bails out
   of all prompt rewriting for the whole Responses family, by design
   (`index.ts:10840-10869`, `isToolOrderingEligibleModel`), so it is not a
   participant on `openai-codex` either.

2. **Control run.** One coordinator, one operator prompt, then a second operator
   prompt a few seconds later. No `spawn_worker`, no `revive_closed_session`, no
   `cleanup_panes`, no journal, no compaction, no model change. Then read the
   trace. Expect this to be clean — the 2026-09-23 sample already showed a stable
   workerless prompt reads ~96% from cache. The control is here to prove the
   instrument works, not to find the bug.

   - Misses with `promptChanges: ["Pi or preceding-extension system prompt"]` →
     something before Picode is unstable. Investigate that before anything else.
   - Misses with `promptChanges: []` → neither A nor B is prompt content. Check
     session identity and retention.
   - No misses → the prompt is stable in the quiet case. Proceed to the run that
     actually matters.

3. **Treatment run — the one that matters.** Same coordinator shape, but exercise
   the worker lifecycle: spawn a worker, let it finish, then revive and close it.
   Read both traces — the coordinator's and the worker's.

   The thing to watch is the response immediately after the roster digest changes,
   and the question is only this: **does `reBilledTokens` jump to the size of the
   conversation, or stay near the size of the digest delta?**

   - `reBilledTokens` ≈ the digest delta, `cacheReadAdvanced: true`, and
     `payloadChanges` naming the digest's own appended message → **the fix holds**.
     A moving roster now costs one small system delta. This is the measurement
     nobody has taken, and it is the whole reason this runbook exists.
   - `reBilledTokens` ≈ the whole conversation, with `payloadChanges` naming
     `request message 0` → **the fix does not hold.** The digest is still reaching
     the leading prompt. Re-read `src/lifecycle.ts:831-840` and Pi's
     `diffSystemPromptSections` before touching anything else.
   - Misses in the **revived worker's** trace, with `promptChanges: []` and the
     _same_ `sessionHash` on both sides of the revive → TTL. The key survived
     (`--session` restores the header id), the entry did not. Expected after a
     long stop, and not something Picode can fix.
   - Misses in the **revived worker's** trace where `sessionHash` itself changes →
     the revive did not restore the session file. That contradicts the code path
     (`src/tools/spawn.ts:137` → `dist/core/session-manager.js:718-722`); treat it
     as a bug in revive, not in caching.
   - Misses in the **coordinator's** trace with `promptChanges: []` and no session
     change → neither candidate explains them. Check retention tier, other
     extensions, and whether the misses track wall-clock time.

4. **Record the outcome in this file** under a dated heading, including the Pi
   version, model, retention tier, and the raw `assessment` lines for any miss.

When reporting a finding, include: Pi version, provider/model, `PI_CACHE_RETENTION`,
whether `cacheWarming` was on, the `assessment` object, `promptChanges`,
`payloadChanges`, `previousRequest.source`, and `idleMs`. Those facts are what make
a miss reproducible from this file alone.

When reporting a finding, include: Pi version, provider/model, `PI_CACHE_RETENTION`,
whether `cacheWarming` was on, the `assessment` object, `promptChanges`,
`payloadChanges`, `previousRequest.source`, and `idleMs`. Those facts are what make
a miss reproducible from this file alone.
