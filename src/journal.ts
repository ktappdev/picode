/** Read-only helpers for work journals created before the papercut journal.
 * Automatic summaries, forked model calls, and compaction have been removed.
 * New entries live in the shared .picode/issues.md (bin/issue-journal.mjs). */

/** Entries are separated by their `<!-- timestamp -->` headers. */
export function splitJournalEntries(content: string): string[] {
  return content.split(/\n(?=<!--)/).filter(Boolean);
}

/** Extract the timestamp from a journal entry's `<!-- ... -->` header.
 *  Returns null for entries without a parseable header. */
function entryTimestamp(entry: string): string | null {
  const m = /^<!--\s*(.+?)\s*-->/.exec(entry.trimStart());
  return m ? m[1] : null;
}

/** Extract the first `Working on:` line from a journal entry, trimmed.
 *  Falls back to the first non-header, non-empty line if the field is
 *  absent (e.g. compaction summaries). Returns "(no summary)" if the
 *  entry has no usable subject line. */
function entrySubject(entry: string): string {
  const lines = entry.trimStart().split("\n");
  for (const line of lines) {
    const m = /^Working on:\s*(.*)$/i.exec(line.trim());
    if (m && m[1]) return m[1].trim();
  }
  // No "Working on:" — take the first non-header, non-empty line.
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("<!--")) continue;
    return t;
  }
  return "(no summary)";
}

/** Compact a single journal entry to one line: `[ts] subject`.
 *  Used by picode_status/picode_journal when compact=true (default) to
 *  avoid dumping 5+ lines per entry into the chat. The full multi-line
 *  entry is still available via compact=false or tail=0. */
export function compactEntry(entry: string): string {
  const ts = entryTimestamp(entry);
  const subject = entrySubject(entry);
  return ts ? `[${ts}] ${subject}` : subject;
}
