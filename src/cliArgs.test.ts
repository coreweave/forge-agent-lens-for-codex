// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

import {describe, expect, it} from 'vitest';

import {parseCollectArgs} from './cliArgs.js';

describe('parseCollectArgs', () => {
  it('requires explicit consent for a history backfill', () => {
    expect(parseCollectArgs([])).toEqual({
      json: false,
      error: '`--all` is required to confirm history backfill',
    });
    expect(parseCollectArgs(['--json'])).toEqual({
      json: true,
      error: '`--all` is required to confirm history backfill',
    });
  });

  it('accepts --all with optional JSON output', () => {
    expect(parseCollectArgs(['--all'])).toEqual({json: false});
    expect(parseCollectArgs(['--all', '--json'])).toEqual({json: true});
  });

  it('rejects unknown flags', () => {
    expect(parseCollectArgs(['--all', '--bogus']).error).toMatch(/--bogus/);
  });
});
