// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

import {createHash, randomUUID} from 'node:crypto';
import {appendFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {FORGE_CODEX_HOME} from '../constants.js';
import {
  initializeOffset,
  readNewLines,
  readOffset,
  writeOffset,
} from './cursor.js';

function offsetPath(sessionId: string): string {
  const safe = createHash('sha256')
    .update(sessionId)
    .digest('hex')
    .slice(0, 32);
  return join(FORGE_CODEX_HOME, 'cursors', `${safe}.offset`);
}

describe('readNewLines', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wc-cursor-'));
    file = join(dir, 'rollout.jsonl');
  });
  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('returns only complete lines and the offset just past the last newline', async () => {
    await writeFile(file, 'a\nbb\n');
    expect(await readNewLines(file, 0)).toEqual({
      lines: ['a', 'bb'],
      nextOffset: 5,
    });
  });

  it('leaves a partial trailing line (writer mid-flush) unconsumed', async () => {
    await writeFile(file, 'a\npartial');
    expect(await readNewLines(file, 0)).toEqual({lines: ['a'], nextOffset: 2});
  });

  it('reads incrementally from a prior offset', async () => {
    await writeFile(file, 'a\nbb\n');
    const first = await readNewLines(file, 0);
    await appendFile(file, 'ccc\n');
    expect(await readNewLines(file, first.nextOffset)).toEqual({
      lines: ['ccc'],
      nextOffset: 9,
    });
  });

  it('keeps byte offsets correct with multibyte content', async () => {
    await writeFile(file, 'héllo\n'); // é is 2 bytes in UTF-8
    expect(await readNewLines(file, 0)).toEqual({
      lines: ['héllo'],
      nextOffset: Buffer.byteLength('héllo\n', 'utf8'),
    });
  });

  it('returns nothing when the offset is at/after EOF', async () => {
    await writeFile(file, 'a\n');
    expect(await readNewLines(file, 10)).toEqual({lines: [], nextOffset: 10});
  });
});

describe('writeOffset', () => {
  it('advances forward but never rewinds (guards the worker race)', async () => {
    const session = randomUUID();
    await writeOffset(session, 100);
    expect(await readOffset(session)).toBe(100);
    await writeOffset(session, 50); // a stale/racing worker must not rewind
    expect(await readOffset(session)).toBe(100);
    await writeOffset(session, 150);
    expect(await readOffset(session)).toBe(150);
  });

  it('rejects a truncated cursor instead of restarting at zero', async () => {
    const session = randomUUID();
    const path = offsetPath(session);
    await mkdir(join(FORGE_CODEX_HOME, 'cursors'), {recursive: true});
    await writeFile(path, '');

    await expect(readOffset(session)).rejects.toThrow(/not a byte offset/);
    await expect(writeOffset(session, 10)).rejects.toThrow(/not a byte offset/);
  });

  it('initializes once without replacing an existing cursor', async () => {
    const session = randomUUID();
    expect(await initializeOffset(session, 20)).toBe(true);
    expect(await initializeOffset(session, 30)).toBe(false);
    expect(await readOffset(session)).toBe(20);
  });
});
