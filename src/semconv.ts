// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

/**
 * Custom attributes that are not part of the Forge SDK's typed GenAI surface.
 */

/**
 * MCP tool-call context. Attached to the same execute_tool span (per the spec)
 * rather than a separate MCP span. Not typed by the spec package.
 */
export const MCP = {
  SERVER_NAME: 'mcp.server.name',
} as const;

/** Fixed integration identity and best-effort host metadata for every span. */
export const INTEGRATION = {
  NAME: 'forge.integration.name',
  VERSION: 'forge.integration.version',
  CODEX_CLI_VERSION: 'forge.integration.codex.cli_version',
} as const;

/** Codex-specific vendor extensions (no canonical gen_ai key exists for these). */
export const CODEX = {
  SESSION_ID: 'codex.session.id',
  TURN_ID: 'codex.turn.id',
  CWD: 'codex.cwd',
} as const;
