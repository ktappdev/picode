---
name: cleanup-panes
description: Kill stale herdr worker panes spawned by the coordinator. Removes panes with role labels (builder, explorer, reviewer, tester, worker, scout, bug-hunter, designer) that are not working or idle. Use when the thread list is cluttered with dead workers.
---

# Cleanup Panes

Remove dead worker panes from the current workspace. Only targets panes the coordinator created — user panes are untouched.

## Usage

Run these bash commands to clean up:

```bash
# Get current workspace ID
WS=$HERDR_WORKSPACE_ID

# List all panes, filter to known worker roles that are NOT working/idle
herdr pane list --workspace "$WS" | jq -r '.result.panes[] | select(.label | test("builder|explorer|reviewer|tester|worker|scout|bug-hunter|designer"; "i")) | select(.agent_status != "working" and .agent_status != "idle") | .pane_id'
```

For each pane ID returned, close it:

```bash
herdr pane close <pane_id>
```

## What Gets Killed

- Panes labeled `builder`, `explorer`, `reviewer`, `tester`, `worker-*`, `scout`, `bug-hunter`, `designer`
- Status is `stopped`, `done`, `unknown`, or any status other than `working`/`idle`

## What Gets Kept

- Coordinator pane (label contains "coordinator")
- Any pane with status `working` or `idle`
- User panes (no matching role label)
- Panes in other workspaces

## One-Liner

```bash
for id in $(herdr pane list --workspace "$HERDR_WORKSPACE_ID" | jq -r '.result.panes[] | select(.label | test("builder|explorer|reviewer|tester|worker|scout|bug-hunter|designer"; "i")) | select(.agent_status != "working" and .agent_status != "idle") | .pane_id'); do echo "closing $id"; herdr pane close "$id"; done
```
