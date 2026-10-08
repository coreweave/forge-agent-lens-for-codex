# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report them privately through GitHub's
[private vulnerability reporting](https://github.com/coreweave/forge-agent-lens-for-codex/security/advisories/new):
on this repository, go to the **Security** tab → **Report a vulnerability**.

When reporting, please include as much of the following as you can:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- Affected version(s) of `forge-agent-lens-for-codex`
- Any suggested remediation

We will acknowledge your report, keep you updated on our progress, and
coordinate disclosure with you once a fix is available. Please give us a
reasonable opportunity to remediate before any public disclosure.

## Supported versions

Security fixes are released in the latest version on npm,
[`@coreweave/forge-agent-lens-for-codex`](https://www.npmjs.com/package/@coreweave/forge-agent-lens-for-codex).
Please upgrade to the latest release before reporting.

## Scope

`forge-agent-lens-for-codex` runs locally. Its Codex Stop hook starts a
collector that reads Codex rollout files and sends completed turns through the
CoreWeave Forge SDK to the W&B instance you configure, using your W&B
credentials. It does not bundle a server component. Reports about the hook and
collector's handling of credentials, rollout content, the content-capture
setting, cursor and lock files, or `hooks.json` are in scope.

The CoreWeave Forge SDK, the OpenAI Codex CLI, and the W&B service are separate
projects with their own reporting channels.

## Known operating constraints

- Content capture is on by default. Prompts, assistant output, reasoning, tool
  arguments and results, and the working directory are exported unless
  `FORGE_CODEX_INCLUDE_CONTENT=false` or `include_content: false` is set.
- Model names, token usage, timing, tool names, call IDs, and MCP server names
  are exported even when content capture is disabled.
- Cursor files store rollout byte offsets, not rollout content. The collector
  log records session IDs, rollout paths, and export errors.
