// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

import {describe, expect, it} from 'vitest';

import {parseLineMaybe, reconstructTurns} from './parser.js';
import {
  FIXTURE_BASE_MS,
  FIXTURE_SESSION_ID,
  multiToolTurn,
  simpleTurn,
} from '../test-support/fixtures.js';

function reconstruct(lines: string[]) {
  return reconstructTurns(lines.map(parseLineMaybe), {
    fallbackSessionId: 'fallback',
  });
}

function record(offset: number, type: string, payload: unknown): string {
  return JSON.stringify({
    timestamp: new Date(FIXTURE_BASE_MS + offset * 1000).toISOString(),
    type,
    payload,
  });
}

function tokenCount() {
  const usage = {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
    total_tokens: 2,
  };
  return {type: 'token_count', info: {last_token_usage: usage}};
}

describe('reconstructTurns', () => {
  it('reconstructs a simple single-call turn', () => {
    const {turns, consumedLines} = reconstruct(simpleTurn());
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      turnId: 't1',
      model: 'gpt-5-codex',
      conversationId: FIXTURE_SESSION_ID,
      userMessage: 'say hi',
      finalAssistantMessage: 'hi there',
      chats: [{finishReason: 'stop'}],
      tools: [],
      usageTotal: {
        inputTokens: 100,
        outputTokens: 5,
        cachedInputTokens: 10,
        reasoningOutputTokens: 0,
      },
    });
    expect(consumedLines).toBe(simpleTurn().length);
  });

  it('segments a multi-tool turn into per-call chats and paired tools', () => {
    const {turns} = reconstruct(multiToolTurn());
    expect(turns).toHaveLength(1);
    // One chat per model round-trip (token_count boundary); each call is billed
    // for its full input, so usageTotal sums them. Two tools, both paired with
    // their outputs; the second is enriched into an MCP call.
    expect(turns[0]).toMatchObject({
      chats: [
        {
          finishReason: 'tool_call',
          reasoning: 'I should ls',
          usage: {inputTokens: 1000},
        },
        {finishReason: 'tool_call', usage: {inputTokens: 1100}},
        {finishReason: 'stop'},
      ],
      tools: [
        {
          callId: 'call_1',
          name: 'shell',
          kind: 'function',
          result: 'a.txt\nb.txt',
        },
        {
          callId: 'call_2',
          kind: 'mcp',
          mcpServer: 'fs',
          result: 'contents of a',
        },
      ],
      usageTotal: {inputTokens: 3300, outputTokens: 65},
    });
  });

  it('backdates spans from rollout timestamps', () => {
    const {turns} = reconstruct(multiToolTurn());
    const turn = turns[0]!;
    expect(turn.startTime.getTime()).toBe(FIXTURE_BASE_MS);
    expect(turn.endTime.getTime()).toBe(FIXTURE_BASE_MS + 8000);
    // Each model call has a realistic, non-zero duration.
    const durations = turn.chats.map(
      chat => chat.endTime.getTime() - chat.startTime.getTime()
    );
    expect(durations).toEqual([2000, 2000, 2000]);
  });

  it('does not finalize an incomplete trailing turn', () => {
    const withoutComplete = multiToolTurn().slice(0, -1); // drop task_complete
    const {turns, consumedLines} = reconstruct(withoutComplete);
    expect(turns).toEqual([]);
    expect(consumedLines).toBe(0);
  });

  it('records shell, web-search, and custom requests in their model calls', () => {
    const lines = [
      record(0, 'session_meta', {
        id: FIXTURE_SESSION_ID,
        cwd: '/tmp/project',
        cli_version: '1.0.0',
      }),
      record(0, 'turn_context', {
        turn_id: 'tools',
        cwd: '/tmp/project',
        model: 'gpt-5-codex',
      }),
      record(0, 'event_msg', {type: 'task_started', turn_id: 'tools'}),
      record(1, 'response_item', {
        type: 'local_shell_call',
        call_id: 'shell-1',
        action: {type: 'exec', command: ['pwd']},
      }),
      record(2, 'event_msg', tokenCount()),
      record(3, 'response_item', {
        type: 'function_call_output',
        call_id: 'shell-1',
        output: '/tmp/project',
      }),
      record(4, 'response_item', {
        type: 'web_search_call',
        action: {type: 'search', query: 'forge sdk'},
      }),
      record(5, 'event_msg', tokenCount()),
      record(6, 'response_item', {
        type: 'custom_tool_call',
        call_id: 'custom-1',
        name: 'apply_patch',
        input: '*** Begin Patch',
      }),
      record(7, 'event_msg', tokenCount()),
      record(8, 'response_item', {
        type: 'custom_tool_call_output',
        call_id: 'custom-1',
        output: 'Done!',
      }),
      record(9, 'event_msg', {type: 'task_complete', turn_id: 'tools'}),
    ];

    const {turns} = reconstruct(lines);
    expect(turns[0]!.chats).toMatchObject([
      {
        finishReason: 'tool_call',
        toolCalls: [{callId: 'shell-1', name: 'local_shell'}],
      },
      {
        finishReason: 'tool_call',
        toolCalls: [{name: 'web_search'}],
      },
      {
        finishReason: 'tool_call',
        toolCalls: [{callId: 'custom-1', name: 'apply_patch'}],
      },
    ]);
    expect(turns[0]!.tools).toMatchObject([
      {kind: 'local_shell', result: '/tmp/project'},
      {kind: 'web_search'},
      {kind: 'custom', result: 'Done!'},
    ]);
  });

  it('keeps tool-only model output when token usage is absent', () => {
    const lines = [
      record(0, 'session_meta', {
        id: FIXTURE_SESSION_ID,
        cwd: '/tmp/project',
        cli_version: '1.0.0',
      }),
      record(0, 'turn_context', {
        turn_id: 'tool-only',
        cwd: '/tmp/project',
        model: 'gpt-5-codex',
      }),
      record(0, 'response_item', {
        type: 'local_shell_call',
        call_id: 'shell-only',
        action: {type: 'exec', command: ['pwd']},
      }),
      record(1, 'response_item', {
        type: 'web_search_call',
        action: {type: 'search', query: 'forge sdk'},
      }),
      record(2, 'response_item', {
        type: 'custom_tool_call',
        call_id: 'custom-only',
        name: 'apply_patch',
        input: 'patch',
      }),
      record(3, 'event_msg', {
        type: 'task_complete',
        turn_id: 'tool-only',
      }),
    ];

    const {turns} = reconstruct(lines);
    expect(turns[0]!.chats).toMatchObject([
      {
        finishReason: 'tool_call',
        toolCalls: [
          {callId: 'shell-only', name: 'local_shell'},
          {name: 'web_search'},
          {callId: 'custom-only', name: 'apply_patch'},
        ],
      },
    ]);
  });

  it('ignores malformed and unknown additive records', () => {
    const lines = simpleTurn();
    lines.splice(
      4,
      0,
      '{not json',
      record(1, 'compacted', {replacement_history: []}),
      record(1, 'response_item', {type: 'future_item', value: 1}),
      record(1, 'event_msg', {type: 'future_event', value: 1})
    );

    const {turns, consumedLines} = reconstruct(lines);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.finalAssistantMessage).toBe('hi there');
    expect(consumedLines).toBe(lines.length);
  });
});
