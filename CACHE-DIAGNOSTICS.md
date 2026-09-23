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

Two record kinds per line:

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

**`kind: "response"`** — written from `message_end` for each assistant message.

| Field                                                 | Meaning                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `input` / `cacheRead` / `cacheWrite` / `promptTokens` | Provider-reported counters for that request.                                                                                                                                                                 |
| `cost`                                                | That message's total reported cost.                                                                                                                                                                          |
| `previousRequest`                                     | The request this one is compared against, or `null`. Carries `source` (`"assistant"` or `"cache_warm"`), `promptTokens`, `modelKey`, `timestamp`, `reportedCache`, and the warm request's `cost` when known. |
| `assessment`                                          | Verdict — see the table below.                                                                                                                                                                               |
| `promptChanges`                                       | Picode-visible components that differ from the previous snapshot, or `null` when no comparison was possible.                                                                                                 |
| `snapshot`                                            | The snapshot current at that request, or `null`.                                                                                                                                                             |

No prompt text, message text, or worker note is ever written. Fingerprints only.

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
    console.log([
      new Date(r.messageTimestamp).toISOString().slice(11, 19),
      r.role,
      `${r.provider}/${r.model}`,
      `in=${r.input}`,
      `read=${r.cacheRead}`,
      `write=${r.cacheWrite}`,
      a.status === "miss" ? `MISS=${a.missedTokens} idle=${Math.round(a.idleMs / 1000)}s` : a.status,
      `prev=${r.previousRequest ? `${r.previousRequest.source}@${r.previousRequest.promptTokens}` : "none"}`,
      `changed=${(r.promptChanges ?? []).join("|") || "none"}`,
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

## Interpreting a reading

`assessment.status` is one of:

| Status               | Meaning                                                                                                   | Action                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `no-prompt`          | The request reported zero prompt tokens.                                                                  | Nothing to compare.                                  |
| `no-baseline`        | First request, after compaction, or after a branch summary — Pi resets its baseline at those boundaries.  | Expected. Not a miss.                                |
| `cache-unreported`   | No cache activity has ever been reported for this session — the provider may simply not cache this model. | Check the model, not Picode.                         |
| `within-noise-floor` | Missed tokens ≤ 1,024, Pi's own granularity floor (`dist/core/cache-stats.js:7`).                         | Expected. Not a miss.                                |
| `miss`               | More than 1,024 prior prompt tokens were re-billed.                                                       | Read `promptChanges` and `previousRequest` together. |

For a `miss`, combine the two fields:

| `promptChanges`                                 | `previousRequest`                            | Reading                                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `["Pi or preceding-extension system prompt"]`   | any                                          | Something _before_ Picode's block changed the leading prompt. Picode's rules are not the cause — check project context files, skills, `AGENTS.md`, or another extension. |
| `["Picode worker digest"]`                      | any                                          | Only the trailing roster digest moved. A miss this large cannot be caused by that alone; look for a prefix-level cause repeating at the same time.                       |
| `["Picode rules, override, or revival notice"]` | any                                          | Picode's own rules text changed — a `mode: replace` override taking effect, or a revival notice appearing.                                                               |
| `[]` (empty)                                    | `source: "cache_warm"`                       | Pi warmed the cache and the next real request still missed. Points at TTL expiry or a cache-key change, not prompt content.                                              |
| `[]` (empty)                                    | `source: "assistant"`, `modelChanged: false` | Nothing Picode can see changed. Check retention tier, session identity, and other extensions.                                                                            |
| `null`                                          | any                                          | No earlier fingerprint was available — first miss of a session, or the trace was trimmed.                                                                                |
| any                                             | `modelChanged: true`                         | The provider or model changed. A full re-bill is expected; `cost` is real.                                                                                               |

`idleMs` is the gap since the previous request. A miss after an idle gap longer
than the model's `promptCache` tier (see [docs/models.md](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/models.md#prompt-cache-lifetimes))
is TTL expiry, which is normal and expected.

## Known limits — what this trace cannot prove

- **It sees only what Picode renders.** Extensions loaded after Picode can still
  change the final request. An unchanged `basePromptHash` does not prove the
  payload was byte-identical.
- **Hashes are not the payload.** `fullPromptHash` is a reconstruction of
  base + Picode's contribution; two requests with equal hashes can still differ
  elsewhere.
- **`cache_warm` entries have no prompt snapshot.** Pi's warmer makes its own
  request (`dist/core/cache-warmer.js`), so a miss can be attributed to a warm
  request without knowing what that request contained.
- **`sendMessage`-triggered turns do not write a prompt record.** They reuse the
  last snapshot, which is correct only because the rules now live in the
  transcript as a section. Do not "fix" this by re-adding a per-run override.
- **A changed fingerprint is correlation, not causation.** Provider caching is
  prefix-exact and depends on request parameters this trace does not see.

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
the `assessment` object, `promptChanges`, `previousRequest.source`, and `idleMs`.
Those five facts are what makes a miss reproducible from this file alone.
