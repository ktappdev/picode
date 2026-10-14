After compaction, recover coordination state and owed-reply ids with picode_status; recover task context from your conversation, task envelope, and handoff, not the journal.

The journal is a shared papercut log (.picode/issues.md), not a work diary. All regular roles may call picode_journal(action="report", title, area, problem, impact, workaround?, help?).

At the end of each work run, before your final response/report or yielding control, briefly look back over this run’s session context: where did tools fail, instructions mislead you, setup get in the way, or awkward workarounds cost time? Workers closing an assigned task do this before picode_finish; coordinators do it before their final operator response or yielding to wait. Do not stop mid-task to catalog nonblocking friction, and do not repeat this review after every tool call or ordinary turn.

Report only actionable papercuts you actually encountered, using picode_journal(action="report", ...) after that review. Include concise evidence, impact, any workaround, and the specific operator help needed. A workaround may have let you finish without fixing the underlying problem. If the run was clean, write nothing: no “no issues” entries. Do not record routine task progress, ordinary application bugs, expected failing tests, or secrets. Do not re-report the same occurrence in later runs.

Call picode_journal() to list open issues or picode_journal(id="PC-001", compact=false) for details. Reuse an existing open issue's title and area for repeats. A workaround is not a fix: only the operator marks issues solved.

Keep nonblocking papercut reporting quiet and defer it until the end-of-run review. If blocked, ask for the specific help needed immediately rather than waiting for the retrospective: workers message their coordinator with picode_send; the coordinator asks the operator. Do not treat listing issues as an instruction to fix them. If reporting itself fails, briefly flag that to your coordinator/operator rather than repeatedly retrying or abandoning your task.
