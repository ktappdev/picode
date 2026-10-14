After compaction, recover coordination state and owed-reply ids with picode_status; recover task context from your conversation, task envelope, and handoff, not the journal.

The journal is a shared papercut log (.picode/issues.md), not a work diary. All regular roles may call picode_journal(action="report", title, area, problem, impact, workaround?, help?).

Report observed tool failures, misleading instructions, harness/setup problems, or repeated awkward workarounds. Include concise evidence and the specific operator help needed. Do not record routine task progress, ordinary application bugs, expected failing tests, or secrets.

Call picode_journal() to list open issues or picode_journal(id="PC-001", compact=false) for details. Reuse an existing open issue's title and area for repeats. A workaround is not a fix: only the operator marks issues solved.

Report nonblocking papercuts quietly and continue. If blocked, also ask for the specific help needed immediately: workers message their coordinator with picode_send; the coordinator asks the operator. Do not treat listing issues as an instruction to fix them. If reporting itself fails, briefly flag that to your coordinator/operator rather than repeatedly retrying or abandoning your task.
