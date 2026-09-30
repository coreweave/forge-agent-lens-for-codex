// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';

import {describe, expect, it} from 'vitest';

import {listRolloutFiles, readSessionId} from './sessions.js';
import {FIXTURE_SESSION_ID, simpleTurn} from '../test-support/fixtures.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wc-sessions-'));
}

describe('listRolloutFiles', () => {
  it('finds rollout-*.jsonl recursively and ignores everything else', async () => {
    const root = await tempDir();
    const day = join(root, '2026', '06', '08');
    await mkdir(day, {recursive: true});
    await writeFile(join(day, 'rollout-a.jsonl'), '');
    await writeFile(join(day, 'rollout-b.jsonl'), '');
    await writeFile(join(day, 'notes.txt'), 'x'); // wrong suffix
    await writeFile(join(root, 'rollout-top.json'), 'x'); // wrong suffix
    await mkdir(join(root, 'empty'), {recursive: true});

    const files = await listRolloutFiles(root);
    expect(files.map(f => relative(root, f))).toEqual([
      join('2026', '06', '08', 'rollout-a.jsonl'),
      join('2026', '06', '08', 'rollout-b.jsonl'),
    ]);
  });

  it('returns [] for a missing directory (fresh machine / --ephemeral)', async () => {
    const files = await listRolloutFiles(join(tmpdir(), 'wc-absent-xyz-123'));
    expect(files).toEqual([]);
  });

  it('does not hide session-directory read failures', async () => {
    const root = await tempDir();
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'x');

    await expect(listRolloutFiles(file)).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });
});

describe('readSessionId', () => {
  it('reads the id from the session_meta line', async () => {
    const root = await tempDir();
    const file = join(root, 'rollout-x.jsonl');
    await writeFile(file, `${simpleTurn().join('\n')}\n`);
    expect(await readSessionId(file)).toBe(FIXTURE_SESSION_ID);
  });

  it('returns undefined when the first line is not session_meta', async () => {
    const root = await tempDir();
    const file = join(root, 'rollout-y.jsonl');
    const turnContext = JSON.stringify({
      timestamp: 't',
      type: 'turn_context',
      payload: {turn_id: 't1', cwd: '/x', model: 'm'},
    });
    await writeFile(file, `${turnContext}\n`);
    expect(await readSessionId(file)).toBeUndefined();
  });

  it('reads a session_meta line larger than 64 KiB', async () => {
    const root = await tempDir();
    const file = join(root, 'rollout-large.jsonl');
    const first = JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: FIXTURE_SESSION_ID,
        cwd: '/tmp',
        cli_version: '1.0.0',
        extra: 'x'.repeat(70 * 1024),
      },
    });
    await writeFile(file, `${first}\n`);

    expect(await readSessionId(file)).toBe(FIXTURE_SESSION_ID);
  });
});
