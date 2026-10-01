// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

/**
 * Minimal append-only JSONL logger for the worker. Errors here must never
 * surface to Codex, so every write is best-effort. Mirrors to stderr only when
 * FORGE_CODEX_DEBUG is set (the detached worker's stderr goes to the log file).
 */
import {appendFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

import {LOG_FILE} from './constants.js';

type Level = 'info' | 'warn' | 'error';

/**
 * Errors always log (they're the actionable failures). info/warn are opt-in via
 * the `debug` user setting, so the log stays quiet by default — the worker should
 * be invisible unless something is wrong. The worker calls setVerbose() once it
 * has resolved config.
 */
let verbose = false;
export function setVerbose(enabled: boolean): void {
  verbose = enabled;
}

let dirReady = false;

export function log(
  level: Level,
  message: string,
  extra?: Record<string, unknown>
): void {
  if (level !== 'error' && !verbose) return;
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...extra,
  });
  try {
    if (!dirReady) {
      mkdirSync(dirname(LOG_FILE), {recursive: true});
      dirReady = true;
    }
    appendFileSync(LOG_FILE, `${entry}\n`);
  } catch {
    // Logging is best-effort; never throw.
  }
  if (verbose) process.stderr.write(`${entry}\n`);
}
