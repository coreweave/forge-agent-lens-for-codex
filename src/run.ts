// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

/**
 * `forge-codex run -- <command...>`: run a command (e.g. `codex exec ...`) to
 * completion, then sweep rollouts and export — the automatic flush for headless
 * `codex exec`/CI, where Codex's Stop hook may not fire and there is no upstream
 * session-exit hook to trigger us. Idempotent via the per-session cursor, so it
 * composes with the live Stop hook when that does fire.
 */
import {spawn} from 'node:child_process';
import {constants as osConstants} from 'node:os';

import {collectAllSessions, type CollectResult} from './collector.js';
import {configError, type ResolvedConfig} from './config.js';
import {baselineExistingSessions} from './rollout/baseline.js';
import type {BaselineResult} from './rollout/baseline.js';
import type {TracingHandle} from './spans/tracing.js';

/** Exit code reported when the wrapped command can't be started at all. */
const SPAWN_FAILURE_EXIT = 127;

export interface RunArgs {
  json: boolean;
  command: string[];
  error?: string;
}

/** Split `run`'s argv (everything after `run`) into flags + the `--`-delimited command. */
export function splitRunArgs(argv: string[]): RunArgs {
  const sep = argv.indexOf('--');
  if (sep === -1) {
    return {json: false, command: [], error: 'missing `--` before the command'};
  }
  const flags = argv.slice(0, sep);
  const command = argv.slice(sep + 1);
  const json = flags.includes('--json');
  const unknown = flags.filter(f => f !== '--json');
  if (unknown.length > 0) {
    return {json, command, error: `unknown flag(s): ${unknown.join(', ')}`};
  }
  if (command.length === 0) {
    return {json, command, error: 'no command after `--`'};
  }
  return {json, command};
}

/**
 * Run `command` (stdio inherited, so it behaves exactly as if invoked directly),
 * then export any new turns. Returns the command's exit code; a tracing failure
 * never changes it (observability must not fail the user's run). The export
 * report goes to stderr so the command's stdout stays clean (e.g. for
 * `codex exec --json`). `sessionsDir`/`makeTracing`/`spawnChild` are injectable
 * for tests.
 */
export async function runAndCollect(
  command: string[],
  opts: {
    config: ResolvedConfig;
    json?: boolean;
    sessionsDir?: string;
    makeTracing?: (config: ResolvedConfig) => TracingHandle;
    spawnChild?: (command: string[]) => Promise<number>;
    baselineSessions?: (sessionsDir?: string) => Promise<BaselineResult>;
    collectSessions?: typeof collectAllSessions;
  }
): Promise<number> {
  let baseline: BaselineResult | undefined;
  try {
    baseline = await (opts.baselineSessions ?? baselineExistingSessions)(
      opts.sessionsDir
    );
    for (const failure of baseline.errors) {
      process.stderr.write(
        `forge-codex run: could not baseline ${failure.file}: ${failure.message}\n`
      );
    }
  } catch (err) {
    process.stderr.write(
      `forge-codex run: baseline failed; tracing flush disabled (${message(err)})\n`
    );
  }
  const spawnChild = opts.spawnChild ?? defaultSpawn;
  const code = await spawnChild(command);

  const err = configError(opts.config);
  if (err) {
    process.stderr.write(
      `forge-codex run: skipping flush — not configured (${err})\n`
    );
    return code;
  }
  if (!baseline) return code;

  let results: CollectResult[];
  try {
    results = await (opts.collectSessions ?? collectAllSessions)(opts.config, {
      sessionsDir: opts.sessionsDir,
      makeTracing: opts.makeTracing,
      excludeFiles: new Set(baseline.skippedFiles),
    });
  } catch (err) {
    process.stderr.write(
      `forge-codex run: tracing flush failed (${message(err)})\n`
    );
    return code;
  }
  process.stderr.write(
    `${formatReport(results, opts.config, opts.json ?? false)}\n`
  );
  return code;
}

function defaultSpawn(command: string[]): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command[0]!, command.slice(1), {stdio: 'inherit'});
    child.on('error', err => {
      process.stderr.write(
        `forge-codex run: could not start ${command[0]}: ${err.message}\n`
      );
      resolve(SPAWN_FAILURE_EXIT);
    });
    child.on('exit', (code, signal) => {
      const signalNumber = signal ? osConstants.signals[signal] : undefined;
      resolve(code ?? (signalNumber ? 128 + signalNumber : 1));
    });
  });
}

function formatReport(
  results: CollectResult[],
  config: ResolvedConfig,
  json: boolean
): string {
  if (json) {
    return JSON.stringify({
      ok: results.every(result => !result.error),
      project: config.projectId,
      sessions: results,
    });
  }
  const newTurns = results.reduce((n, r) => n + r.turns.length, 0);
  const failures = results.filter(result => result.error).length;
  return `forge-codex: exported ${newTurns} new turn(s) across ${results.length} session(s)${failures ? `; ${failures} failed` : ''}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
