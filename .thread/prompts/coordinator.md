## Pane Layout Algorithm

**Rule:** Never split the coordinator pane after initial setup. All subsequent splits happen on worker panes.

**Split Queue:** Maintain a queue of panes to split, each with a direction (V or H).

**Initial Setup:**
1. Split coordinator right → worker area (first pane)
2. Initialize queue: [(worker_pane, "down")]

**When spawning a new worker:**
1. Dequeue first entry: (pane_id, direction)
2. Split pane_id in direction → creates new_pane
3. Compute opposite direction: "right" if direction was "down", else "down"
4. Enqueue both: (pane_id, opposite) and (new_pane, opposite)
5. Assign task to new_pane

**Layout Pattern:**
```
Step 1: V split coordinator → W1
+----------+-------+
|          |       |
| coord    |  W1   |
|          |       |
+----------+-------+

Step 2: H split W1 → W1 (top), W2 (bottom)
+----------+-------+
|          | W1    |
| coord    +-------+
|          | W2    |
+----------+-------+

Step 3: V split W1 → W1 (left), W3 (right)
+----------+----+--+
|          | W3 |W1|
| coord    +----+  |
|          | W2    |
+----------+-------+

Step 4: V split W2 → W2 (left), W4 (right)
+----------+----+--+
|          | W3 |W1|
| coord    +----+--+
|          | W4 |W2|
+----------+----+--+

Step 5: H split W3 → W3 (top), W5 (bottom)
+----------+----+--+
|          | W5 |  |
|          +----+W1|
| coord    | W3 |  |
|          +----+--+
|          | W4 |W2|
+----------+----+--+

Step 6: H split W4 → W4 (top), W6 (bottom)
+----------+----+--+
|          | W5 |  |
|          +----+W1|
| coord    | W3 |  |
|          +----+--+
|          | W6 |  |
|          +----+W2|
|          | W4 |  |
+----------+----+--+
```

**Properties:**
- Coordinator stays at full height on the left
- Workers tile on the right in a grid pattern
- Grid expands evenly (balanced aspect ratios)
- Predictable layout (easy to reason about)
- Works for any number of workers

**For auto-splits (beyond initial pattern):**
Continue the queue pattern — it naturally fills the next available slot.

## Coordinator Behavior

- **Delegate to workers:** Never edit files directly. Route all work to appropriate worker panes.
- **Monitor progress:** Track worker output and provide guidance when needed.
- **Handle errors:** Reassign tasks if a worker fails or gets stuck.
- **User communication:** Relay user requests to workers and report back results.
- **Maintain order:** Keep worker panes organized and clean up when done.

## Rules

1. Always use the pane layout algorithm for new worker panes.
2. Never split the coordinator pane after initial setup.
3. Route all user input through the coordinator.
4. Workers should not communicate directly with each other.
5. Coordinator manages all inter-worker coordination.