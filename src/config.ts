// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

/**
 * Resolve runtime config for the worker and CLI.
 *
 * Project and adapter options use environment > settings > default. The API
 * key comes from WANDB_API_KEY or the matching ~/.netrc machine and is passed
 * to Forge SDK without being persisted by this package.
 */
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {DEFAULT_PROVIDER_NAME, ENV, SETTINGS_FILE} from './constants.js';

const DEFAULT_WANDB_BASE_URL = 'https://api.wandb.ai';
/** Default when neither env nor settings specify it. */
const DEFAULT_CAPTURE_CONTENT = true;

export interface Settings {
  project?: string;
  include_content?: boolean;
  debug?: boolean;
  provider_name?: string;
  version?: string;
  installed_at?: string;
}

export interface ResolvedConfig {
  apiKey: string;
  /** `entity/project` — the value of the project_id ingest header. */
  projectId: string;
  entity: string;
  project: string;
  includeContent: boolean;
  debug: boolean;
  /** Provider recorded on emitted model spans. */
  providerName: string;
}

export async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')) as Settings;
  } catch {
    return {};
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  const safeSettings: Settings = {
    ...(settings.project !== undefined ? {project: settings.project} : {}),
    ...(settings.include_content !== undefined
      ? {include_content: settings.include_content}
      : {}),
    ...(settings.debug !== undefined ? {debug: settings.debug} : {}),
    ...(settings.provider_name !== undefined
      ? {provider_name: settings.provider_name}
      : {}),
    ...(settings.version !== undefined ? {version: settings.version} : {}),
    ...(settings.installed_at !== undefined
      ? {installed_at: settings.installed_at}
      : {}),
  };
  const dir = join(SETTINGS_FILE, '..');
  const temporary = join(dir, `.settings.${process.pid}.${randomUUID()}.tmp`);
  await fs.mkdir(dir, {recursive: true});
  try {
    await fs.writeFile(temporary, JSON.stringify(safeSettings, null, 2), {
      mode: 0o600,
    });
    await fs.rename(temporary, SETTINGS_FILE);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function resolveConfig(
  preloaded?: Settings
): Promise<ResolvedConfig> {
  const settings = preloaded ?? (await readSettings());

  const apiKey =
    process.env[ENV.WANDB_API_KEY] ??
    (await apiKeyFromNetrc(netrcMachine())) ??
    '';

  const projectId =
    process.env[ENV.FORGE_TRACE_PROJECT] ?? settings.project ?? '';
  const {entity, project} = splitProject(projectId);

  const includeContent =
    parseBool(process.env[ENV.INCLUDE_CONTENT]) ??
    settings.include_content ??
    DEFAULT_CAPTURE_CONTENT;
  const debug = parseBool(process.env[ENV.DEBUG]) ?? settings.debug ?? false;
  const providerName =
    nonEmptyString(process.env[ENV.PROVIDER_NAME]) ??
    nonEmptyString(settings.provider_name) ??
    DEFAULT_PROVIDER_NAME;

  return {
    apiKey,
    projectId,
    entity,
    project,
    includeContent,
    debug,
    providerName,
  };
}

export function configError(config: ResolvedConfig): string | undefined {
  if (!config.apiKey)
    return `missing API key (set ${ENV.WANDB_API_KEY} or run \`wandb login\`)`;
  if (!config.projectId)
    return `missing project (set ${ENV.FORGE_TRACE_PROJECT} as "entity/project")`;
  if (
    !config.entity ||
    !config.project ||
    config.projectId.indexOf('/') !== config.projectId.lastIndexOf('/')
  ) {
    return `project "${config.projectId}" must be in "entity/project" form (exactly one "/")`;
  }
  return undefined;
}

function splitProject(value: string): {entity: string; project: string} {
  const slash = value.indexOf('/');
  if (slash === -1) return {entity: '', project: value};
  return {entity: value.slice(0, slash), project: value.slice(slash + 1)};
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'no')
    return false;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes')
    return true;
  return undefined;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function netrcMachine(): string {
  const baseUrl = process.env[ENV.WANDB_BASE_URL] ?? DEFAULT_WANDB_BASE_URL;
  return netrcMachineForBaseUrl(baseUrl);
}

export function netrcMachineForBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'api.wandb.ai';
  }
}

async function apiKeyFromNetrc(machine: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(join(homedir(), '.netrc'), 'utf8');
    return apiKeyFromNetrcText(raw, machine);
  } catch {
    // no netrc / unreadable → fall through
  }
  return undefined;
}

export function apiKeyFromNetrcText(
  raw: string,
  machine: string
): string | undefined {
  const tokens = raw.replace(/#.*$/gm, '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'machine' && tokens[i + 1] === machine) {
      for (let j = i + 2; j < tokens.length; j++) {
        if (tokens[j] === 'machine' || tokens[j] === 'default') break;
        if (tokens[j] === 'password' && j + 1 < tokens.length) {
          return tokens[j + 1];
        }
      }
    }
  }
  return undefined;
}
