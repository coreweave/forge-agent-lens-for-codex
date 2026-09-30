# Forge Agent Lens for Codex

`forge-agent-lens-for-codex` sends completed OpenAI Codex CLI turns to CoreWeave Forge Agent
Lens. It reconstructs model calls, token usage, tool calls, and timing from
Codex rollout files, then emits typed spans through `@coreweave/forge-sdk`.

The Stop hook starts a detached collector, so tracing does not block Codex. One
turn becomes one trace, and turns from the same Codex session share a
conversation ID.

## Requirements

- macOS or Linux
- Node.js 20.6 or newer
- A current Codex CLI with hooks and rollout logging enabled
- A W&B API key and an Agent Lens project

`codex --ephemeral` is not supported because it does not write a rollout file.

## Install from a checkout

```shell
git clone https://github.com/coreweave/forge-agent-lens-for-codex.git
cd forge-agent-lens-for-codex
npm ci
npm run build
npm install -g .
```

Tagged GitHub releases also contain an installable `forge-agent-lens-for-codex-<version>.tgz`
tarball. npm publishing will be added after package ownership and release
credentials are configured.

Set the destination and credentials, then install the hook:

```shell
export FORGE_TRACE_PROJECT="entity/project"
export WANDB_API_KEY="..." # or use `wandb login`
forge-agent-lens-for-codex install
```

Review and enable the new hook with `/hooks` in Codex. For a one-off automation
run, Codex also supports `--dangerously-bypass-hook-trust`.

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
override. When resolving `.netrc`, `forge-agent-lens-for-codex` looks up `api.wandb.ai` by
default or the host (including a custom port) from `WANDB_BASE_URL`.

State lives under `~/.forge-agent-lens-for-codex/`. Set `FORGE_CODEX_HOME` only for isolated
development or test environments.

### Content capture

Content capture is on by default. Prompts, assistant output, reasoning, tool
arguments, tool results, and the working directory can contain source code or
other sensitive data.

Set `FORGE_CODEX_INCLUDE_CONTENT=false` to keep structural spans, model names,
token usage, timing, tool names, call IDs, and MCP server names while omitting
that content. This package does not perform PII scrubbing or semantic redaction.

For interactive Stop-hook collection, set `include_content` to `false` in
`~/.forge-agent-lens-for-codex/settings.json`. A variable set only on the `codex` client command
may not reach hooks run by an already-running Codex app server. The environment
of the hook process takes precedence over the settings file, so leave
`FORGE_CODEX_INCLUDE_CONTENT` unset there or set it to `false` before sensitive
turns. The environment variable is reliable for explicit `forge-agent-lens-for-codex collect`.

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

Successful exports advance a per-session cursor. Repeating the command does not
send the same completed turn again.

## Status and uninstall

```shell
forge-agent-lens-for-codex status
forge-agent-lens-for-codex status --json
forge-agent-lens-for-codex uninstall
```

Status reports only whether an API key resolved; it never prints the secret.
Uninstall removes only the `forge-agent-lens-for-codex-hook` handler and preserves unrelated
hook groups and handlers.

## Current limitations

`codex mcp`, direct app-server/API sessions, aborted turns without a Stop event,
Windows, and `codex --ephemeral` are outside the first release. Subagent
operations are represented as tool spans; this release does not claim to
reconstruct their separate rollout files as nested traces.

See [DEVELOPMENT.md](DEVELOPMENT.md) for the architecture, local checks, package
smoke test, and manual Agent Lens smoke procedure.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions require agreeing to the
[CoreWeave CLA](CLA.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## License

Apache 2.0. See [LICENSE](LICENSE).
