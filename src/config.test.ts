// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

import {readFile, rm} from 'node:fs/promises';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  apiKeyFromNetrcText,
  configError,
  netrcMachineForBaseUrl,
  resolveConfig,
  writeSettings,
  type ResolvedConfig,
  type Settings,
} from './config.js';
import {SETTINGS_FILE} from './constants.js';

function cfg(overrides: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    apiKey: 'key',
    projectId: 'ent/proj',
    entity: 'ent',
    project: 'proj',
    providerName: 'openai',
    includeContent: true,
    debug: false,
    ...overrides,
  };
}

describe('configError', () => {
  it('accepts a well-formed config', () => {
    expect(configError(cfg({}))).toBeUndefined();
  });

  it('flags a missing API key', () => {
    expect(configError(cfg({apiKey: ''}))).toMatch(/API key/);
  });

  it('flags a missing project', () => {
    expect(configError(cfg({projectId: '', entity: '', project: ''}))).toMatch(
      /project/
    );
  });

  it('flags a project with more than one slash', () => {
    expect(
      configError(cfg({projectId: 'a/b/c', entity: 'a', project: 'b/c'}))
    ).toMatch(/exactly one/);
  });
});

describe('resolveConfig precedence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets env override settings for the project', async () => {
    vi.stubEnv('FORGE_TRACE_PROJECT', 'envent/envproj');
    const resolved = await resolveConfig({project: 'setent/setproj'});
    expect(resolved).toMatchObject({
      projectId: 'envent/envproj',
      entity: 'envent',
      project: 'envproj',
    });
  });

  it('falls back to settings when the env var is unset', async () => {
    vi.stubEnv('FORGE_TRACE_PROJECT', undefined);
    const resolved = await resolveConfig({project: 'setent/setproj'});
    expect(resolved.projectId).toBe('setent/setproj');
  });

  it('parses the include-content flag, env winning over settings', async () => {
    vi.stubEnv('FORGE_CODEX_INCLUDE_CONTENT', '0');
    expect((await resolveConfig({include_content: true})).includeContent).toBe(
      false
    );
    vi.stubEnv('FORGE_CODEX_INCLUDE_CONTENT', 'true');
    expect((await resolveConfig({include_content: false})).includeContent).toBe(
      true
    );
  });

  it('uses a non-empty provider override from env before settings', async () => {
    vi.stubEnv('FORGE_CODEX_PROVIDER_NAME', ' wandb-inference ');
    expect((await resolveConfig({provider_name: 'litellm'})).providerName).toBe(
      'wandb-inference'
    );

    vi.stubEnv('FORGE_CODEX_PROVIDER_NAME', '');
    expect((await resolveConfig({provider_name: 'litellm'})).providerName).toBe(
      'litellm'
    );

    expect((await resolveConfig({})).providerName).toBe('openai');
  });
});

describe('netrc resolution', () => {
  it('uses the WANDB_BASE_URL host for custom deployments', () => {
    const machine = netrcMachineForBaseUrl('https://wandb.example.test/path');
    expect(machine).toBe('wandb.example.test');
    expect(
      apiKeyFromNetrcText(
        'machine api.wandb.ai password cloud\n' +
          'machine wandb.example.test login user password custom\n',
        machine
      )
    ).toBe('custom');
  });

  it('preserves the port for custom deployment credentials', () => {
    expect(netrcMachineForBaseUrl('https://wandb.example.test:8080/path')).toBe(
      'wandb.example.test:8080'
    );
  });
});

describe('settings persistence', () => {
  it('writes only supported non-secret fields', async () => {
    await rm(SETTINGS_FILE, {force: true});
    await writeSettings({
      project: 'ent/proj',
      include_content: false,
      wandb_api_key: 'must-not-persist',
    } as Settings & {wandb_api_key: string});

    const stored = JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(stored).toEqual({project: 'ent/proj', include_content: false});
    expect(await readFile(SETTINGS_FILE, 'utf8')).not.toContain(
      'must-not-persist'
    );
  });
});
