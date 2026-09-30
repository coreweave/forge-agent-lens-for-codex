# rollout/

The **ingest half** of the pipeline: read the Codex rollout session file and turn
its raw line stream into the internal turn model. (The emit half lives in
[`../spans/`](../spans).)

Codex appends each session's events to
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` as newline-delimited JSON. Nothing
here writes to that file — it is treated as a strictly append-only source, which
is what makes a plain byte offset a safe cursor.

- **`types.ts`** — TypeScript shapes for the subset of the rollout wire format we
  consume. Field names are the exact on-disk snake_case names; this is the typed
  boundary between untrusted JSON and the rest of the code. Also exports the
  serde discriminator tags (`ROLLOUT_ITEM`, `EVENT_MSG`, `RESPONSE_ITEM`).
- **`cursor.ts`** — Per-session byte-offset cursor so each Stop hook reads only
  the bytes appended since the previous turn. The offset writer is monotonic (a
  stale/racing worker can never rewind it), and a partial trailing line left by a
  mid-flush writer is kept unconsumed for the next read.
- **`parser.ts`** — Segments the line stream into completed turns
  (`turn_context`/`task_started` … `task_complete`), pairs each tool call with
  its output by `call_id`, and attributes per-call token usage. Produces
  `ReconstructedTurn[]` (the domain model in [`../model.ts`](../model.ts)) for the
  span emitter to consume.

The parser reports how many input lines belong to fully-completed turns, and the
collector commits the cursor only that far — so a turn still being flushed is
re-read next time rather than skipped.

Each module's tests sit alongside it as `*.test.ts`; shared rollout fixtures live
in [`../test-support/`](../test-support).
