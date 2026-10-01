// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

import type {
  Message,
  MessagePart,
} from '@coreweave/forge-sdk/agentlens/tracing';

import type {ChatCall, ReconstructedTurn} from '../model.js';

export function finalMessages(turn: ReconstructedTurn): Message[] {
  if (!turn.finalAssistantMessage) return [];
  return [{role: 'assistant', content: turn.finalAssistantMessage}];
}

export function chatOutputMessages(chat: ChatCall): Message[] {
  const parts: MessagePart[] = [];
  if (chat.reasoning) parts.push({type: 'reasoning', content: chat.reasoning});
  if (chat.text) parts.push({type: 'text', content: chat.text});
  for (const toolCall of chat.toolCalls) {
    parts.push({
      type: 'tool_call',
      id: toolCall.callId,
      name: toolCall.name,
      ...(toolCall.arguments ? {arguments: toolCall.arguments} : {}),
    });
  }
  if (parts.length === 0) return [];
  return [{role: 'assistant', parts}];
}
