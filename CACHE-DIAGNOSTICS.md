# Prompt-cache diagnostics

Runbook for the intermittent "large cache miss" reports in Picode sessions — what
was observed, what the tracker records, how to read it, and what each reading
means. Read this before changing anything in `src/cache-diagnostics.ts` or
`src/lifecycle.ts`'s `before_agent_start` handler.

## The symptom

A running Picode coordinator logged repeated provider cache-miss notices with
almost no idle time between them:

```
~79,000   ~80,000   ~81,000   ~83,000   tokens re-billed
```

Each number is the size of the _whole_ prompt, not a slice of it. A miss that
covers nearly every prompt token means the cacheable prefix diverged at or very
near its start — not that one block near the end changed. The working suspicion
was that something was interrupting or rebuilding the session between requests.

## What was established in the repo

| Question                                             | Finding                                                                                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Does Picode clear a provider cache anywhere?         | No. Nothing in `src/` touches cache keys, TTLs, or retention.                                                                                   |
| Is the coordinator prompt identical across requests? | No. `before_agent_start` computes a fresh worker roster digest per prompt-driven run (`src/lifecycle.ts:813-816`, `src/core/worker-ledger.ts`). |
| Did that digest invalidate the whole prefix?         | No. The digest is appended at the _end_ of the system prompt, so on its own it can only invalidate a suffix.                                    |
| What changes the _start_ of the prompt?              | Two candidate mechanisms, both below. Neither is proven.                                                                                        |

### Candidate A — the forced whole-prompt override

Until this change, the handler returned `{ systemPrompt: base + "\n\n" + picode }`.
Pi treats a returned `systemPrompt` as a **forced prompt**: it is projected onto
the request as the leading system prompt and is _not_ persisted
(`dist/core/extensions/runner.js:1043`, `dist/core/agent-session.js:1048`). The
per-run options are discarded when the run settles
(`dist/core/agent-session.js:1100`).

That matters because `sendMessage(..., { triggerTurn: true })` never fires
`before_agent_start` at all — `sendCustomMessage` calls `_runAgentPrompt`
directly (`dist/core/agent-session.js:1481`). Every coordinator envelope
injection and sit-rep takes that path (`src/inbox.ts:145`, `src/lifecycle.ts:278`),
so those turns rebuilt the system prompt from the base options while
`prompt()`-driven turns used the forced text. Two interleaved prompt shapes for
one session is a plausible whole-prefix invalidator.

**Fixed here.** The rules now travel as a structured section
(`src/lifecycle.ts:831-840`), which Pi diffs and persists in the transcript
(`dist/core/agent-session.js:1025-1032`), so every turn shape sees the same
rules. Older Pi versions without `systemPromptOptions.sections` keep the legacy
override (`src/lifecycle.ts:844-856`).

### Candidate B — the provider cache key

For the Codex Responses adapter the cache key is derived from the Pi session ID:

```js
const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
// ...
prompt_cache_key: cacheSessionId,
```

(`@earendil-works/pi-ai/dist/api/openai-codex-responses.js:171`, `:397`)

Paths in this file are relative to the Picode repo unless they start with `dist/`,
which is the installed `pi` package root.

Any new session therefore starts with a cold cache regardless of prompt content:
resuming/reviving a worker, `/new`, a fork, or a restart. Commit `574bcd5`
(2026-09-16, "revive a stopped worker with its session intact") added
`revive_closed_session`, which deliberately starts a _new_ Pi session for a
stopped worker. If the misses cluster around worker lifecycle events, this is
the likelier explanation, and prompt fingerprints will look unchanged.

**Resolve which one by reading the trace, not by reasoning from the code.**

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

- **The fix held, on this sample.** `cacheRead` grew 0 → 24,064 → 25,088, so
  95–97% of every prompt was served from cache. The original incident re-billed
  ~79k–83k of a ~79k prompt, i.e. almost nothing was shared. These misses are two
  orders of magnitude smaller.
- **Reading A was right, B was not.** `cacheRead` is not frozen. It advanced by
  exactly 1,024 tokens (one granule) once the conversation outgrew the old anchor:
  24,064 → 25,088. The 1,102-token miss on turn 3 was the anchor lagging the
  transcript, not a broken prefix.
- **`missedTokens` is the wrong number to watch.** Re-derived with the split,
  turn 3 is 1,102 re-billed + 56 new, and turn 7 is 1,029 re-billed + 27 new. The
  re-bill is about one granule of the prompt's tail. It recurs while the prompt
  keeps growing and scales with prompt length, not with damage. The incident's
  ~79k was not this shape at all.
- **Not TTL.** The last miss came after 100 s idle, and `cacheRead` was 25,088 on
  both sides of it, so the prefix survived the gap. Only an `idleMs` past the
  configured tier should be read as eviction.
- **No payload evidence.** This trace predates the payload records, so it cannot
  say whether the request body was byte-identical. The next one can.

Two facts keep this from being closed. `workerCount: 0` means the roster was empty
for the whole run, so the sample never exercises the paths most likely to disturb
a prefix — spawn, revive, cleanup, or a non-empty digest. And the improvement is
confounded: the `a240998` prompt fix and the absence of workers both landed
between the incident and this sample. Re-record before attributing it to either.

## The decisive experiment

Run this when you have a spare session and want to settle A vs B.

1. **Remove the noise.** Cache warming makes its own provider requests and can
   itself trigger misses. Set it off for the test:

   ```json
   { "cacheWarming": "off", "showCacheMissNotices": true }
   ```

   `cacheWarming` is a global setting only. Keep `PI_CACHE_RETENTION` at whatever
   you normally run, and note it — retention tier changes the control condition.

2. **Control run.** One coordinator, one operator prompt, then a second operator
   prompt a few seconds later. No `spawn_worker`, no `revive_closed_session`, no
   `cleanup_panes`, no journal, no compaction, no model change. Then read the
   trace.

   - Misses with `promptChanges: ["Pi or preceding-extension system prompt"]` →
     Candidate A was not the whole story; something before Picode is unstable.
   - Misses with `promptChanges: []` → neither A nor B is prompt content. Check
     session identity and retention.
   - No misses → the prompt is stable in the quiet case. Proceed.

3. **Treatment run.** Same coordinator shape, but exercise the worker lifecycle:
   spawn a worker, let it finish, then revive and close it. Read both traces —
   the coordinator's and the worker's.

   - Misses in the **revived worker's** trace, with `promptChanges: []` and a new
     `sessionHash` in its `prompt` records → Candidate B. `revive_closed_session`
     starts a new Pi session, so the provider cache key changes and the first
     request is legitimately cold. Nothing about Picode's prompt is wrong; the
     cost is inherent to reviving.
   - Misses in the **coordinator's** trace with `promptChanges` naming a Picode
     component → the roster digest or revival notice is reaching the prefix.
     Investigate whether the section is being re-diffed in a way that replaces
     rather than appends.
   - Misses in the **coordinator's** trace with `promptChanges: []` and no
     session change → neither candidate explains them. Check retention tier,
     other extensions, and whether the misses track wall-clock time.

4. **Record the outcome in this file** under a dated heading, including the Pi
   version, model, retention tier, and the raw `assessment` lines for any miss.

When reporting a finding, include: Pi version, provider/model, `PI_CACHE_RETENTION`,
whether `cacheWarming` was on, the `assessment` object, `promptChanges`,
`payloadChanges`, `previousRequest.source`, and `idleMs`. Those facts are what make
a miss reproducible from this file alone.
