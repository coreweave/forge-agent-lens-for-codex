// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

export interface CollectArgs {
  json: boolean;
  error?: string;
}

export function parseCollectArgs(flags: string[]): CollectArgs {
  const json = flags.includes('--json');
  const unknown = flags.filter(flag => flag !== '--json' && flag !== '--all');
  if (unknown.length > 0) {
    return {json, error: `unknown flag(s): ${unknown.join(', ')}`};
  }
  if (!flags.includes('--all')) {
    return {json, error: '`--all` is required to confirm history backfill'};
  }
  return {json};
}
