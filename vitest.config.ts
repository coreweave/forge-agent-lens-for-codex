// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {defineConfig} from 'vitest/config';

// Tests point at throwaway temp dirs so install/cursor tests never touch the
// real ~/.codex or ~/.forge-codex. constants.ts reads these at load.
const TEST_ROOT = join(tmpdir(), 'forge-codex-tests');

export default defineConfig({
  plugins: [
    {
      // Resolve NodeNext-style relative `.js` imports to their `.ts` source so
      // tests run against src/ directly — no stale-dist drift, no dist import.
      name: 'resolve-ts-from-js',
      enforce: 'pre',
      async resolveId(source, importer) {
        if (importer && source.startsWith('.') && source.endsWith('.js')) {
          const resolved = await this.resolve(
            `${source.slice(0, -3)}.ts`,
            importer,
            {
              skipSelf: true,
            }
          );
          if (resolved) return resolved;
        }
        return null;
      },
    },
  ],
  test: {
    env: {
      FORGE_CODEX_HOME: join(TEST_ROOT, 'home'),
      CODEX_HOME: join(TEST_ROOT, 'codex'),
    },
  },
});
