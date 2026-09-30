#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

/**
 * `forge-codex` CLI: install | uninstall | status.
 *
 * install wires a Stop-hook into ~/.codex/hooks.json that triggers the detached
 * collector. Credentials come from env / `wandb login` (netrc);
 * we never prompt for the secret (only the non-secret project).
 */
import {createInterface} from 'node:readline/promises';
import {execPath, stdin, stdout} from 'node:process';
import {fileURLToPath} from 'node:url';

import {collectAllSessions} from './collector.js';
import {parseCollectArgs} from './cliArgs.js';
import {
  configError,
  readSettings,
  resolveConfig,
  writeSettings,
  type Settings,
} from './config.js';
import {
  CODEX_HOOKS_FILE,
  CODEX_SESSIONS_DIR,
  ENV,
  LOG_FILE,
  SETTINGS_FILE,
  VERSION,
} from './constants.js';
import {
  hooksInstalled,
  mergeHooks,
  removeHooks,
  validateHooksFile,
  writeShim,
} from './install.js';
import {setVerbose} from './log.js';
import {baselineExistingSessions} from './rollout/baseline.js';
import {listRolloutFiles} from './rollout/sessions.js';
import {runAndCollect, splitRunArgs} from './run.js';
import {buildStatusReport} from './status.js';

// Absolute path to the compiled worker next to cli.js in dist/; baked into the
// hook shim at install so the Stop hook can run it regardless of cwd.
const COLLECTOR_JS = fileURLToPath(new URL('./collector.js', import.meta.url));

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  switch (command) {
    case 'install':
      await install();
      break;
    case 'uninstall':
      await uninstall();
      break;
    case 'status':
      await status();
      break;
    case 'collect':
      await collectCommand();
      break;
    case 'run':
      await runCommand();
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

async function install(): Promise<void> {
  try {
    await validateHooksFile();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const settings = await readSettings();

  const project = await resolveProjectInput(settings);
  if (project) settings.project = project;
  if (settings.include_content === undefined) settings.include_content = true;
  if (settings.debug === undefined) settings.debug = false;
  settings.version = VERSION;
  settings.installed_at = new Date().toISOString();
  await writeSettings(settings);

  const baseline = await baselineExistingSessions();
  if (baseline.skippedFiles.length > 0) {
    console.error(
      `forge-codex install: could not safely baseline ${baseline.skippedFiles.length} existing session(s); hook installation stopped`
    );
    for (const failure of baseline.errors) {
      console.error(`  ${failure.file}: ${failure.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const shim = await writeShim(execPath, COLLECTOR_JS);

  const merged = await mergeHooksOrReport();
  if (!merged) {
    process.exitCode = 1;
    return;
  }

  const config = await resolveConfig();
  const err = configError(config);

  console.log(`forge-codex ${VERSION} installed`);
  console.log(`  shim:     ${shim}`);
  console.log(`  hooks:    ${CODEX_HOOKS_FILE}`);
  console.log(
    `            added: ${formatList(merged.added)} · already present: ${formatList(merged.alreadyPresent)}`
  );
  console.log(`  settings: ${SETTINGS_FILE}`);
  console.log(`  baseline: ${baseline.initialized} existing session(s)`);
  console.log(`  project:  ${config.projectId || '(unset)'}`);
  console.log(`  api key:  ${config.apiKey ? 'resolved' : '(unset)'}`);
  if (err) {
    console.log(`\n  ⚠ ${err}`);
    console.log(
      `    Set ${ENV.WANDB_API_KEY} / run \`wandb login\`, and set ${ENV.FORGE_TRACE_PROJECT}.`
    );
  }
  console.log(
    `\n  Review and enable the hook from \`/hooks\` in Codex.` +
      `\n  For a one-off automation run, Codex supports \`--dangerously-bypass-hook-trust\`.`
  );
}

async function uninstall(): Promise<void> {
  const removed = await removeHooks();
  console.log(`forge-codex uninstalled`);
  console.log(`  removed hooks: ${formatList(removed)}`);
  console.log(
    `  settings left intact at ${SETTINGS_FILE} (delete manually to fully remove)`
  );
}

async function status(): Promise<void> {
  const config = await resolveConfig();
  const err = configError(config);
  const installed = await hooksInstalled();
  const rolloutCount = (await listRolloutFiles()).length;

  if (process.argv.includes('--json')) {
    const report = buildStatusReport(config, installed, rolloutCount);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`forge-codex ${VERSION}`);
  console.log(
    `  hook installed:  ${installed ? 'yes' : 'no'}  (${CODEX_HOOKS_FILE})`
  );
  console.log(`  project:         ${config.projectId || '(unset)'}`);
  console.log(`  api key:         ${config.apiKey ? 'resolved' : '(unset)'}`);
  console.log(`  provider:        ${config.providerName}`);
  console.log(`  include content: ${config.includeContent}`);
  console.log(`  debug:           ${config.debug}`);
  console.log(`  log file:        ${LOG_FILE}`);
  console.log(
    `  sessions:        ${CODEX_SESSIONS_DIR} (${rolloutCount} rollout file(s))`
  );
  console.log(`  status:          ${err ? `not ready — ${err}` : 'ready'}`);
  if (rolloutCount === 0) {
    console.log(
      `\n  ⚠ no rollout files found yet — they appear after you run Codex.` +
        `\n    Note: \`codex --ephemeral\` disables rollout logging, which suppresses traces.`
    );
  }
}

// Sweep every rollout session and export turns not yet seen. The hook-independent
// path for headless `codex exec`/CI; --json emits per-session export results.
async function collectCommand(): Promise<void> {
  const {json, error} = parseCollectArgs(process.argv.slice(3));
  if (error) {
    console.error(`forge-codex collect: ${error}\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const config = await resolveConfig();
  setVerbose(config.debug); // logs go to the log file / stderr, never stdout
  const err = configError(config);
  if (err) {
    if (json) console.log(JSON.stringify({ok: false, error: err}, null, 2));
    else console.error(`forge-codex collect: not configured — ${err}`);
    process.exitCode = 1;
    return;
  }

  const results = await collectAllSessions(config);
  const newTurns = results.reduce((n, r) => n + r.turns.length, 0);
  const failures = results.filter(result => result.error);

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: failures.length === 0,
          project: config.projectId,
          sessions: results,
        },
        null,
        2
      )
    );
    if (failures.length > 0) process.exitCode = 1;
    return;
  }

  console.log(
    `forge-codex collect — swept ${results.length} session(s), exported ${newTurns} new turn(s)`
  );
  for (const r of results) {
    console.log(
      `  ${r.sessionId}  ${r.turns.length} new turn(s)  ${r.error ? `failed: ${r.error}` : r.exported ? 'exported' : 'no-op'}`
    );
  }
  if (failures.length > 0) process.exitCode = 1;
}

// Run a wrapped command (e.g. `codex exec …`) then flush automatically on exit.
// The hook-free, zero-extra-step path for headless `codex exec`/CI.
async function runCommand(): Promise<void> {
  const {json, command, error} = splitRunArgs(process.argv.slice(3));
  if (error) {
    console.error(`forge-codex run: ${error}\n`);
    console.error('usage: forge-codex run [--json] -- <command> [args...]');
    console.error(
      '  e.g. forge-codex run -- codex exec "fix the failing test"'
    );
    process.exitCode = 1;
    return;
  }
  const config = await resolveConfig();
  setVerbose(config.debug); // logs go to the log file / stderr, never the child's stdout
  // Exit with the wrapped command's own code so `run` is a transparent prefix.
  process.exitCode = await runAndCollect(command, {config, json});
}

function printHelp(): void {
  console.log(`forge-codex ${VERSION} — CoreWeave Forge observability for OpenAI Codex CLI

Usage:
  forge-codex install         Wire the Stop hook into ~/.codex/hooks.json
  forge-codex uninstall       Remove the forge-codex hook entries
  forge-codex status [--json] Show resolved config and hook state
  forge-codex collect --all [--json]
                              Reconstruct + export all rollout sessions (hook-free;
                              for headless codex exec / CI). A cursor-less rollout
                              starts at offset 0 and can send pre-install history.
  forge-codex run [--json] -- <cmd...>
                              Run <cmd> (e.g. codex exec …), then auto-export on exit

Config (adapter options: env > settings.json > default; API key: env > netrc):
  ${ENV.WANDB_API_KEY}        W&B API key (or run \`wandb login\`)
  ${ENV.FORGE_TRACE_PROJECT}  Agent Lens project as "entity/project"
  ${ENV.WANDB_BASE_URL}       W&B base URL (Forge SDK resolves trace transport)
  ${ENV.PROVIDER_NAME}  Override the reported model provider
  ${ENV.INCLUDE_CONTENT}  Set to false to drop prompts/code/output from spans`);
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.join(', ') : 'none';
}

async function prompt(question: string): Promise<string> {
  const readline = createInterface({input: stdin, output: stdout});
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}

async function resolveProjectInput(
  settings: Settings
): Promise<string | undefined> {
  const configured = process.env[ENV.FORGE_TRACE_PROJECT] ?? settings.project;
  if (configured) return configured;
  // Prompt only for the non-secret project, and only when attended.
  if (stdin.isTTY)
    return (await prompt('Agent Lens project (entity/project): ')).trim();
  return undefined;
}

// Merge our Stop hook, or report the failure (e.g. a corrupt hooks.json) and
// return null so the caller aborts without overwriting anything.
async function mergeHooksOrReport() {
  try {
    return await mergeHooks();
  } catch (err) {
    console.error(
      `\n  ⚠ could not update ${CODEX_HOOKS_FILE}; the hook was not changed:`
    );
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

void main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
