import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { PicodeStore } from "./core/types";

/** Everything journal: the fork prompt, entry parsing, duplicate detection,
 *  and the cadence policy deciding which moments deserve a forked entry. */

const JOURNAL_PROMPT = `You are this picode's journal keeper. Based on the conversation above, write a brief status update in exactly this format:

Working on: <the main task in one line>
Done: <what was completed this turn>
Doing: <what is in progress or will continue>
Next: <planned next step>
Blockers: <blockers or "none">

No preamble. No extra text. Just the five lines.`;

const COMPACTION_PROMPT = `You are summarizing old journal entries from a long-running picode. Produce a compact block (5-10 lines max) preserving: key tasks completed, key decisions made, current state at the time, ongoing obligations. Drop: routine tool turns, restated waits, anything that doesn't carry news. Format: a single paragraph OR short bulleted list. No headers. No preamble. Just the summary text.

Entries to summarize:
---
ENTRIES_HERE
---`;

/** Minimum spacing between per-turn journal forks. Structural changes (new
 *  obligation, lock, barrier — the things teammates key off) still journal
 *  immediately; this only rate-limits the "another tool turn on the same
 *  task" entries that used to land once per turn, ~17 near-duplicates per
 *  work session. */
export const JOURNAL_MIN_INTERVAL_MS = 120_000;

/** When journal entries exceed this, summarize the oldest (count - keepRecent)
 *  into a single block. Cooldown: 24h between compactions, enforced by the
 *  most-recent COMPACTION marker in the file. */
export const JOURNAL_COMPACT_THRESHOLD = 500;
export const JOURNAL_COMPACT_KEEP_RECENT = 100;
export const JOURNAL_COMPACT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Detect a compaction marker: `<!-- COMPACTION <ts> -->`. Used to enforce
 *  the 24h cooldown without extra state. */
export function isCompactionEntry(entry: string): boolean {
  return /^<!--\s*COMPACTION\s/.test(entry.trimStart());
}

/** Entries are separated by their `<!-- timestamp -->` headers. */
export function splitJournalEntries(content: string): string[] {
  return content.split(/\n(?=<!--)/).filter(Boolean);
}

/** "Working on"/"Done" carry the actual news; "Doing"/"Next"/"Blockers" are
 *  restated every idle turn even when nothing happened, so they're excluded
 *  from the comparison — otherwise a re-forked entry with fresh phrasing of
 *  the same wait would never match and noise would keep accumulating. */
export function journalFingerprint(entry: string): string {
  return entry
    .split("\n")
    .filter(l => /^(Working on|Done):/i.test(l.trim()))
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Pure comparison against the last entry in an existing journal's content
 *  (or `undefined` when no journal exists yet). */
export function isDuplicateOfLastEntry(journalContent: string | undefined, entry: string): boolean {
  const content = journalContent?.trim();
  if (!content) return false;
  const entries = splitJournalEntries(content);
  const last = entries[entries.length - 1];
  if (!last) return false;
  return journalFingerprint(last) === journalFingerprint(entry);
}

export function journalMode(pi: ExtensionAPI, modelsPath?: string): "turn" | "done" | "off" {
  const v = pi.getFlag("picode-journal");
  if (v === "done" || v === "off") return v;
  if (modelsPath) {
    try {
      const cfg = fs.existsSync(modelsPath)
        ? (JSON.parse(fs.readFileSync(modelsPath, "utf8")) as Record<string, string>)
        : {};
      const c = cfg["journal-cadence"];
      if (c === "done" || c === "off" || c === "turn") return c;
    } catch {
      // invalid JSON — fall through to default
    }
  }
  return "done";
}

/** Fingerprint of everything a journal entry could newly report. Unchanged
 *  since the last journal write + no tool call this turn means the turn was
 *  a pure "still waiting" restatement — not worth a forked LLM call. */
export function journalSignature(store: PicodeStore): string {
  return [
    store.state,
    store.obligations
      .map(o => o.id)
      .sort()
      .join(","),
    store.barriers
      .map(b => b.id)
      .sort()
      .join(","),
  ].join("|");
}

/** Decide whether this moment deserves a forked journal entry.
 *
 *  - "turn"    — turn_end in per-turn mode: journal on structural change, or
 *                on tool-using turns at most every JOURNAL_MIN_INTERVAL_MS;
 *                a rate-limited turn records a debt instead.
 *  - "run-end" — agent_end in per-turn mode: journal only if a debt is
 *                outstanding, so the run's final state is always captured
 *                exactly once (the state flip to done/open on agent_end
 *                itself is not news — the last turn already covered it).
 *  - "done"    — agent_end in journal-mode "done": one entry per run when
 *                anything happened.
 */
export function shouldJournal(
  store: PicodeStore,
  toolUsedThisTurn: boolean,
  phase: "turn" | "run-end" | "done" = "turn",
): boolean {
  const sig = journalSignature(store);
  const changed = sig !== store.lastJournalSignature;
  let write: boolean;
  if (phase === "run-end") {
    write = store.journalDebt;
  } else if (phase === "done") {
    write = changed || toolUsedThisTurn;
  } else {
    if (!changed && !toolUsedThisTurn) return false;
    write = changed || Date.now() - store.lastJournalAt >= JOURNAL_MIN_INTERVAL_MS;
    if (!write) store.journalDebt = true;
  }
  if (write) {
    store.lastJournalSignature = sig;
    store.lastJournalAt = Date.now();
    store.journalDebt = false;
  }
  return write;
}

/** How to re-invoke pi from inside a running pi process. `spawn("pi")`
 *  breaks on Windows — npm installs pi as a `pi.cmd` shim that spawn() can't
 *  execute (ENOENT) — and is fragile under version managers. Re-running
 *  exactly what started this process needs no PATH lookup at all:
 *  node-launched installs (npm, volta — including their Windows shims, which
 *  resolve to `node.exe <entry.js>` by the time this code runs) re-invoke
 *  `execPath entryScript`, standalone pi binaries re-invoke `execPath`
 *  directly. */
export function piSelfCommand(
  args: string[],
  execPath: string = process.execPath,
  entryScript: string | undefined = process.argv[1],
): { cmd: string; args: string[] } {
  const exe = (execPath.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (exe.startsWith("node")) {
    if (entryScript) return { cmd: execPath, args: [entryScript, ...args] };
    return { cmd: "pi", args }; // no identifiable entry — PATH as a last resort
  }
  return { cmd: execPath, args }; // pi is a standalone executable
}

/** Spawn args for the journal fork.
 *
 *  Extensions load normally so the journal model can resolve through any
 *  registered provider (including extension-registered ones like commandcode).
 *  The ghost-chain bug (fork inheriting picode identity → minting a fresh
 *  .picode/ dir → forking another journal → ∞) is prevented in lifecycle.ts:
 *  `hasThreadIdentity` returns false for any session with a `parentSession`
 *  header, so picode stays inactive in the fork and never forks again.
 *
 *  No `--model` unless one is explicitly configured: the fork then inherits
 *  the forked session's own model, which resolves on any machine by
 *  construction. A hardcoded cheap model looks free until the extension runs
 *  on a machine whose provider can't serve it — then every fork dies before
 *  printing and the journal silently never exists. */
export function journalForkArgs(sessionFile: string, sessionDir: string, model?: string): string[] {
  return [
    "--fork",
    sessionFile,
    "--session-dir",
    sessionDir,
    ...(model ? ["--model", model] : []),
    "--thinking",
    "off",
    "--print",
    JOURNAL_PROMPT,
  ];
}

/** Fork the session into a throwaway run that writes one journal entry.
 *  Fire-and-forget: runs in the background after turn_end/agent_end, the
 *  main picode never pauses on it. */
export function forkJournalEntry(store: PicodeStore, sessionFile: string, model?: string): void {
  // The journal channel is an optional backend extension (PROTOCOL-FORMALISM
  // §5) — on a backend without it there is nowhere to append, so don't pay
  // for the forked model call either.
  if (!store.adapter.appendJournal) return;
  const tmpSes = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-"));
  let out = "";
  let errOut = "";
  const launch = piSelfCommand(journalForkArgs(sessionFile, tmpSes, model));
  const proc = spawn(launch.cmd, launch.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.on("error", err => {
    console.error("[picode] journal fork failed to spawn:", err);
    fs.rmSync(tmpSes, { recursive: true, force: true });
  });
  proc.stdout!.on("data", (d: Buffer) => {
    out += d.toString();
  });
  proc.stderr!.on("data", (d: Buffer) => {
    errOut += d.toString();
  });
  proc.on("close", code => {
    void (async () => {
      fs.rmSync(tmpSes, { recursive: true, force: true });
      const entry = out.trim();
      if (!entry) {
        // A fork that never produces an entry must not fail silently — this
        // is exactly how a misconfigured journal model reads as "journal.md
        // just never appears".
        const balanceErr = /402|Insufficient Balance|insufficient_balance|no balance/i.test(errOut);
        const msg = balanceErr
          ? `[picode] journal fork failed: model balance/quota error (exit ${code}). Set a cheaper journal model via /picode-models. stderr: ${errOut.trim().slice(0, 200)}`
          : `[picode] journal fork produced no entry (exit ${code})${errOut.trim() ? `: ${errOut.trim().slice(0, 300)}` : ""}`;
        console.error(msg);
        return;
      }
      const existing = await store.adapter.readJournal?.(store.picodeId);
      if (isDuplicateOfLastEntry(existing, entry)) return;
      const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
      await store.adapter.appendJournal?.(store.picodeId, `\n<!-- ${ts} -->\n${entry}\n`);
    })();
  });
}

/** Pure decision: given a journal's current content, return the entries to
 *  drop (replace with summary) and the entries to keep verbatim.
 *  Returns null when no compaction is warranted. */
export function decideCompaction(
  content: string,
  now: number = Date.now(),
): { toSummarize: string[]; toKeep: string[] } | null {
  const entries = splitJournalEntries(content);
  if (entries.length <= JOURNAL_COMPACT_THRESHOLD) return null;
  // Cooldown: if the newest entry is a COMPACTION marker less than COOLDOWN_MS old, skip.
  const last = entries[entries.length - 1];
  if (isCompactionEntry(last)) {
    const m = /^<!--\s*COMPACTION\s+(.+?)\s*-->/.exec(last);
    if (m) {
      const ts = new Date(m[1].replace(" ", "T") + ":00Z").getTime();
      if (Number.isFinite(ts) && now - ts < JOURNAL_COMPACT_COOLDOWN_MS) return null;
    }
  }
  return {
    toSummarize: entries.slice(0, entries.length - JOURNAL_COMPACT_KEEP_RECENT),
    toKeep: entries.slice(entries.length - JOURNAL_COMPACT_KEEP_RECENT),
  };
}

/** If journal exceeds threshold, summarize oldest entries into one block.
 *  Fire-and-forget. Re-reads journal under lock before write so any
 *  appends that landed during the summarizer fork are preserved. */
export function compactJournal(store: PicodeStore, sessionFile: string, model?: string): void {
  if (!store.adapter.appendJournal || !store.adapter.readJournal) return;
  void (async () => {
    const existing = await store.adapter.readJournal!(store.picodeId);
    if (!existing) return;
    const plan = decideCompaction(existing);
    if (!plan) return;

    const tmpSes = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-compact-"));
    const prompt = COMPACTION_PROMPT.replace("ENTRIES_HERE", plan.toSummarize.join("\n---\n"));
    const launch = piSelfCommand(
      journalForkArgs(sessionFile, tmpSes, model).map(a => (a === JOURNAL_PROMPT ? prompt : a)),
    );
    let out = "";
    let errOut = "";
    const proc = spawn(launch.cmd, launch.args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.on("error", err => {
      console.error("[picode] journal compaction fork failed to spawn:", err);
      fs.rmSync(tmpSes, { recursive: true, force: true });
    });
    proc.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr!.on("data", (d: Buffer) => {
      errOut += d.toString();
    });
    proc.on("close", code => {
      fs.rmSync(tmpSes, { recursive: true, force: true });
      const summary = out.trim();
      if (!summary) {
        const balanceErr = /402|Insufficient Balance|insufficient_balance|no balance/i.test(errOut);
        const msg = balanceErr
          ? `[picode] journal compaction failed: model balance/quota error (exit ${code}). Set a cheaper journal model via /picode-models. stderr: ${errOut.trim().slice(0, 200)}`
          : `[picode] journal compaction produced no summary (exit ${code})${errOut.trim() ? `: ${errOut.trim().slice(0, 300)}` : ""}`;
        console.error(msg);
        return;
      }
      void (async () => {
        // Re-read under lock to catch any appends that landed during fork.
        await store.adapter.acquireJournalLock?.(store.picodeId);
        try {
          const fresh = (await store.adapter.readJournal!(store.picodeId)) ?? "";
          const freshEntries = splitJournalEntries(fresh);
          // Keep the last JOURNAL_COMPACT_KEEP_RECENT of the fresh data so
          // any appends during the fork are preserved.
          const keepFromFresh = freshEntries.slice(-JOURNAL_COMPACT_KEEP_RECENT);
          const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
          const compactionEntry = `<!-- COMPACTION ${ts} -->\n${summary}\n`;
          const newContent = compactionEntry + "\n" + keepFromFresh.join("\n") + "\n";
          await store.adapter.setJournal!(store.picodeId, newContent);
          console.log(
            `[picode] journal compacted: ${freshEntries.length} → ${keepFromFresh.length + 1} entries`,
          );
        } finally {
          await store.adapter.releaseJournalLock?.(store.picodeId);
        }
      })();
    });
  })();
}
