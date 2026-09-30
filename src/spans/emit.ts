// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

import * as tracing from '@coreweave/forge-sdk/agentlens/tracing';
import type {
  Message,
  MessagePart,
  Usage,
} from '@coreweave/forge-sdk/agentlens/tracing';

import {VERSION} from '../constants.js';
import type {
  ChatCall,
  NormalizedUsage,
  ReconstructedTurn,
  ToolCall,
} from '../model.js';
import {CODEX, INTEGRATION, MCP} from '../semconv.js';
import {chatOutputMessages, finalMessages} from './messages.js';

const AGENT_NAME = 'codex';
const INTEGRATION_NAME = 'forge-agent-lens-for-codex';
const MAX_CONTENT_BYTES = 128 * 1024;
const TRUNCATION_MARKER = '…[truncated]';
/** Keep the SDK batch queue bounded even for one unusually large turn. */
const SPANS_PER_FLUSH = 128;

export interface EmittedTurn {
  turnId: string;
  conversationId: string;
}

/** Emit one reconstructed turn through Forge SDK in its own request scope. */
export async function emitTurn(
  turn: ReconstructedTurn,
  includeContent: boolean,
  providerName: string,
  forceFlush?: () => Promise<void>
): Promise<EmittedTurn> {
  return tracing.runIsolated(async () => {
    const attributes: Record<string, string> = {
      [INTEGRATION.NAME]: INTEGRATION_NAME,
      [INTEGRATION.VERSION]: VERSION,
      [CODEX.SESSION_ID]: turn.sessionId,
      [CODEX.TURN_ID]: turn.turnId,
    };
    if (turn.cliVersion) {
      attributes[INTEGRATION.CODEX_CLI_VERSION] = turn.cliVersion;
    }
    if (includeContent && turn.cwd) {
      attributes[CODEX.CWD] = truncate(turn.cwd);
    }

    const conversation = tracing.startConversation({
      conversationId: turn.conversationId,
      agentName: AGENT_NAME,
      agentVersion: turn.cliVersion,
      model: turn.model,
      attributes,
    });
    const turnSpan = conversation.startTurn({
      startTime: turn.startTime,
      userMessage:
        includeContent && turn.userMessage
          ? truncate(turn.userMessage)
          : undefined,
    });

    try {
      let childrenSinceFlush = 0;
      for (const chat of turn.chats) {
        emitChat(turnSpan, turn, chat, includeContent, providerName);
        if (++childrenSinceFlush === SPANS_PER_FLUSH && forceFlush) {
          await forceFlush();
          childrenSinceFlush = 0;
        }
      }
      for (const tool of turn.tools) {
        emitTool(turnSpan, turn, tool, includeContent);
        if (++childrenSinceFlush === SPANS_PER_FLUSH && forceFlush) {
          await forceFlush();
          childrenSinceFlush = 0;
        }
      }
      if (includeContent) {
        turnSpan.record({
          outputMessages: truncateMessages(finalMessages(turn)),
        });
      }
      turnSpan.end({endTime: turn.endTime});
    } finally {
      conversation.end({endTime: turn.endTime});
    }

    return {turnId: turn.turnId, conversationId: turn.conversationId};
  });
}

function emitChat(
  turnSpan: tracing.Turn,
  turn: ReconstructedTurn,
  chat: ChatCall,
  includeContent: boolean,
  providerName: string
): void {
  const llm = turnSpan.startLLM({
    model: turn.model,
    providerName,
    startTime: clamp(chat.startTime, turn.startTime, turn.endTime),
  });
  llm.record({
    outputMessages: includeContent
      ? truncateMessages(chatOutputMessages(chat))
      : [],
    usage: usage(chat.usage),
    responseModel: turn.model,
    finishReasons: [chat.finishReason],
  });
  llm.end({endTime: clamp(chat.endTime, turn.startTime, turn.endTime)});
}

function emitTool(
  turnSpan: tracing.Turn,
  turn: ReconstructedTurn,
  tool: ToolCall,
  includeContent: boolean
): void {
  const toolSpan = turnSpan.startTool({
    name: tool.name,
    toolCallId: tool.callId,
    args:
      includeContent && tool.arguments ? truncate(tool.arguments) : undefined,
    startTime: clamp(tool.startTime, turn.startTime, turn.endTime),
  });
  if (tool.mcpServer) {
    toolSpan.setAttributes({[MCP.SERVER_NAME]: tool.mcpServer});
  }
  toolSpan.end({
    result:
      includeContent && tool.result != null ? truncate(tool.result) : undefined,
    endTime: clamp(tool.endTime, turn.startTime, turn.endTime),
  });
}

function usage(value: NormalizedUsage | undefined): Usage {
  if (!value) return {};
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    ...(value.cachedInputTokens > 0
      ? {cacheReadInputTokens: value.cachedInputTokens}
      : {}),
    ...(value.reasoningOutputTokens > 0
      ? {reasoningTokens: value.reasoningOutputTokens}
      : {}),
  };
}

function truncateMessages(messages: Message[]): Message[] {
  return messages.map(message => ({
    ...message,
    ...(message.content ? {content: truncate(message.content)} : {}),
    ...(message.parts ? {parts: message.parts.map(truncatePart)} : {}),
  }));
}

function truncatePart(part: MessagePart): MessagePart {
  if ('content' in part && part.content) {
    return {...part, content: truncate(part.content)};
  }
  if (part.type === 'tool_call' && part.arguments) {
    return {...part, arguments: truncate(part.arguments)};
  }
  return part;
}

function truncate(value: string): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= MAX_CONTENT_BYTES) return value;
  const keepBytes =
    MAX_CONTENT_BYTES - Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  return (
    new TextDecoder('utf-8').decode(buffer.subarray(0, keepBytes)) +
    TRUNCATION_MARKER
  );
}

function clamp(time: Date, windowStart: Date, windowEnd: Date): Date {
  const clampedMs = Math.min(
    Math.max(time.getTime(), windowStart.getTime()),
    windowEnd.getTime()
  );
  return new Date(clampedMs);
}
