// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

/**
 * Per-session byte-offset cursor so each Stop hook reads only the rollout bytes
 * appended since the previous turn. Rollout files are strictly append-only, so a
 * byte offset is a safe, simple cursor.
 */
import {createHash, randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';

import {FORGE_CODEX_HOME} from '../constants.js';

/** Per-session byte-offset cursors so each turn reads only new rollout lines. */
const CURSOR_DIR = join(FORGE_CODEX_HOME, 'cursors');

function cursorPath(sessionId: string): string {
  // Session ids are UUID-ish but hash anyway so the filename is always safe.
  const safe = createHash('sha256')
    .update(sessionId)
    .digest('hex')
    .slice(0, 32);
  return join(CURSOR_DIR, `${safe}.offset`);
}

export async function readOffset(sessionId: string): Promise<number> {
  try {
    const raw = await fs.readFile(cursorPath(sessionId), 'utf8');
    const value = raw.trim();
    if (!/^\d+$/.test(value)) throw new Error('cursor is not a byte offset');
    const offset = Number(value);
    if (!Number.isSafeInteger(offset)) throw new Error('cursor is too large');
    return offset;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

export async function cursorExists(sessionId: string): Promise<boolean> {
  try {
    await fs.access(cursorPath(sessionId));
    return true;
  } catch {
    return false;
  }
}

/** Create a cursor only when one does not already exist. */
export async function initializeOffset(
  sessionId: string,
  offset: number
): Promise<boolean> {
  await fs.mkdir(CURSOR_DIR, {recursive: true});
  const path = cursorPath(sessionId);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, String(offset), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function writeOffset(
  sessionId: string,
  offset: number
): Promise<void> {
  await fs.mkdir(CURSOR_DIR, {recursive: true});
  // Never move the cursor backward: a slow/racing worker must not rewind past a
  // newer worker's commit (which would re-emit later turns).
  const current = await readOffset(sessionId);
  if (offset <= current) return;
  const path = cursorPath(sessionId);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, String(offset), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporary, path);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

interface NewLinesResult {
  lines: string[];
  /** End of the last COMPLETE line read; commit only after successful emit. */
  nextOffset: number;
}

/**
 * Read complete (newline-terminated) lines from `fromOffset` to EOF. A trailing
 * partial line (writer mid-flush) is left unconsumed for the next read.
 */
export async function readNewLines(
  filePath: string,
  fromOffset: number
): Promise<NewLinesResult> {
  const handle = await fs.open(filePath, 'r');
  try {
    const {size} = await handle.stat();
    if (size <= fromOffset) return {lines: [], nextOffset: fromOffset};

    const length = size - fromOffset;
    const buffer = Buffer.allocUnsafe(length);
    // Honor bytesRead: a short read leaves the buffer tail uninitialized, so we
    // must only decode the bytes actually read (a rare under-read of the tail is
    // re-read from the same offset on the next Stop).
    const {bytesRead} = await handle.read(buffer, 0, length, fromOffset);

    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return {lines: [], nextOffset: fromOffset};

    const complete = text.slice(0, lastNewline);
    // Keep lines 1:1 with newline-delimited records (no empty filter) so the
    // caller can map line index → byte offset exactly when committing the cursor.
    const lines = complete.split('\n');
    // +1 for the consumed newline byte. byteLength because offsets are bytes.
    const nextOffset = fromOffset + Buffer.byteLength(complete, 'utf8') + 1;
    return {lines, nextOffset};
  } finally {
    await handle.close();
  }
}

export function offsetAfterLines(
  lines: readonly string[],
  count: number,
  fromOffset = 0
): number {
  let offset = fromOffset;
  for (let i = 0; i < count && i < lines.length; i++) {
    offset += Buffer.byteLength(lines[i]!, 'utf8') + 1;
  }
  return offset;
}
