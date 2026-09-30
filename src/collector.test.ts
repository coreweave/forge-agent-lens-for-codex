// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

import {randomUUID} from 'node:crypto';
import {appendFile, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import * as tracing from '@coreweave/forge-sdk/agentlens/tracing';
import {SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';
import {describe, expect, it} from 'vitest';

import {collect, collectAllSessions} from './collector.js';
import type {ResolvedConfig} from './config.js';
import {readOffset} from './rollout/cursor.js';
import {
  FIXTURE_SESSION_ID,
  multiToolTurn,
  simpleTurn,
} from './test-support/fixtures.js';
import {RetainingSpanExporter} from './test-support/retainingExporter.js';

const CFG: ResolvedConfig = {
  apiKey: 'k',
  projectId: 'ent/proj',
  entity: 'ent',
  project: 'proj',
  providerName: 'openai',
  includeContent: true,
  debug: false,
};

function inMemory(failShutdown = false) {
  const exporter = new RetainingSpanExporter();
  let forceFlushCount = 0;
  const make = (config: ResolvedConfig) => ({
    init: () =>
      tracing.init(config.projectId, {
        apiKey: config.apiKey,
        serviceName: 'forge-codex',
        spanProcessor: new SimpleSpanProcessor(exporter),
      }),
    forceFlush: async () => {
      forceFlushCount++;
      await tracing.forceFlush();
    },
    shutdown: async () => {
      await tracing.shutdown();
      if (failShutdown) throw new Error('export boom');
    },
  });
  return {exporter, make, forceFlushCount: () => forceFlushCount};
}

async function writeRollout(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fc-collector-'));
  const file = join(dir, 'rollout.jsonl');
  await writeFile(file, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  return file;
}

function payload(session: string, file: string) {
  return {
    session_id: session,
    turn_id: 't9',
    transcript_path: file,
    model: 'gpt-5-codex',
    last_assistant_message: 'Found 2 files',
  };
}

const op = (s: {attributes: Record<string, unknown>}) =>
  s.attributes['gen_ai.operation.name'];

describe('collect', () => {
  it('emits the Forge span tree and advances the cursor', async () => {
    const session = randomUUID();
    const file = await writeRollout(multiToolTurn());
    const memory = inMemory();
    await collect(
      file,
      session,
      payload(session, file),
      {...CFG, providerName: 'wandb-inference'},
      memory.make
    );

    const spans = memory.exporter.getFinishedSpans();
    expect(spans.filter(s => op(s) === 'invoke_agent')).toHaveLength(1);
    expect(spans.filter(s => op(s) === 'chat')).toHaveLength(3);
    expect(spans.filter(s => op(s) === 'execute_tool')).toHaveLength(2);
    expect(
      spans
        .filter(s => op(s) === 'chat')
        .map(s => s.attributes['gen_ai.provider.name'])
    ).toEqual(['wandb-inference', 'wandb-inference', 'wandb-inference']);
    expect(await readOffset(session)).toBeGreaterThan(0);
  });

  it('is idempotent after the cursor advances', async () => {
    const session = randomUUID();
    const file = await writeRollout(multiToolTurn());
    await collect(file, session, payload(session, file), CFG, inMemory().make);
    const committed = await readOffset(session);

    const second = inMemory();
    await collect(file, session, payload(session, file), CFG, second.make);
    expect(second.exporter.getFinishedSpans()).toEqual([]);
    expect(await readOffset(session)).toBe(committed);
  });

  it('keeps session metadata when reading later turns past the cursor', async () => {
    const session = randomUUID();
    const first = withSession(simpleTurn(), session);
    const file = await writeRollout(first);
    await collect(
      file,
      session,
      {
        session_id: session,
        turn_id: 't1',
        transcript_path: file,
        last_assistant_message: 'hi there',
      },
      CFG,
      inMemory().make
    );
    const second = withSession(simpleTurn(), session)
      .slice(1)
      .map(line => line.replaceAll('"t1"', '"t2"'));
    await appendFile(file, `${second.join('\n')}\n`);
    const memory = inMemory();
    await collect(
      file,
      session,
      {
        session_id: session,
        turn_id: 't2',
        transcript_path: file,
        last_assistant_message: 'hi there',
      },
      CFG,
      memory.make
    );
    const root = memory.exporter
      .getFinishedSpans()
      .find(span => op(span) === 'invoke_agent')!;
    expect(root.attributes).toMatchObject({
      'gen_ai.agent.version': '0.50.0',
      'forge.integration.codex.cli_version': '0.50.0',
      'codex.cwd': '/tmp/proj',
    });
  });

  it('leaves the cursor untouched when shutdown reports export failure', async () => {
    const session = randomUUID();
    const file = await writeRollout(multiToolTurn());
    const failed = await collect(
      file,
      session,
      payload(session, file),
      CFG,
      inMemory(true).make
    );
    expect(failed.error).toBe('export boom');
    expect(await readOffset(session)).toBe(0);

    const retry = inMemory();
    await collect(file, session, payload(session, file), CFG, retry.make);
    expect(retry.exporter.getFinishedSpans().length).toBeGreaterThan(0);
    expect(await readOffset(session)).toBeGreaterThan(0);
  });

  it('retries when the first rollout read is empty', async () => {
    const session = randomUUID();
    const lines = withSession(simpleTurn(), session);
    const file = await writeRollout([]);
    const append = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        appendFile(file, `${lines.join('\n')}\n`).then(resolve, reject);
      }, 50);
    });
    const memory = inMemory();
    const result = await collect(
      file,
      session,
      {
        session_id: session,
        turn_id: 't1',
        transcript_path: file,
        last_assistant_message: 'hi there',
      },
      CFG,
      memory.make
    );
    await append;
    expect(result.exported).toBe(true);
    expect(result.turns).toEqual([{turnId: 't1', conversationId: session}]);
  });

  it('flushes between turns in a multi-turn batch', async () => {
    const session = randomUUID();
    const first = withSession(simpleTurn(), session);
    const second = withSession(simpleTurn(), session)
      .slice(1)
      .map(line => line.replaceAll('"t1"', '"t2"'));
    const file = await writeRollout([...first, ...second]);
    const memory = inMemory();
    const result = await collect(
      file,
      session,
      {session_id: session, transcript_path: file},
      CFG,
      memory.make
    );
    expect(result.turns.map(turn => turn.turnId)).toEqual(['t1', 't2']);
    expect(memory.forceFlushCount()).toBe(1);
  });
});

function withSession(lines: string[], id: string): string[] {
  return lines.map(line => line.replace(FIXTURE_SESSION_ID, id));
}

async function writeSessionsTree(
  sessions: Array<{id: string; lines: string[]}>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fc-sweep-'));
  const day = join(root, '2026', '06', '08');
  await mkdir(day, {recursive: true});
  for (const session of sessions) {
    await writeFile(
      join(day, `rollout-${session.id}.jsonl`),
      `${session.lines.join('\n')}\n`
    );
  }
  return root;
}

describe('collectAllSessions', () => {
  it('explicitly backfills every cursor-less rollout', async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const root = await writeSessionsTree([
      {id: idA, lines: withSession(multiToolTurn(), idA)},
      {id: idB, lines: withSession(simpleTurn(), idB)},
    ]);
    const memory = inMemory();

    const results = await collectAllSessions(CFG, {
      sessionsDir: root,
      makeTracing: memory.make,
    });

    const bySession = Object.fromEntries(results.map(r => [r.sessionId, r]));
    expect(bySession[idA]).toEqual({
      sessionId: idA,
      transcriptPath: expect.stringContaining(`rollout-${idA}.jsonl`),
      exported: true,
      turns: [{turnId: 't9', conversationId: idA}],
    });
    expect(bySession[idB]).toEqual({
      sessionId: idB,
      transcriptPath: expect.stringContaining(`rollout-${idB}.jsonl`),
      exported: true,
      turns: [{turnId: 't1', conversationId: idB}],
    });
    expect(
      memory.exporter.getFinishedSpans().filter(s => op(s) === 'invoke_agent')
    ).toHaveLength(2);
  });

  it('exports nothing on a second sweep', async () => {
    const id = randomUUID();
    const root = await writeSessionsTree([
      {id, lines: withSession(simpleTurn(), id)},
    ]);
    await collectAllSessions(CFG, {
      sessionsDir: root,
      makeTracing: inMemory().make,
    });

    const second = inMemory();
    const results = await collectAllSessions(CFG, {
      sessionsDir: root,
      makeTracing: second.make,
    });
    expect(results).toEqual([
      {
        sessionId: id,
        transcriptPath: expect.stringContaining(`rollout-${id}.jsonl`),
        exported: false,
        turns: [],
      },
    ]);
    expect(second.exporter.getFinishedSpans()).toEqual([]);
  });

  it('returns [] when there are no rollout files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fc-empty-'));
    expect(
      await collectAllSessions(CFG, {
        sessionsDir: root,
        makeTracing: inMemory().make,
      })
    ).toEqual([]);
  });
});
