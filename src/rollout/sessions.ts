// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

/**
 * Locate Codex rollout session files on disk and read their session id.
 *
 * Codex appends each session to `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
 * Both `status` (to report how many exist) and `collect --all` (to sweep them)
 * need this enumeration, so the walk lives here once rather than duplicated
 * across the CLI commands.
 */
import {createReadStream, promises as fs} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';

import {CODEX_SESSIONS_DIR} from '../constants.js';
import {parseLineMaybe} from './parser.js';
import type {SessionMetaPayload} from './types.js';

const ROLLOUT_PREFIX = 'rollout-';
const ROLLOUT_SUFFIX = '.jsonl';
/**
 * Every rollout file under `dir`, recursively, sorted for a deterministic sweep
 * order. A missing directory yields `[]` (a fresh machine, or a run with
 * `--ephemeral`, simply has no rollouts). Other read failures propagate so a
 * privacy baseline cannot be mistaken for an empty sessions tree.
 */
export async function listRolloutFiles(
  dir: string = CODEX_SESSIONS_DIR
): Promise<string[]> {
  const found: string[] = [];
  await walk(dir, found);
  found.sort();
  return found;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, {withFileTypes: true});
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    // isDirectory() is false for symlinks, so a stray symlink can't cause a cycle.
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (
      entry.isFile() &&
      entry.name.startsWith(ROLLOUT_PREFIX) &&
      entry.name.endsWith(ROLLOUT_SUFFIX)
    ) {
      out.push(full);
    }
  }
}

/**
 * The Codex session id for a rollout file, read from its first `session_meta`
 * line, or `undefined` if the file has no recognizable session metadata. Reads
 * only the first line — the metadata is the first record Codex writes, so there
 * is no need to read the rest of a possibly large rollout.
 */
export async function readSessionId(file: string): Promise<string | undefined> {
  return (await readSessionMetadata(file))?.id;
}

export async function readSessionMetadata(
  file: string
): Promise<SessionMetaPayload | undefined> {
  const input = createReadStream(file, {encoding: 'utf8'});
  const lines = createInterface({input, crlfDelay: Infinity});
  try {
    for await (const firstLine of lines) {
      const parsed = parseLineMaybe(firstLine);
      if (parsed?.type === 'session_meta') return parsed.payload;
      return undefined;
    }
    return undefined;
  } finally {
    lines.close();
    input.destroy();
  }
}
