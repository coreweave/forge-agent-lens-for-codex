// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readdir, rm, utimes, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {acquireLock} from './lock.js';
import {FORGE_CODEX_HOME} from './constants.js';

function dirFor(sessionId: string): string {
  const safe = createHash('sha256')
    .update(sessionId)
    .digest('hex')
    .slice(0, 32);
  return join(FORGE_CODEX_HOME, 'locks', safe);
}

describe('acquireLock', () => {
  it('grants one holder at a time and frees on release', async () => {
    const session = randomUUID();
    const first = await acquireLock(session);
    expect(first).not.toBeNull();
    expect(await acquireLock(session)).toBeNull();
    await first!();
    expect(await readdir(dirFor(session))).toEqual([]);
    const again = await acquireLock(session);
    expect(again).not.toBeNull();
    await again!();
  });

  it('locks are independent per session', async () => {
    const a = await acquireLock(randomUUID());
    const b = await acquireLock(randomUUID());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!();
    await b!();
  });

  it('does not steal an old claim while its owner is alive', async () => {
    const session = randomUUID();
    const first = await acquireLock(session);
    const [claim] = await readdir(dirFor(session));
    const old = new Date(Date.now() - 120_000);
    await utimes(join(dirFor(session), claim!), old, old);

    expect(await acquireLock(session)).toBeNull();
    await first!();
  });

  it('removes a claim after its owner exits', async () => {
    const session = randomUUID();
    const dir = dirFor(session);
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, '2147483647-orphan.claim'), '2147483647');

    const acquired = await acquireLock(session);
    expect(acquired).not.toBeNull();
    expect(await readdir(dir)).not.toContain('2147483647-orphan.claim');
    await acquired!();
  });

  it('a release removes only its own claim', async () => {
    const session = randomUUID();
    const dir = dirFor(session);
    const first = await acquireLock(session);
    const successorName = `${process.pid}-successor.claim`;
    await writeFile(join(dir, successorName), String(process.pid));

    await first!();
    expect(await readdir(dir)).toContain(successorName);
    await rm(join(dir, successorName), {force: true});
    await rm(dir, {recursive: true, force: true});
  });

  it('never grants two simultaneous contenders', async () => {
    const session = randomUUID();
    const contenders = await Promise.all(
      Array.from({length: 20}, () => acquireLock(session))
    );
    const winners = contenders.filter(
      (release): release is () => Promise<void> => release !== null
    );
    expect(winners.length).toBeLessThanOrEqual(1);
    await Promise.all(winners.map(release => release()));

    const retry = await acquireLock(session);
    expect(retry).not.toBeNull();
    await retry!();
  });
});
