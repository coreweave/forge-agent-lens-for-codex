// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {acquireLock} from '../lock.js';
import {FORGE_CODEX_HOME} from '../constants.js';
import {FIXTURE_SESSION_ID, simpleTurn} from '../test-support/fixtures.js';
import {baselineExistingSessions} from './baseline.js';
import {readOffset, writeOffset} from './cursor.js';

async function writeSession(lines: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fc-baseline-'));
  const day = join(root, '2026', '06', '08');
  await mkdir(day, {recursive: true});
  await writeFile(join(day, 'rollout-test.jsonl'), `${lines.join('\n')}\n`);
  return root;
}

function offsetPath(sessionId: string): string {
  const safe = createHash('sha256')
    .update(sessionId)
    .digest('hex')
    .slice(0, 32);
  return join(FORGE_CODEX_HOME, 'cursors', `${safe}.offset`);
}

describe('baselineExistingSessions', () => {
  it('places an absent cursor after the last completed turn', async () => {
    const session = randomUUID();
    const complete = simpleTurn().map(line =>
      line.replace(FIXTURE_SESSION_ID, session)
    );
    const incompleteContext = complete[1]!.replaceAll('"t1"', '"t2"');
    const root = await writeSession([...complete, incompleteContext]);

    expect((await baselineExistingSessions(root)).initialized).toBe(1);
    expect(await readOffset(session)).toBe(
      Buffer.byteLength(`${complete.join('\n')}\n`, 'utf8')
    );
  });

  it('leaves an incomplete first turn readable from offset zero', async () => {
    const session = randomUUID();
    const incomplete = simpleTurn()
      .slice(0, 4)
      .map(line => line.replace(FIXTURE_SESSION_ID, session));
    const root = await writeSession(incomplete);

    expect((await baselineExistingSessions(root)).initialized).toBe(1);
    expect(await readOffset(session)).toBe(0);
  });

  it('never replaces an existing cursor during reinstall', async () => {
    const session = randomUUID();
    const lines = simpleTurn().map(line =>
      line.replace(FIXTURE_SESSION_ID, session)
    );
    const root = await writeSession(lines);
    await writeOffset(session, 17);

    expect((await baselineExistingSessions(root)).initialized).toBe(0);
    expect(await readOffset(session)).toBe(17);
  });

  it('does not race a collector that already owns the session', async () => {
    const session = randomUUID();
    const lines = simpleTurn().map(line =>
      line.replace(FIXTURE_SESSION_ID, session)
    );
    const root = await writeSession(lines);
    const release = await acquireLock(session);

    const result = await baselineExistingSessions(root);
    expect(result.initialized).toBe(0);
    expect(result.skippedFiles).toHaveLength(1);
    expect(await readOffset(session)).toBe(0);
    await release!();
  });

  it('treats an invalid existing cursor as unsafe', async () => {
    const session = randomUUID();
    const lines = simpleTurn().map(line =>
      line.replace(FIXTURE_SESSION_ID, session)
    );
    const root = await writeSession(lines);
    await writeOffset(session, 17);
    await writeFile(offsetPath(session), '');

    const result = await baselineExistingSessions(root);
    expect(result.initialized).toBe(0);
    expect(result.skippedFiles).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/not a byte offset/);
  });
});
