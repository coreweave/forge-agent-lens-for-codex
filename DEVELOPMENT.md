# Development

## Architecture

Codex appends JSONL records under
`~/.codex/sessions/**/rollout-*.jsonl`. The parser groups completed records into
a turn with model calls and tool calls. The emitter maps that model to Forge SDK
`Conversation`, `Turn`, `LLM`, and `Tool` objects.

```text
Codex Stop hook
  -> detached collector
  -> rollout parser and per-session cursor
  -> Forge SDK typed spans
  -> Agent Lens
```

The adapter owns Codex-specific parsing, configuration, cursor files, locks,
and the content switch. Forge SDK owns endpoint resolution, auth headers,
resource attributes, batching, export, flush, and shutdown. There is no second
OTLP exporter in this repository.

Each completed turn runs in its own Forge tracing scope. Model and tool spans
are siblings under the turn and use timestamps from the rollout. Child times
are clamped to the turn window. Large turns flush at bounded intervals, and
multi-turn batches flush between turns. The final shutdown flushes and closes
the provider.

The cursor advances only after a successful batch. Installation initializes an
absent cursor after the last completed turn in every existing rollout. An
incomplete tail stays before the cursor so a later Stop can finish it, and
reinstall never replaces an existing cursor. `run` applies the same baseline
before starting its child, while `collect --all` deliberately backfills a
cursor-less file from offset zero.

## Local checks

```shell
npm ci
npm run build
npm run typecheck
npm run lint
npm test
npm audit
npm pack --dry-run
```

The tests cover rollout parsing, all supported tool shapes, historical timing,
content opt-out, cursor and lock behavior, hook merging, run exit codes,
baseline privacy, retry after an initially empty read, and exact in-memory Forge
span trees.

To smoke-test the packed artifact locally:

```shell
npm run build
tarball=$(npm pack --silent)
prefix=$(mktemp -d)
npm install --global --prefix "$prefix" "./$tarball"
"$prefix/bin/forge-codex" --help
FORGE_CODEX_HOME="$prefix/state" CODEX_HOME="$prefix/codex" \
  FORGE_TRACE_PROJECT="entity/project" WANDB_API_KEY="test" \
  "$prefix/bin/forge-codex" status --json
```

## Manual Agent Lens smoke

Use a disposable project and an isolated `CODEX_HOME`. Install the hook, run a
Codex turn with a harmless tool call, and verify one Turn plus its LLM and Tool
spans in Agent Lens. Run `collect --all` again and confirm no additional spans
appear.

Repeat with `FORGE_CODEX_INCLUDE_CONTENT=false` and verify prompt and tool
payloads are absent. Put an older completed fixture in another isolated
`CODEX_HOME`: `install` must baseline it, while an explicit `collect --all` in a
fresh state directory must backfill it. Finally, uninstall and confirm a
neighboring dummy hook is unchanged.
