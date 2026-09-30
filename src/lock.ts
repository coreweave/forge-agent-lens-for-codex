// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

/**
 * Per-session advisory lock so two collector workers never process the same
 * session concurrently (which would double-emit spans or rewind the cursor).
 *
 * Each contender owns a uniquely named claim. Dead-process claims can be
 * removed without ever touching a live successor's file.
 */
import {createHash, randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';

import {FORGE_CODEX_HOME} from './constants.js';

const LOCK_DIR = join(FORGE_CODEX_HOME, 'locks');
const CLAIM_SUFFIX = '.claim';

type ReleaseLock = () => Promise<void>;

function sessionLockDir(sessionId: string): string {
  const safe = createHash('sha256')
    .update(sessionId)
    .digest('hex')
    .slice(0, 32);
  return join(LOCK_DIR, safe);
}

/**
 * Returns a release function if the lock was acquired, or null if another live
 * worker holds it (caller should skip — a later Stop re-reads from the cursor).
 */
export async function acquireLock(
  sessionId: string
): Promise<ReleaseLock | null> {
  const dir = sessionLockDir(sessionId);
  await fs.mkdir(dir, {recursive: true});
  if ((await liveClaims(dir)).length > 0) return null;

  const claim = join(dir, `${process.pid}-${randomUUID()}${CLAIM_SUFFIX}`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(claim, 'wx', 0o600);
    await handle.close();
  } catch (err) {
    await handle?.close().catch(() => {});
    await fs.unlink(claim).catch(() => {});
    throw err;
  }

  // If contenders both observed an empty directory, at most one may proceed.
  // A contender that sees any other live claim removes only its own. Depending
  // on interleaving, one wins or all defer; two can never both win.
  const competing = (await liveClaims(dir)).some(path => path !== claim);
  if (competing) {
    await fs.unlink(claim).catch(() => {});
    return null;
  }

  return async () => {
    await fs.unlink(claim).catch(() => {});
  };
}

async function liveClaims(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, {withFileTypes: true});
  const live: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(CLAIM_SUFFIX)) continue;
    const path = join(dir, entry.name);
    const pid = Number.parseInt(entry.name.split('-', 1)[0]!, 10);
    if (isProcessAlive(pid)) {
      live.push(path);
    } else {
      await fs.unlink(path).catch(() => {});
    }
  }
  return live;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
