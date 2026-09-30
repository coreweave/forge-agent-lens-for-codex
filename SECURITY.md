# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report them privately through GitHub's
[private vulnerability reporting](https://github.com/coreweave/forge-codex/security/advisories/new):
on this repository, go to the **Security** tab → **Report a vulnerability**.

When reporting, please include as much of the following as you can:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- Affected version(s) of `forge-codex`
- Any suggested remediation

We will acknowledge your report, keep you updated on our progress, and
coordinate disclosure with you once a fix is available. Please give us a
reasonable opportunity to remediate before any public disclosure.

## Supported versions

Security fixes are released in the latest GitHub release tarball. Please
upgrade to the latest release before reporting.

## Scope

`forge-codex` runs locally and sends Agent Lens trace data through Forge SDK to
the W&B instance you configure. It does not bundle a server component. Reports
about credentials, session data, or captured trace content are in scope.
