// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import * as tracing from '@coreweave/forge-sdk/agentlens/tracing';
import {SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';
import {describe, expect, it} from 'vitest';

import type {ResolvedConfig} from './config.js';
import {runAndCollect, splitRunArgs} from './run.js';
import {FIXTURE_SESSION_ID, simpleTurn} from './test-support/fixtures.js';
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

function inMemory() {
  const exporter = new RetainingSpanExporter();
  return {
    exporter,
    make: (config: ResolvedConfig) => ({
      init: () =>
        tracing.init(config.projectId, {
          apiKey: config.apiKey,
          serviceName: 'forge-agent-lens-for-codex',
          spanProcessor: new SimpleSpanProcessor(exporter),
        }),
      forceFlush: tracing.forceFlush,
      shutdown: tracing.shutdown,
    }),
  };
}

async function emptySessionsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fc-run-'));
}

async function writeSession(root: string, sessionId: string): Promise<void> {
  const day = join(root, '2026', '06', '08');
  await mkdir(day, {recursive: true});
  const lines = simpleTurn().map(line =>
    line.replace(FIXTURE_SESSION_ID, sessionId)
  );
  await writeFile(
    join(day, `rollout-${sessionId}.jsonl`),
    `${lines.join('\n')}\n`
  );
}

const isRoot = (s: {attributes: Record<string, unknown>}) =>
  s.attributes['gen_ai.operation.name'] === 'invoke_agent';

describe('splitRunArgs', () => {
  it('splits flags from the --delimited command', () => {
    expect(splitRunArgs(['--', 'codex', 'exec', 'hi'])).toEqual({
      json: false,
      command: ['codex', 'exec', 'hi'],
    });
  });

  it('accepts --json before the --', () => {
    expect(splitRunArgs(['--json', '--', 'codex', 'exec'])).toEqual({
      json: true,
      command: ['codex', 'exec'],
    });
  });

  it('rejects missing commands and unknown flags', () => {
    expect(splitRunArgs(['codex', 'exec'])).toEqual({
      json: false,
      command: [],
      error: 'missing `--` before the command',
    });
    expect(splitRunArgs(['--json', '--'])).toEqual({
      json: true,
      command: [],
      error: 'no command after `--`',
    });
    expect(splitRunArgs(['--bogus', '--', 'x'])).toEqual({
      json: false,
      command: ['x'],
      error: 'unknown flag(s): --bogus',
    });
  });
});

describe('runAndCollect', () => {
  it('preserves the child exit code and exports sessions created by it', async () => {
    const id = randomUUID();
    const root = await emptySessionsDir();
    const memory = inMemory();

    const code = await runAndCollect(['codex', 'exec', 'hi'], {
      config: CFG,
      sessionsDir: root,
      makeTracing: memory.make,
      spawnChild: async () => {
        await writeSession(root, id);
        return 5;
      },
    });

    expect(code).toBe(5);
    expect(
      memory.exporter
        .getFinishedSpans()
        .filter(isRoot)
        .map(s => s.attributes['gen_ai.conversation.id'])
    ).toEqual([id]);
  });

  it('baselines pre-existing rollouts instead of sending old history', async () => {
    const id = randomUUID();
    const root = await emptySessionsDir();
    await writeSession(root, id);
    const memory = inMemory();
    const code = await runAndCollect(['true'], {
      config: CFG,
      sessionsDir: root,
      makeTracing: memory.make,
      spawnChild: async () => 0,
    });
    expect(code).toBe(0);
    expect(memory.exporter.getFinishedSpans()).toEqual([]);
  });

  it('still returns the child exit code when unconfigured', async () => {
    const root = await emptySessionsDir();
    const code = await runAndCollect(['false'], {
      config: {...CFG, apiKey: ''},
      sessionsDir: root,
      makeTracing: inMemory().make,
      spawnChild: async () => 3,
    });
    expect(code).toBe(3);
  });

  it('reports a spawn failure as exit 127', async () => {
    const code = await runAndCollect(['forge-agent-lens-for-codex-no-such-binary-xyz'], {
      config: {...CFG, apiKey: ''},
    });
    expect(code).toBe(127);
  });

  it('still runs the child when baselining fails', async () => {
    let spawned = false;
    const code = await runAndCollect(['command'], {
      config: CFG,
      baselineSessions: async () => {
        throw new Error('baseline boom');
      },
      spawnChild: async () => {
        spawned = true;
        return 6;
      },
    });
    expect(spawned).toBe(true);
    expect(code).toBe(6);
  });

  it('preserves the child exit code when collection throws', async () => {
    const code = await runAndCollect(['command'], {
      config: CFG,
      baselineSessions: async () => ({
        initialized: 0,
        skippedFiles: [],
        errors: [],
      }),
      collectSessions: async () => {
        throw new Error('collect boom');
      },
      spawnChild: async () => 7,
    });
    expect(code).toBe(7);
  });

  it('passes unsafe baseline files to the collection exclusion set', async () => {
    let excluded: string[] = [];
    const code = await runAndCollect(['command'], {
      config: CFG,
      baselineSessions: async () => ({
        initialized: 0,
        skippedFiles: ['/old-rollout.jsonl'],
        errors: [],
      }),
      collectSessions: async (_config, opts) => {
        excluded = [...(opts?.excludeFiles ?? [])];
        return [];
      },
      spawnChild: async () => 0,
    });
    expect(code).toBe(0);
    expect(excluded).toEqual(['/old-rollout.jsonl']);
  });

  it('maps a child signal to the conventional shell exit code', async () => {
    const root = await emptySessionsDir();
    const code = await runAndCollect(
      [process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"],
      {config: {...CFG, apiKey: ''}, sessionsDir: root}
    );
    expect(code).toBe(143);
  });
});
