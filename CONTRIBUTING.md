# Contributing to forge-agent-lens-for-codex

## Local checks

This repository uses npm-driven checks and a repo-managed Git pre-commit hook,
including secret scanning with `gitleaks`.

```shell
npm install
npm run setup-hooks
npm run check
```

Before opening a pull request, also run:

```shell
uvx --from 'reuse[charset-normalizer]==6.2.0' reuse lint
uvx --from zizmor==1.30.1 zizmor --pedantic .
```

## Test a change in Codex

Install your checkout globally and register the hook from it. `install` points
the hook at this checkout's `dist/`, so rebuild after each change:

```shell
npm run build
npm install --global .
forge-agent-lens-for-codex install
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the packed-tarball smoke test and
the manual Agent Lens smoke procedure.

## Pull requests

Use Conventional Commit titles, such as `fix: retry failed SDK flushes`, for
pull requests and commits. release-please writes the changelog from them, so
don't edit `CHANGELOG.md` by hand. Call out privacy or compatibility changes in
the pull request description, and update the README when user-visible behavior
changes. Do not commit generated build artifacts or local configuration.

## Releases

release-please keeps a release PR open that bumps the version in
`package.json` and `package-lock.json` and updates the changelog from the
Conventional Commits on `main`. Merging the PR tags `vX.Y.Z`, creates the
GitHub release, and runs the release workflow. That workflow reruns the checks,
smoke-tests the packed tarball on the minimum Node.js version, publishes it to
npm through trusted publishing with provenance, and attaches it to the GitHub
release with SHA-256 checksums. To choose the version, add a
`Release-As: X.Y.Z` footer to a commit.

Never reuse or move an existing release tag.

## Contributor License Agreement

Contributors must agree to the [CoreWeave CLA](./CLA.md) when pushing code to this project.

Agreement with the CoreWeave CLA must be signified by including a `Signed-off-by`
trailer in every submitted Git commit to this repository. By signing off, you certify that you have the right to submit the contribution and that you agree to and are bound by the CoreWeave Contributor License Agreement in effect at the date of your submission, found in [`CLA.md`](./CLA.md) in the root of this repository, which governs your submission. If you are contributing on behalf of an entity, you further certify that you are authorized to bind that entity to the CLA.

Sign each commit with the `--signoff` (`-s`) option to [`git commit`](https://git-scm.com/docs/git-commit#Documentation/git-commit.txt---signoff). Git has no configuration option that adds the trailer automatically; if you want it on every commit, use an alias such as `git config alias.ci "commit -s"` or a `prepare-commit-msg` hook.

## Licensing

This project is licensed under Apache-2.0 (see [`LICENSE`](./LICENSE)) and follows the [REUSE](https://reuse.software/) specification. REUSE requires the license text in [`LICENSES/Apache-2.0.txt`](./LICENSES/Apache-2.0.txt). Licensing metadata lives in [`REUSE.toml`](./REUSE.toml): its aggregate annotation covers every file by default, so new files need no SPDX header. If you add material under a different license or copyright, declare it with an inline SPDX header or a `REUSE.toml` annotation and include any additional license text in `LICENSES/<SPDX-License-Identifier>.txt`. Run `reuse lint` from the repository root before opening a PR.
