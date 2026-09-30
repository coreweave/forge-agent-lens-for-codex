# spans/

This directory maps a `ReconstructedTurn` onto Forge SDK's typed Agent Lens
surface:

```text
invoke_agent codex
├── chat <model>
└── execute_tool <name>
```

`emit.ts` creates one isolated conversation and turn, records historical
timestamps, content, token usage, and MCP metadata, then ends the typed handles.
`messages.ts` converts rollout content to Forge SDK message parts. `tracing.ts`
initializes, flushes, and shuts down Forge SDK; it does not construct an OTLP
exporter.

Tests pass an in-memory span processor through Forge SDK's public `spanProcessor`
option and assert the contract fields rather than snapshotting the complete OTLP
payload.
