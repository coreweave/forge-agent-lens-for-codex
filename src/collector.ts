#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

/**
 * The detached worker. Invoked by the Stop-hook shim as:
 *   node dist/collector.js <payload-json-file>
 *
 * Reads the just-finished turn from the rollout, reconstructs spans, ships them
 * to Forge Agent Lens, then exits. Fully off Codex's critical path; it never throws into
 * the calling process and never blocks Codex (the shim has already returned).
 */
import {readFile, unlink} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

import {configError, resolveConfig, type ResolvedConfig} from './config.js';
import {acquireLock} from './lock.js';
import {log, setVerbose} from './log.js';
import type {ReconstructedTurn} from './model.js';
import {
  offsetAfterLines,
  readNewLines,
  readOffset,
  writeOffset,
} from './rollout/cursor.js';
import {
  parseLineMaybe,
  reconstructTurns,
  type ReconstructResult,
} from './rollout/parser.js';
import {
  listRolloutFiles,
  readSessionId,
  readSessionMetadata,
} from './rollout/sessions.js';
import {emitTurn, type EmittedTurn} from './spans/emit.js';
import {buildTracing, type TracingHandle} from './spans/tracing.js';

// Rollout writer flushes per line, but the OS write can lag the Stop hook.
const ROLLOUT_READ_RETRY_ATTEMPTS = 5;
const ROLLOUT_READ_RETRY_DELAY_MS = 200;

/** The Codex Stop-hook payload (handed to the worker as JSON); only the fields we read. */
interface StopPayload {
  session_id: string;
  turn_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  model?: string;
  last_assistant_message?: string | null;
}

/** What one `collect()` call produced, returned so callers can report deep links. */
export interface CollectResult {
  sessionId: string;
  transcriptPath: string;
  /** True iff Forge SDK completed the export shutdown without error. */
  exported: boolean;
  /** Turns exported this call (empty on a no-op re-run or on export failure). */
  turns: EmittedTurn[];
  /** Present when this session failed instead of being a normal no-op. */
  error?: string;
}

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload.session_id;

  const config = await resolveConfig();
  setVerbose(config.debug);

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath) {
    log('warn', 'stop payload missing transcript_path; skipping', {sessionId});
    return;
  }
  const configErr = configError(config);
  if (configErr) {
    log('error', `not configured: ${configErr}`);
    return;
  }

  // Serialize per session so two workers never double-emit or rewind the cursor.
  const release = await acquireLock(sessionId);
  if (!release) {
    log(
      'info',
      'another worker holds this session; skipping (a later stop catches up)',
      {
        sessionId,
      }
    );
    return;
  }
  try {
    await collect(transcriptPath, sessionId, payload, config);
  } finally {
    await release();
  }
}

/**
 * Reconstruct + emit the just-finished turn(s). `makeTracing` is injected so a
 * test can drive the whole pipeline with an in-memory exporter (and assert the
 * cursor advances only on a successful export).
 */
export async function collect(
  transcriptPath: string,
  sessionId: string,
  payload: StopPayload,
  config: ResolvedConfig,
  makeTracing: (config: ResolvedConfig) => TracingHandle = buildTracing
): Promise<CollectResult> {
  const fromOffset = await readOffset(sessionId);
  const sessionMetadata = await readSessionMetadata(transcriptPath);
  let rawLines: string[] = [];
  let result: ReconstructResult = {
    turns: [],
    consumedLines: 0,
    abandonedTurns: 0,
  };

  // The Stop hook can fire just before Codex's background writer flushes the
  // turn's final lines to the rollout, so the turn may be missing or incomplete
  // on the first read. Re-read a few times until the turn is present and its
  // final text matches the Stop payload's last_assistant_message. This runs in
  // the detached worker, off Codex's critical path, so the wait is unnoticeable.
  const attempts =
    payload.turn_id || payload.last_assistant_message
      ? ROLLOUT_READ_RETRY_ATTEMPTS
      : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const read = await readNewLines(transcriptPath, fromOffset);
    rawLines = read.lines;
    result = reconstructTurns(rawLines.map(parseLineMaybe), {
      fallbackSessionId: sessionId,
      fallbackModel: payload.model,
      fallbackCwd: payload.cwd ?? sessionMetadata?.cwd,
      fallbackCliVersion: sessionMetadata?.cli_version,
    });
    if (targetReady(result.turns, payload)) break;
    if (attempt < attempts - 1) await sleep(ROLLOUT_READ_RETRY_DELAY_MS);
  }

  if (result.abandonedTurns > 0) {
    log(
      'warn',
      `dropped ${result.abandonedTurns} abandoned turn(s) with no task_complete`,
      {
        sessionId,
      }
    );
  }

  if (result.turns.length === 0) {
    log('warn', 'no complete turn yet; will catch it on the next stop', {
      sessionId,
    });
    return {sessionId, transcriptPath, exported: false, turns: []};
  }

  const tracing = makeTracing(config);
  const emitted: EmittedTurn[] = [];
  let exported = false;
  let exportError: string | undefined;
  try {
    await tracing.init();
    for (let i = 0; i < result.turns.length; i++) {
      const turn = result.turns[i]!;
      emitted.push(
        await emitTurn(
          turn,
          config.includeContent,
          config.providerName,
          tracing.forceFlush
        )
      );
      if (i < result.turns.length - 1) await tracing.forceFlush();
    }
    // shutdown() flushes then tears down; it rejects on a transport failure, so
    // reaching the next statement means the endpoint accepted the spans.
    await tracing.shutdown();
    exported = true;
  } catch (err) {
    exportError = errMessage(err);
    log('error', `emit/export failed: ${exportError}`);
    await tracing.shutdown().catch(() => {});
  }

  // leave the cursor untouched so the next stop retries the unexported turn(s)
  if (!exported) {
    return {
      sessionId,
      transcriptPath,
      exported: false,
      turns: [],
      error: exportError ?? 'trace export failed',
    };
  }

  const committed = offsetAfterLines(
    rawLines,
    result.consumedLines,
    fromOffset
  );
  await writeOffset(sessionId, committed);
  log('info', `emitted ${result.turns.length} turn(s)`, {
    sessionId,
    chats: result.turns.reduce((n, t) => n + t.chats.length, 0),
    tools: result.turns.reduce((n, t) => n + t.tools.length, 0),
  });
  return {sessionId, transcriptPath, exported: true, turns: emitted};
}

/**
 * Sweep every rollout session on disk and export any turns not yet seen — the
 * hook-independent path for headless `codex exec`/CI where the Stop hook may not
 * fire. Each session is processed through the same `collect()` as the live hook,
 * The per-session cursor skips successfully exported turns, and export is
 * synchronous (a flush before tearing down an ephemeral environment).
 *
 * `sessionsDir`/`makeTracing` are injectable so a test can drive a temp sessions
 * tree with an in-memory exporter.
 */
export async function collectAllSessions(
  config: ResolvedConfig,
  opts: {
    sessionsDir?: string;
    makeTracing?: (config: ResolvedConfig) => TracingHandle;
    excludeFiles?: ReadonlySet<string>;
  } = {}
): Promise<CollectResult[]> {
  const files = await listRolloutFiles(opts.sessionsDir);
  const results: CollectResult[] = [];
  for (const file of files) {
    if (opts.excludeFiles?.has(file)) continue;
    const sessionId = await readSessionId(file);
    if (!sessionId) {
      log('warn', 'rollout has no session_meta id; skipping', {file});
      continue;
    }
    // Serialize against any live Stop-hook worker for the same session.
    const release = await acquireLock(sessionId);
    if (!release) {
      log('info', 'session locked by another worker; skipping', {sessionId});
      continue;
    }
    try {
      results.push(
        await collect(
          file,
          sessionId,
          {session_id: sessionId, transcript_path: file},
          config,
          opts.makeTracing
        )
      );
    } catch (err) {
      const error = errMessage(err);
      log('error', `collect failed for ${file}: ${error}`);
      results.push({
        sessionId,
        transcriptPath: file,
        exported: false,
        turns: [],
        error,
      });
    } finally {
      await release();
    }
  }
  return results;
}

/** True once the just-finished turn is present and looks fully flushed. */
function targetReady(
  turns: ReconstructedTurn[],
  payload: StopPayload
): boolean {
  if (turns.length === 0) return false;
  // With a turn_id, wait for that exact turn; without one, wait for the latest.
  const target = payload.turn_id
    ? turns.find(t => t.turnId === payload.turn_id)
    : turns[turns.length - 1];
  if (!target) return false;
  if (!payload.last_assistant_message) return true;
  const got = (target.finalAssistantMessage ?? '').trimEnd();
  return (
    got.length > 0 && got.endsWith(payload.last_assistant_message.trimEnd())
  );
}

async function readPayload(): Promise<StopPayload> {
  const file = process.argv[2];
  if (!file) return JSON.parse(await readStdin()) as StopPayload;
  const raw = await readFile(file, 'utf8');
  await unlink(file).catch(() => {}); // the shim's temp file; clean up best-effort
  return JSON.parse(raw) as StopPayload;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Run as the detached worker only when invoked directly (`node collector.js`),
// not when imported — the CLI imports collect()/collectAllSessions() from here.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch(err => log('error', `unhandled: ${errMessage(err)}`));
}
