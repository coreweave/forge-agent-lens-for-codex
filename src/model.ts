// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

/**
 * Internal domain model — the reconstructed shape of one Codex turn, decoupled
 * from both the rollout wire format (rollout/types.ts) and the OTEL span output.
 * camelCase here; the wire format stays snake_case. This is the seam the parser
 * produces and the span emitter consumes.
 */

/** Normalized token usage for a single model call or a turn total. */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
}

export type ToolKind =
  | 'function'
  | 'local_shell'
  | 'web_search'
  | 'custom'
  | 'mcp';

/** A tool execution → one `execute_tool` span. */
export interface ToolCall {
  callId: string;
  name: string;
  kind: ToolKind;
  startTime: Date;
  endTime: Date;
  arguments?: string;
  result?: string;
  mcpServer?: string;
}

/** A tool the model requested within a chat (for that chat's output.messages). */
export interface ChatToolRef {
  callId: string;
  name: string;
  arguments?: string;
}

/** A single model round-trip → one `chat` span. */
export interface ChatCall {
  startTime: Date;
  endTime: Date;
  text?: string;
  reasoning?: string;
  toolCalls: ChatToolRef[];
  usage?: NormalizedUsage;
  finishReason: string; // 'tool_call' | 'stop'
}

/** One completed user→agent turn → one trace rooted at an `invoke_agent` span. */
export interface ReconstructedTurn {
  sessionId: string;
  turnId: string;
  conversationId: string;
  model: string;
  startTime: Date;
  endTime: Date;
  cwd?: string;
  cliVersion?: string;
  userMessage?: string;
  finalAssistantMessage?: string;
  chats: ChatCall[];
  tools: ToolCall[];
  usageTotal: NormalizedUsage;
}
