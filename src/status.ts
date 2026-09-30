// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

/**
 * The machine-readable `forge-agent-lens-for-codex status` report.
 *
 * Kept separate from the CLI's argv/console plumbing so its shape can be
 * unit-tested without invoking the entry point, and so the `--json` output and
 * the human-readable output render from one source of truth. The API key is
 * reported only as a boolean — the secret itself never enters the report.
 */
import {configError, type ResolvedConfig} from './config.js';
import {CODEX_SESSIONS_DIR, LOG_FILE, VERSION} from './constants.js';

export interface StatusReport {
  version: string;
  hookInstalled: boolean;
  project: string | null;
  apiKeyResolved: boolean;
  providerName: string;
  includeContent: boolean;
  debug: boolean;
  logFile: string;
  sessionsDir: string;
  rolloutFileCount: number;
  ready: boolean;
  error: string | null;
}

export function buildStatusReport(
  config: ResolvedConfig,
  hookInstalled: boolean,
  rolloutFileCount: number
): StatusReport {
  const error = configError(config) ?? null;
  return {
    version: VERSION,
    hookInstalled,
    project: config.projectId || null,
    apiKeyResolved: Boolean(config.apiKey), // never the secret itself
    providerName: config.providerName,
    includeContent: config.includeContent,
    debug: config.debug,
    logFile: LOG_FILE,
    sessionsDir: CODEX_SESSIONS_DIR,
    rolloutFileCount,
    ready: error === null,
    error,
  };
}
