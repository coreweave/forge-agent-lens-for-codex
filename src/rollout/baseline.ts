// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

import {acquireLock} from '../lock.js';
import {
  cursorExists,
  initializeOffset,
  offsetAfterLines,
  readNewLines,
  readOffset,
} from './cursor.js';
import {parseLineMaybe, reconstructTurns} from './parser.js';
import {listRolloutFiles, readSessionId} from './sessions.js';

export interface BaselineResult {
  initialized: number;
  /** Pre-existing files that must not be swept because their baseline was unsafe. */
  skippedFiles: string[];
  errors: Array<{file: string; message: string}>;
}

type BaselineOutcome = 'initialized' | 'existing' | 'locked';

/**
 * Initialize an absent cursor after the last completed turn. An incomplete tail
 * stays readable, and an existing cursor is never replaced.
 */
async function baselineRolloutFile(file: string): Promise<BaselineOutcome> {
  const sessionId = await readSessionId(file);
  if (!sessionId) throw new Error('rollout has no readable session_meta id');
  if (await cursorExists(sessionId)) {
    await readOffset(sessionId);
    return 'existing';
  }

  // Serialize with Stop-hook and explicit collectors. Recheck after acquiring
  // because a worker may have committed a cursor while we were waiting.
  const release = await acquireLock(sessionId);
  if (!release) return 'locked';
  try {
    if (await cursorExists(sessionId)) {
      await readOffset(sessionId);
      return 'existing';
    }
    const read = await readNewLines(file, 0);
    const result = reconstructTurns(read.lines.map(parseLineMaybe), {
      fallbackSessionId: sessionId,
    });
    const offset = offsetAfterLines(read.lines, result.consumedLines);
    return (await initializeOffset(sessionId, offset))
      ? 'initialized'
      : 'existing';
  } finally {
    await release();
  }
}

export async function baselineExistingSessions(
  sessionsDir?: string
): Promise<BaselineResult> {
  const result: BaselineResult = {
    initialized: 0,
    skippedFiles: [],
    errors: [],
  };
  for (const file of await listRolloutFiles(sessionsDir)) {
    try {
      const outcome = await baselineRolloutFile(file);
      if (outcome === 'initialized') result.initialized++;
      if (outcome === 'locked') result.skippedFiles.push(file);
    } catch (err) {
      result.skippedFiles.push(file);
      result.errors.push({
        file,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
