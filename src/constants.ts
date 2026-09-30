// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

/**
 * Cross-cutting constants shared across modules: filesystem paths, environment
 * variable names and the package version. Constants used by only one module
 * live at the top of that module instead.
 */
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

// --- Our own state lives under ~/.forge-codex (override for tests via env) ---
export const FORGE_CODEX_HOME =
  process.env.FORGE_CODEX_HOME ?? join(homedir(), '.forge-codex');
export const SETTINGS_FILE = join(FORGE_CODEX_HOME, 'settings.json');
export const LOG_FILE = join(FORGE_CODEX_HOME, 'logs', 'collector.log');

// --- Codex layout we read (rollouts) and modify (hooks.json) ---
export const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex');
export const CODEX_HOOKS_FILE = join(CODEX_HOME, 'hooks.json');
// Codex appends each session to sessions/YYYY/MM/DD/rollout-*.jsonl; this is the
// source the collector reconstructs from. `codex --ephemeral` suppresses it.
export const CODEX_SESSIONS_DIR = join(CODEX_HOME, 'sessions');

export const DEFAULT_PROVIDER_NAME = 'openai';

// --- Environment variable names (referenced, never inlined as literals) ---
export const ENV = {
  WANDB_API_KEY: 'WANDB_API_KEY',
  WANDB_BASE_URL: 'WANDB_BASE_URL',
  FORGE_TRACE_PROJECT: 'FORGE_TRACE_PROJECT',
  /** Provider stamped on emitted model spans; set for a proxy/bridge upstream (default `openai`). */
  PROVIDER_NAME: 'FORGE_CODEX_PROVIDER_NAME',
  /** Set to "0"/"false" to drop all prompt/code/output content from spans. */
  INCLUDE_CONTENT: 'FORGE_CODEX_INCLUDE_CONTENT',
  DEBUG: 'FORGE_CODEX_DEBUG',
} as const;

// --- Version, read from package.json so it can never drift from a hardcoded copy ---
// We ship package.json with the package, so an unreadable file or a missing
// version is a packaging bug — let it throw loudly rather than mask it as 0.0.0.
function readVersion(): string {
  const {version} = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as {version?: string};
  if (!version)
    throw new Error('forge-codex: package.json is missing a "version" field');
  return version;
}
export const VERSION = readVersion();
