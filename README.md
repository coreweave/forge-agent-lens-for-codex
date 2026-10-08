# Forge Agent Lens for Codex

[![npm version](https://img.shields.io/npm/v/@coreweave/forge-agent-lens-for-codex.svg)](https://www.npmjs.com/package/@coreweave/forge-agent-lens-for-codex)
[![CI](https://github.com/coreweave/forge-agent-lens-for-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/coreweave/forge-agent-lens-for-codex/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/coreweave/forge-agent-lens-for-codex.svg)](https://github.com/coreweave/forge-agent-lens-for-codex/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@coreweave/forge-agent-lens-for-codex.svg)](https://github.com/coreweave/forge-agent-lens-for-codex/blob/main/package.json)

[CoreWeave Forge Agent Lens](https://docs.coreweave.com/products/agent-lens/what-is-agent-lens)
integration for the OpenAI Codex CLI that traces agent turns, model calls,
token usage, and tool calls.

When a turn finishes, a Codex Stop hook starts a detached collector, so tracing
does not block Codex. The collector reads the Codex rollout file and sends the
turn to Agent Lens as one trace. Turns from the same Codex session share a
conversation ID, so Agent Lens shows them as one conversation.

> [!WARNING]
> Content capture is on by default. Prompts, assistant output, reasoning, tool
> arguments and results, and the working directory are sent to Agent Lens. See
> [Content capture](#content-capture) to leave them out.

## Requirements

- macOS or Linux
- Node.js 20.6 or newer
- A current Codex CLI with hooks and rollout logging enabled
- A [W&B API key](https://forge.coreweave.com/wandb/authorize) and an Agent
  Lens project in `entity/project` form

`codex --ephemeral` is not supported because it does not write a rollout file.

## Install

Install the package, set your project and API key, then install the hook:

```shell
npm install --global @coreweave/forge-agent-lens-for-codex
export FORGE_TRACE_PROJECT=<entity>/<project>
export WANDB_API_KEY=<your-api-key> # or use `wandb login`
forge-agent-lens-for-codex install
```

Review and enable the new hook with `/hooks` in Codex. For a one-off automation
run, Codex also supports `--dangerously-bypass-hook-trust`.

`install` records the existing rollouts as already exported, so history from
before installation isn't uploaded. Use [`collect --all`](#headless-runs-and-explicit-collection)
to backfill it deliberately.

## Configuration

| Setting            | Environment variable          | `settings.json` key | Default                 |
| ------------------ | ----------------------------- | ------------------- | ----------------------- |
| Agent Lens project | `FORGE_TRACE_PROJECT`         | `project`           | required                |
| W&B API key        | `WANDB_API_KEY`               | not stored          | matching `.netrc` entry |
| Provider name      | `FORGE_CODEX_PROVIDER_NAME`   | `provider_name`     | `openai`                |
| Include content    | `FORGE_CODEX_INCLUDE_CONTENT` | `include_content`   | `true`                  |
| Debug logging      | `FORGE_CODEX_DEBUG`           | `debug`             | `false`                 |

Forge SDK owns trace-server resolution and transport. Use `WANDB_BASE_URL` for a
custom W&B deployment or `WF_TRACE_SERVER_URL` for an explicit trace-server
override. When resolving `.netrc`, `forge-agent-lens-for-codex` looks up
`api.wandb.ai` by default or the host (including a custom port) from
`WANDB_BASE_URL`.

State, settings, and the collector log live under
`~/.forge-agent-lens-for-codex/`. Set `FORGE_CODEX_HOME` only for isolated
development or test environments.

### Content capture

Set `FORGE_CODEX_INCLUDE_CONTENT=false` to omit the content listed above.
Spans keep model names, token usage, timing, tool names, call IDs, and MCP
server names. This package does not perform PII scrubbing or semantic
redaction.

For interactive Stop-hook collection, set `include_content` to `false` in
`~/.forge-agent-lens-for-codex/settings.json`. A variable set only on the
`codex` client command may not reach hooks run by an already-running Codex app
server. The environment of the hook process takes precedence over the settings
file, so leave `FORGE_CODEX_INCLUDE_CONTENT` unset there or set it to `false`
before sensitive turns. The environment variable is reliable for explicit
`forge-agent-lens-for-codex collect`.

## What gets traced

Each turn becomes one trace:

```text
invoke_agent codex       the turn, from your prompt until Codex stops
├─ chat <model>          each model call, with token usage
└─ execute_tool <tool>   each tool call and its result
```

Spans use the standard OpenTelemetry GenAI (`gen_ai.*`) attributes and are
timed from the rollout's timestamps. Successful exports advance a per-session
cursor, so the same completed turn is never sent twice. If an export fails, the
cursor doesn't advance and the turn is retried at the next Stop.

### Limitations

- `codex mcp`, direct app-server/API sessions, aborted turns without a Stop
  event, and Windows are not supported.
- Subagent operations appear as tool spans. Their separate rollout files are
  not reconstructed as nested traces.

## Headless runs and explicit collection

Some `codex exec` environments do not run the Stop hook. Wrap the command to
baseline cursor-less rollout files, run Codex, and collect new work afterward:

```shell
forge-agent-lens-for-codex run -- codex exec "fix the failing test"
forge-agent-lens-for-codex run --json -- codex exec "fix the failing test"
```

The wrapper always returns the wrapped command's exit code. A tracing failure is
reported to stderr but does not replace that code.

Existing sessions with cursors may also contain pending turns, so `run` sweeps
them after the command. A pre-existing cursor-less file is never backfilled by
the wrapper if it could not be baselined safely.

`collect --all` is an explicit backfill. A rollout without a cursor is read from
offset zero, so this command can send history created before installation:

```shell
forge-agent-lens-for-codex collect --all
forge-agent-lens-for-codex collect --all --json
```

## Status, upgrade, and uninstall

```shell
forge-agent-lens-for-codex status
forge-agent-lens-for-codex status --json
forge-agent-lens-for-codex uninstall
```

Status reports only whether an API key resolved; it never prints the secret.
Uninstall removes only the `forge-agent-lens-for-codex-hook` handler and
preserves unrelated hook groups and handlers.

The hook records the Node.js and package paths it was installed with. To
upgrade, or after switching Node.js versions, reinstall the package and rerun
`install`:

```shell
npm install --global @coreweave/forge-agent-lens-for-codex@latest
forge-agent-lens-for-codex install
```

See the [changelog][changelog] for what changed in each release.

## Development

```shell
git clone https://github.com/coreweave/forge-agent-lens-for-codex.git
cd forge-agent-lens-for-codex
npm ci
npm run check
```

See [DEVELOPMENT.md][development] for the architecture and smoke tests.

## Contributing

See [CONTRIBUTING.md][contributing]. Contributions require agreeing to the
[CoreWeave CLA][cla]. Report vulnerabilities privately as described in
[SECURITY.md][security].

## License

[Apache License 2.0][license]

## Trademarks

OpenAI and Codex are trademarks of OpenAI. This project is not affiliated with,
sponsored by, or endorsed by OpenAI.

[changelog]: https://github.com/coreweave/forge-agent-lens-for-codex/blob/main/CHANGELOG.md
[cla]: https://github.com/coreweave/forge-agent-lens-for-codex/blob/main/CLA.md
[contributing]: https://github.com/coreweave/forge-agent-lens-for-codex/blob/main/CONTRIBUTING.md
[development]: https://github.com/coreweave/forge-agent-lens-for-codex/blob/main/DEVELOPMENT.md
[license]: https://github.com/coreweave/forge-agent-lens-for-codex/blob/main/LICENSE
[security]: https://github.com/coreweave/forge-agent-lens-for-codex/blob/main/SECURITY.md
