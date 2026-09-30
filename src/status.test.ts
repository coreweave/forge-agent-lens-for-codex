// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

import {describe, expect, it} from 'vitest';

import type {ResolvedConfig} from './config.js';
import {CODEX_SESSIONS_DIR, LOG_FILE, VERSION} from './constants.js';
import {buildStatusReport} from './status.js';

const READY: ResolvedConfig = {
  apiKey: 'secret-key-value',
  projectId: 'ent/proj',
  entity: 'ent',
  project: 'proj',
  providerName: 'wandb-inference',
  includeContent: true,
  debug: false,
};

describe('buildStatusReport', () => {
  it('reports the full status shape for a ready config', () => {
    expect(buildStatusReport(READY, true, 3)).toEqual({
      version: VERSION,
      hookInstalled: true,
      project: 'ent/proj',
      apiKeyResolved: true,
      providerName: 'wandb-inference',
      includeContent: true,
      debug: false,
      logFile: LOG_FILE,
      sessionsDir: CODEX_SESSIONS_DIR,
      rolloutFileCount: 3,
      ready: true,
      error: null,
    });
  });

  it('never serializes the raw api key — only the apiKeyResolved boolean', () => {
    const json = JSON.stringify(buildStatusReport(READY, true, 0));
    expect(json).not.toContain('secret-key-value');
  });

  it('is not ready, with the exact error, when the project is missing', () => {
    const report = buildStatusReport(
      {...READY, projectId: '', entity: '', project: ''},
      false,
      0
    );
    expect(report).toMatchObject({
      project: null,
      apiKeyResolved: true,
      hookInstalled: false,
      ready: false,
      error: 'missing project (set FORGE_TRACE_PROJECT as "entity/project")',
    });
  });

  it('is not ready, with the exact error, when the api key is unresolved', () => {
    const report = buildStatusReport({...READY, apiKey: ''}, true, 1);
    expect(report).toMatchObject({
      apiKeyResolved: false,
      ready: false,
      error: 'missing API key (set WANDB_API_KEY or run `wandb login`)',
    });
  });
});
