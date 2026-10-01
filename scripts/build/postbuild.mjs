#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

/**
 * Post-build finalization for the published package.
 *
 * `dist/cli.js` carries a `#!/usr/bin/env node` shebang and is the package
 * `bin` entry, so the published tarball must preserve mode 0o755 — otherwise
 * `npm install -g` produces a binary that errors with "permission denied".
 * `tsc` emits 0o644 (notably on Linux CI), so without this step the published
 * artifact is unrunnable.
 */
import {chmodSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

chmodSync(join(repoRoot, 'dist', 'cli.js'), 0o755);
