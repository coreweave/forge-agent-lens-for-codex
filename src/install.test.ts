// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {beforeEach, describe, expect, it} from 'vitest';

import {CODEX_HOOKS_FILE} from './constants.js';
import {
  hookCommand,
  hooksInstalled,
  mergeHooks,
  removeHooks,
  validateHooksFile,
} from './install.js';

interface HookGroup {
  hooks: Array<{type: string; command: string}>;
}
interface Hooks {
  hooks?: Record<string, HookGroup[]>;
}

async function readHooks(): Promise<Hooks> {
  return JSON.parse(await readFile(CODEX_HOOKS_FILE, 'utf8')) as Hooks;
}
function commandsFor(hooks: Hooks, event: string): string[] {
  return (hooks.hooks?.[event] ?? []).flatMap(g => g.hooks.map(h => h.command));
}

beforeEach(async () => {
  await mkdir(dirname(CODEX_HOOKS_FILE), {recursive: true});
  await rm(CODEX_HOOKS_FILE, {force: true});
  await rm(`${CODEX_HOOKS_FILE}.bak`, {force: true});
});

describe('mergeHooks', () => {
  it('adds a Stop hook and is idempotent (no duplicate)', async () => {
    const first = await mergeHooks();
    expect(first.added).toEqual(['Stop']);
    expect(commandsFor(await readHooks(), 'Stop')).toEqual([hookCommand()]);
    expect(await hooksInstalled()).toBe(true);

    const second = await mergeHooks();
    expect(second.added).toEqual([]);
    expect(second.alreadyPresent).toEqual(['Stop']);
    expect(commandsFor(await readHooks(), 'Stop')).toEqual([hookCommand()]);
  });

  it('preserves a pre-existing unrelated Stop hook', async () => {
    await writeFile(
      CODEX_HOOKS_FILE,
      JSON.stringify({
        hooks: {Stop: [{hooks: [{type: 'command', command: 'echo hi'}]}]},
      })
    );
    await mergeHooks();
    expect(commandsFor(await readHooks(), 'Stop')).toContain('echo hi');
    expect(commandsFor(await readHooks(), 'Stop')).toContain(hookCommand());
  });

  it('refuses to overwrite a corrupt hooks.json', async () => {
    await writeFile(CODEX_HOOKS_FILE, '{ not json');
    await expect(mergeHooks()).rejects.toThrow(/not valid JSON/);
    await expect(validateHooksFile()).rejects.toThrow(/not valid JSON/);
    expect(await readFile(CODEX_HOOKS_FILE, 'utf8')).toBe('{ not json');
  });
});

describe('removeHooks', () => {
  it('removes only our hook, preserving a co-located one', async () => {
    await writeFile(
      CODEX_HOOKS_FILE,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {type: 'command', command: hookCommand()},
                {type: 'command', command: 'user-tool'},
              ],
            },
          ],
        },
      })
    );
    expect(await removeHooks()).toEqual(['Stop']);
    expect(commandsFor(await readHooks(), 'Stop')).toEqual(['user-tool']);
  });

  it('drops the event entirely when only our hook remained', async () => {
    await mergeHooks();
    await removeHooks();
    expect((await readHooks()).hooks?.Stop).toBeUndefined();
  });
});

describe('backup', () => {
  it('never clobbers an existing .bak on re-install', async () => {
    await writeFile(
      CODEX_HOOKS_FILE,
      JSON.stringify({hooks: {}, pristine: true})
    );
    await mergeHooks();
    const firstBak = await readFile(`${CODEX_HOOKS_FILE}.bak`, 'utf8');
    expect(JSON.parse(firstBak).pristine).toBe(true);

    await removeHooks();
    await mergeHooks();
    expect(await readFile(`${CODEX_HOOKS_FILE}.bak`, 'utf8')).toBe(firstBak);
  });
});
