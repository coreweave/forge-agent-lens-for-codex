// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

/**
 * TypeScript shapes for the subset of the Codex rollout JSONL we consume.
 *
 * These mirror the on-disk format — only the fields the collector reads, not the
 * full set. Field names are the exact wire names (snake_case); any unlisted
 * optional fields are simply ignored at runtime.
 */

// --- Top-level line: { timestamp, type, payload } ---------------------------

/** Fields common to every rollout line; `type` discriminates `payload` below. */
interface RolloutLineBase {
  timestamp: string;
}

/**
 * A rollout line, discriminated by `type` so a `line.type === ...` check narrows
 * `line.payload` to the matching shape without a cast.
 */
export type RolloutLine =
  | (RolloutLineBase & {type: 'session_meta'; payload: SessionMetaPayload})
  | (RolloutLineBase & {type: 'turn_context'; payload: TurnContextPayload})
  | (RolloutLineBase & {type: 'response_item'; payload: ResponseItemPayload})
  | (RolloutLineBase & {type: 'event_msg'; payload: EventMsgPayload})
  | (RolloutLineBase & {type: 'compacted'; payload: unknown});

// --- session_meta -----------------------------------------------------------

export interface SessionMetaPayload {
  id: string;
  timestamp: string;
  cwd: string;
  originator: string;
  cli_version: string;
  source: string;
  model_provider?: string;
  forked_from_id?: string | null;
  parent_thread_id?: string | null;
  git?: {commit_hash?: string; branch?: string; repository_url?: string} | null;
}

// --- turn_context (per-turn settings; carries the model string) -------------

export interface TurnContextPayload {
  turn_id: string;
  cwd: string;
  model: string;
  effort?: string;
  summary?: string;
  approval_policy?: string;
}

// --- token usage ------------------------------------------------------------

/** Per-call delta (last_token_usage) or running total (total_token_usage). */
export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

export interface TokenUsageInfo {
  total_token_usage: TokenUsage;
  last_token_usage: TokenUsage;
  model_context_window?: number | null;
}

// --- event_msg (inline-tagged by `type`) ------------------------------------

export interface TokenCountEvent {
  type: 'token_count';
  info?: TokenUsageInfo | null;
}

export interface TaskStartedEvent {
  type: 'task_started';
  turn_id: string;
  started_at?: number | null;
}

export interface TaskCompleteEvent {
  type: 'task_complete';
  turn_id: string;
  last_agent_message?: string | null;
  completed_at?: number | null;
  duration_ms?: number | null;
  time_to_first_token_ms?: number | null;
}

export interface AgentMessageEvent {
  type: 'agent_message';
  message: string;
}

export interface AgentReasoningEvent {
  type: 'agent_reasoning';
  text: string;
}

export interface McpInvocation {
  server: string;
  tool: string;
  arguments?: unknown;
}

export interface McpToolCallEndEvent {
  type: 'mcp_tool_call_end';
  call_id: string;
  invocation: McpInvocation;
  result?: unknown;
}

export type EventMsgPayload =
  | TokenCountEvent
  | TaskStartedEvent
  | TaskCompleteEvent
  | AgentMessageEvent
  | AgentReasoningEvent
  | McpToolCallEndEvent
  | {type: string}; // forward-compat: events we don't model yet

// --- response_item (inline-tagged by `type`) --------------------------------

/** Content block inside a message; we mainly read text. */
export interface ContentItem {
  type: string; // input_text | output_text | input_image | ...
  text?: string;
  image_url?: string;
}

export interface MessageItem {
  type: 'message';
  role: string; // user | assistant | system | developer
  content: ContentItem[];
  phase?: string; // commentary | final_answer
}

export interface ReasoningSummary {
  type: string; // summary_text
  text: string;
}

export interface ReasoningItem {
  type: 'reasoning';
  summary: ReasoningSummary[];
  content?: Array<{type: string; text?: string}>;
  encrypted_content?: string | null;
}

export interface FunctionCallItem {
  type: 'function_call';
  name: string;
  namespace?: string | null;
  arguments: string; // raw JSON string
  call_id: string;
}

/** `output` is a plain string OR an array of content items. */
export type FunctionCallOutput = string | ContentItem[];

export interface FunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: FunctionCallOutput;
}

export interface LocalShellExecAction {
  type: 'exec';
  command: string[];
  timeout_ms?: number;
  working_directory?: string;
}

export interface LocalShellCallItem {
  type: 'local_shell_call';
  call_id?: string | null;
  status?: string;
  action: LocalShellExecAction;
}

export interface WebSearchCallItem {
  type: 'web_search_call';
  status?: string;
  action?: {type: string; query?: string; url?: string; pattern?: string};
}

export interface CustomToolCallItem {
  type: 'custom_tool_call';
  call_id: string;
  name: string;
  input: string;
  status?: string | null;
}

export interface CustomToolCallOutputItem {
  type: 'custom_tool_call_output';
  call_id: string;
  name?: string | null;
  output: FunctionCallOutput;
}

export type ResponseItemPayload =
  | MessageItem
  | ReasoningItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | LocalShellCallItem
  | WebSearchCallItem
  | CustomToolCallItem
  | CustomToolCallOutputItem
  | {type: string}; // forward-compat

// --- Wire-format discriminator tags (the serde `type` values on disk) ---

/** RolloutItem outer tags: `{ "timestamp", "type": <tag>, "payload": {...} }`. */
export const ROLLOUT_ITEM = {
  SESSION_META: 'session_meta',
  RESPONSE_ITEM: 'response_item',
  TURN_CONTEXT: 'turn_context',
  EVENT_MSG: 'event_msg',
  COMPACTED: 'compacted',
} as const;

/** EventMsg subtypes. NOTE the renames: turn boundaries serialize as task_*. */
export const EVENT_MSG = {
  TASK_STARTED: 'task_started', // == TurnStarted
  TASK_COMPLETE: 'task_complete', // == TurnComplete; carries duration_ms
  TOKEN_COUNT: 'token_count', // one per model call; info.last_token_usage = per-call delta
  AGENT_MESSAGE: 'agent_message',
  AGENT_REASONING: 'agent_reasoning',
  MCP_TOOL_CALL_END: 'mcp_tool_call_end', // pairs to a function_call by call_id
} as const;

/** ResponseItem subtypes (each inline-tagged by `type`). */
export const RESPONSE_ITEM = {
  MESSAGE: 'message',
  REASONING: 'reasoning',
  FUNCTION_CALL: 'function_call',
  FUNCTION_CALL_OUTPUT: 'function_call_output', // inline: { type, call_id, output }
  LOCAL_SHELL_CALL: 'local_shell_call',
  CUSTOM_TOOL_CALL: 'custom_tool_call',
  CUSTOM_TOOL_CALL_OUTPUT: 'custom_tool_call_output',
  WEB_SEARCH_CALL: 'web_search_call',
} as const;
