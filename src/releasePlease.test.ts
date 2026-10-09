// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

import {getFileInfo} from 'prettier';
import {describe, expect, it} from 'vitest';

// release-please writes these on the release PR (the manifest as compact JSON),
// so `prettier --check .` must skip them or the release PR and Release fail.
const RELEASE_PLEASE_FILES = ['.release-please-manifest.json', 'CHANGELOG.md'];

describe('release-please files', () => {
  it.each(RELEASE_PLEASE_FILES)('are ignored by prettier: %s', async file => {
    const {ignored} = await getFileInfo(file, {ignorePath: '.prettierignore'});
    expect(ignored).toBe(true);
  });
});
