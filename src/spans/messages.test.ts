// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

import {describe, expect, it} from 'vitest';

import type {ChatCall, ReconstructedTurn} from '../model.js';
import {chatOutputMessages, finalMessages} from './messages.js';

function turn(overrides: Partial<ReconstructedTurn> = {}): ReconstructedTurn {
  return {
    sessionId: 's',
    turnId: 't',
    conversationId: 's',
    model: 'm',
    startTime: new Date(0),
    endTime: new Date(1000),
    chats: [],
    tools: [],
    usageTotal: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    ...overrides,
  };
}

describe('messages', () => {
  it('finalMessages emits the final assistant message', () => {
    expect(finalMessages(turn())).toEqual([]);
    expect(finalMessages(turn({finalAssistantMessage: 'done'}))).toEqual([
      {role: 'assistant', content: 'done'},
    ]);
  });

  it('chatOutputMessages orders reasoning, text, then tool_call parts', () => {
    const chat: ChatCall = {
      startTime: new Date(0),
      endTime: new Date(1),
      text: 'hello',
      reasoning: 'thinking',
      toolCalls: [{callId: 'c1', name: 'shell', arguments: '{}'}],
      finishReason: 'tool_call',
    };
    const msgs = chatOutputMessages(chat);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({
      role: 'assistant',
      parts: [
        {type: 'reasoning', content: 'thinking'},
        {type: 'text', content: 'hello'},
        {
          type: 'tool_call',
          id: 'c1',
          name: 'shell',
          arguments: '{}',
        },
      ],
    });
  });

  it('chatOutputMessages is empty when the call produced nothing', () => {
    const chat: ChatCall = {
      startTime: new Date(0),
      endTime: new Date(1),
      toolCalls: [],
      finishReason: 'stop',
    };
    expect(chatOutputMessages(chat)).toEqual([]);
  });
});
