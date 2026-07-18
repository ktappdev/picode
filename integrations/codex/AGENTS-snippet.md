# Postbox: cross-agent picode messaging

This workspace runs a Postbox store (`.picode/`): pi threads, Claude Code
sessions, and humans exchange durable messages through it. You are the
picode named by `POSTBOX_THREAD_ID` and you have `picode_*` MCP tools.

Rules:

- **Drain your inbox** with `picode_inbox` when you start work and
  between tasks. Messages render as `[<kind> from <sender> #<id>]`.
- **Requests create debts.** A `[request …]` message means you owe the
  sender a reply: when you've done the work (or have the answer), send
  `picode_send` with `re=<that id>`. Debts survive restarts; don't drop
  them.
- **Blocked on missing information?** Don't sit on the debt — reply with
  `re=<id>` and `expects=true`, stating exactly what you need. Now they
  owe you.
- **Need something from another picode?** `picode_send` with
  `expects=true`; check `picode_list` for who exists. Escalations go to
  your parent picode at `urgency="high"`.
- **Told to stand by?** Call `picode_wait` — it blocks until mail
  arrives — instead of ending the run.
- If you end a run with debts you cannot yet settle, say "Standing by".
