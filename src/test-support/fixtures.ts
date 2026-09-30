// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

/**
 * Synthetic rollout JSONL fixtures modeled on the real on-disk schema.
 * Deterministic timestamps (no Date.now).
 */
const BASE_MS = Date.parse('2026-06-01T17:24:00.000Z');
const SESSION_ID = '019e474c-2280-78a3-901b-23151b884aa6';

function iso(offsetSec: number): string {
  return new Date(BASE_MS + offsetSec * 1000).toISOString();
}

/**
 * One rollout line, timestamped `offsetSec` seconds after the turn start
 * (BASE_MS). The offset is a wall-clock time, not a line index: events that
 * occur together share an offset, and a gap (0 → 2) models elapsed time — which
 * is exactly what the parser turns into backdated span durations.
 */
function line(offsetSec: number, type: string, payload: unknown): string {
  return JSON.stringify({timestamp: iso(offsetSec), type, payload});
}

function usage(input: number, output: number, cached = 0, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function tokenCount(last: ReturnType<typeof usage>) {
  return {
    type: 'token_count',
    info: {
      total_token_usage: last,
      last_token_usage: last,
      model_context_window: 200_000,
    },
  };
}

/** Single model call, no tools. */
export function simpleTurn(): string[] {
  return [
    // t+0s — the turn opens: session + turn metadata, then the user's message.
    line(0, 'session_meta', {
      id: SESSION_ID,
      timestamp: iso(0),
      cwd: '/tmp/proj',
      originator: 'codex_cli_rs',
      cli_version: '0.50.0',
      source: 'cli',
      model_provider: 'openai',
    }),
    line(0, 'turn_context', {
      turn_id: 't1',
      cwd: '/tmp/proj',
      model: 'gpt-5-codex',
    }),
    line(0, 'event_msg', {
      type: 'task_started',
      turn_id: 't1',
      started_at: Math.floor(BASE_MS / 1000),
    }),
    line(0, 'response_item', {
      type: 'message',
      role: 'user',
      content: [{type: 'input_text', text: 'say hi'}],
    }),
    // t+2s — the model's reply lands, with its token usage and turn completion.
    line(2, 'response_item', {
      type: 'message',
      role: 'assistant',
      content: [{type: 'output_text', text: 'hi there'}],
      phase: 'final_answer',
    }),
    line(2, 'event_msg', {type: 'agent_message', message: 'hi there'}),
    line(2, 'event_msg', tokenCount(usage(100, 5, 10, 0))),
    line(2, 'event_msg', {
      type: 'task_complete',
      turn_id: 't1',
      last_agent_message: 'hi there',
      duration_ms: 2000,
    }),
  ];
}

/** Reasoning + two tool calls (one becomes MCP) + final answer → 3 chats, 2 tools. */
export function multiToolTurn(): string[] {
  return [
    line(0, 'session_meta', {
      id: SESSION_ID,
      timestamp: iso(0),
      cwd: '/tmp/proj',
      originator: 'codex_cli_rs',
      cli_version: '0.50.0',
      source: 'cli',
      model_provider: 'openai',
    }),
    line(0, 'turn_context', {
      turn_id: 't9',
      cwd: '/tmp/proj',
      model: 'gpt-5-codex',
    }),
    line(0, 'event_msg', {
      type: 'task_started',
      turn_id: 't9',
      started_at: Math.floor(BASE_MS / 1000),
    }),
    line(0, 'response_item', {
      type: 'message',
      role: 'user',
      content: [{type: 'input_text', text: 'list files'}],
    }),
    // chat 1: reasoning + tool request
    line(1, 'response_item', {
      type: 'reasoning',
      summary: [{type: 'summary_text', text: 'I should ls'}],
    }),
    line(2, 'response_item', {
      type: 'function_call',
      name: 'shell',
      namespace: null,
      arguments: '{"command":["ls"]}',
      call_id: 'call_1',
    }),
    line(2, 'event_msg', tokenCount(usage(1000, 20, 100, 10))),
    line(3, 'response_item', {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'a.txt\nb.txt',
    }),
    // chat 2: another tool request (MCP-backed)
    line(4, 'response_item', {
      type: 'function_call',
      name: 'read_file',
      arguments: '{"path":"a.txt"}',
      call_id: 'call_2',
    }),
    line(5, 'event_msg', tokenCount(usage(1100, 15))),
    line(6, 'response_item', {
      type: 'function_call_output',
      call_id: 'call_2',
      output: 'contents of a',
    }),
    line(6, 'event_msg', {
      type: 'mcp_tool_call_end',
      call_id: 'call_2',
      invocation: {server: 'fs', tool: 'read_file', arguments: {path: 'a.txt'}},
      result: 'contents of a',
    }),
    // chat 3: final answer
    line(7, 'response_item', {
      type: 'message',
      role: 'assistant',
      content: [{type: 'output_text', text: 'Found 2 files'}],
      phase: 'final_answer',
    }),
    line(7, 'event_msg', {type: 'agent_message', message: 'Found 2 files'}),
    line(8, 'event_msg', tokenCount(usage(1200, 30))),
    line(8, 'event_msg', {
      type: 'task_complete',
      turn_id: 't9',
      last_agent_message: 'Found 2 files',
      duration_ms: 8000,
    }),
  ];
}

export const FIXTURE_SESSION_ID = SESSION_ID;
export const FIXTURE_BASE_MS = BASE_MS;
