// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

/**
 * Turn the Codex rollout line stream into ReconstructedTurn[].
 *
 * Segmentation rules:
 *  - A turn is bounded by `turn_context`/`task_started` ... `task_complete`.
 *  - Each model round-trip (`chat`) is a run of model-output response items
 *    (reasoning, assistant message, function_call) terminated by a `token_count`
 *    event, whose `info.last_token_usage` is that call's usage delta.
 *  - A tool execution pairs a `function_call` (request) with its
 *    `function_call_output` (result) by `call_id`; `mcp_tool_call_end` enriches it.
 *  - Timestamps are taken from the rollout lines so spans are backdated.
 */
import {EVENT_MSG, RESPONSE_ITEM, ROLLOUT_ITEM} from './types.js';
import type {
  ChatCall,
  NormalizedUsage,
  ReconstructedTurn,
  ToolCall,
} from '../model.js';
import type {
  ContentItem,
  EventMsgPayload,
  FunctionCallItem,
  FunctionCallOutputItem,
  FunctionCallOutput,
  LocalShellCallItem,
  MessageItem,
  McpToolCallEndEvent,
  ReasoningItem,
  ResponseItemPayload,
  RolloutLine,
  TaskCompleteEvent,
  TaskStartedEvent,
  TokenCountEvent,
  TokenUsage,
  WebSearchCallItem,
  CustomToolCallItem,
  CustomToolCallOutputItem,
} from './types.js';

const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** Fallbacks for fields a read slice may lack (no session_meta/turn_context in this chunk). */
export interface ReconstructContext {
  fallbackSessionId: string;
  fallbackModel?: string;
  fallbackCwd?: string;
  fallbackCliVersion?: string;
}

export interface ReconstructResult {
  turns: ReconstructedTurn[];
  /**
   * Count of input lines belonging to fully-completed turns. The caller commits
   * its cursor only this far so a not-yet-flushed trailing turn is re-read next
   * time rather than skipped (exactly-once for complete turns, no loss).
   */
  consumedLines: number;
  /**
   * Turns that began but never completed before a new turn started (e.g. an
   * aborted turn). They are intentionally dropped (out of v1 scope); the count
   * lets the caller log that something was discarded.
   */
  abandonedTurns: number;
}

/** Parse one raw line, or null if malformed/blank (kept aligned by the caller). */
export function parseLineMaybe(raw: string): RolloutLine | null {
  try {
    const parsed = JSON.parse(raw) as RolloutLine;
    return parsed && typeof parsed.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function reconstructTurns(
  lines: ReadonlyArray<RolloutLine | null>,
  context: ReconstructContext
): ReconstructResult {
  const turns: ReconstructedTurn[] = [];
  let sessionId = context.fallbackSessionId;
  let cwd = context.fallbackCwd;
  let cliVersion = context.fallbackCliVersion;
  let current: TurnBuilder | undefined;
  let consumedLines = 0;
  let abandonedTurns = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue; // blank/malformed line; still counted toward consumedLines index
    const timestamp = parseTimestamp(line.timestamp);

    if (line.type === ROLLOUT_ITEM.SESSION_META) {
      const meta = line.payload;
      sessionId = meta.id || sessionId;
      cwd = meta.cwd;
      cliVersion = meta.cli_version;
      continue;
    }

    if (line.type === ROLLOUT_ITEM.TURN_CONTEXT) {
      const turnContext = line.payload;
      if (current) abandonedTurns++; // previous turn never reached task_complete
      current = newTurnBuilder({
        sessionId,
        turnId: turnContext.turn_id,
        model: turnContext.model || context.fallbackModel || 'unknown',
        cwd: turnContext.cwd || cwd,
        cliVersion,
        startTime: timestamp,
      });
      continue;
    }

    if (line.type === ROLLOUT_ITEM.RESPONSE_ITEM && current) {
      applyResponseItem(current, line.payload, timestamp);
      continue;
    }

    if (line.type === ROLLOUT_ITEM.EVENT_MSG && current) {
      const finished = applyEvent(current, line.payload, timestamp);
      if (finished) {
        turns.push(finalizeTurn(current));
        current = undefined;
        consumedLines = i + 1;
      }
    }
  }

  return {turns, consumedLines, abandonedTurns};
}

// --- Turn builder -----------------------------------------------------------

/** Mutable accumulator for the turn being assembled; finalizeTurn freezes it into a ReconstructedTurn. */
interface TurnBuilder {
  sessionId: string;
  turnId: string;
  model: string;
  cwd?: string;
  cliVersion?: string;
  startTime: Date;
  endTime: Date;
  userMessage?: string;
  finalAssistantMessage?: string;
  chats: ChatCall[];
  tools: ToolCall[];
  toolsByCallId: Map<string, ToolCall>;
  pendingToolCalls: ChatCall['toolCalls'];
  // In-flight model call being accumulated until the next token_count.
  pendingItems: ResponseItemPayload[];
  chatStartTime?: Date;
  lastBoundaryTime: Date;
}

function newTurnBuilder(init: {
  sessionId: string;
  turnId: string;
  model: string;
  cwd?: string;
  cliVersion?: string;
  startTime: Date;
}): TurnBuilder {
  return {
    ...init,
    endTime: init.startTime,
    chats: [],
    tools: [],
    toolsByCallId: new Map(),
    pendingToolCalls: [],
    pendingItems: [],
    lastBoundaryTime: init.startTime,
  };
}

function applyResponseItem(
  builder: TurnBuilder,
  item: ResponseItemPayload,
  timestamp: Date
): void {
  switch (item.type) {
    case RESPONSE_ITEM.MESSAGE: {
      const message = item as MessageItem;
      const text = textFromContent(message.content);
      if (message.role === 'user') {
        builder.userMessage = builder.userMessage
          ? `${builder.userMessage}\n${text}`
          : text;
      } else {
        beginChatIfNeeded(builder);
        builder.pendingItems.push(item);
        if (text) builder.finalAssistantMessage = text;
      }
      return;
    }
    case RESPONSE_ITEM.REASONING: {
      beginChatIfNeeded(builder);
      builder.pendingItems.push(item);
      return;
    }
    case RESPONSE_ITEM.FUNCTION_CALL: {
      beginChatIfNeeded(builder);
      builder.pendingItems.push(item);
      const functionCall = item as FunctionCallItem;
      registerRequestedTool(builder, {
        callId: functionCall.call_id,
        name: functionCall.name,
        kind: 'function',
        startTime: timestamp,
        endTime: timestamp,
        arguments: functionCall.arguments,
      });
      return;
    }
    case RESPONSE_ITEM.FUNCTION_CALL_OUTPUT: {
      const functionOutput = item as FunctionCallOutputItem;
      const tool = builder.toolsByCallId.get(functionOutput.call_id);
      if (tool) {
        tool.result = renderOutput(functionOutput.output);
        tool.endTime = timestamp;
      }
      builder.lastBoundaryTime = timestamp;
      return;
    }
    case RESPONSE_ITEM.LOCAL_SHELL_CALL: {
      beginChatIfNeeded(builder);
      builder.pendingItems.push(item);
      const shellCall = item as LocalShellCallItem;
      const callId = shellCall.call_id || `shell-${builder.tools.length}`;
      registerRequestedTool(builder, {
        callId,
        name: 'local_shell',
        kind: 'local_shell',
        startTime: timestamp,
        endTime: timestamp,
        arguments: safeJson(shellCall.action),
      });
      return;
    }
    case RESPONSE_ITEM.WEB_SEARCH_CALL: {
      beginChatIfNeeded(builder);
      builder.pendingItems.push(item);
      const webSearchCall = item as WebSearchCallItem;
      registerRequestedTool(builder, {
        callId: `web_search-${builder.tools.length}`,
        name: 'web_search',
        kind: 'web_search',
        startTime: timestamp,
        endTime: timestamp,
        arguments: safeJson(webSearchCall.action),
      });
      return;
    }
    case RESPONSE_ITEM.CUSTOM_TOOL_CALL: {
      beginChatIfNeeded(builder);
      builder.pendingItems.push(item);
      const customCall = item as CustomToolCallItem;
      registerRequestedTool(builder, {
        callId: customCall.call_id,
        name: customCall.name,
        kind: 'custom',
        startTime: timestamp,
        endTime: timestamp,
        arguments: customCall.input,
      });
      return;
    }
    case RESPONSE_ITEM.CUSTOM_TOOL_CALL_OUTPUT: {
      const customOutput = item as CustomToolCallOutputItem;
      const tool = builder.toolsByCallId.get(customOutput.call_id);
      if (tool) {
        tool.result = renderOutput(customOutput.output);
        tool.endTime = timestamp;
      }
      builder.lastBoundaryTime = timestamp;
      return;
    }
    default:
      return; // forward-compat: ignore item kinds we don't model
  }
}

/** Returns true when the turn is complete (task_complete seen). */
function applyEvent(
  builder: TurnBuilder,
  event: EventMsgPayload,
  timestamp: Date
): boolean {
  switch (event.type) {
    case EVENT_MSG.TOKEN_COUNT: {
      const tokenCount = event as TokenCountEvent;
      closeChat(builder, timestamp, tokenCount.info?.last_token_usage);
      return false;
    }
    case EVENT_MSG.MCP_TOOL_CALL_END: {
      const mcpEnd = event as McpToolCallEndEvent;
      const tool = builder.toolsByCallId.get(mcpEnd.call_id);
      if (tool) {
        tool.kind = 'mcp';
        tool.mcpServer = mcpEnd.invocation?.server;
        if (mcpEnd.invocation?.tool) tool.name = mcpEnd.invocation.tool;
        tool.result = renderResult(mcpEnd.result);
        tool.endTime = timestamp;
      }
      builder.lastBoundaryTime = timestamp;
      return false;
    }
    case EVENT_MSG.AGENT_MESSAGE: {
      const agentMessage = event as {message?: string};
      if (agentMessage.message)
        builder.finalAssistantMessage = agentMessage.message;
      return false;
    }
    case EVENT_MSG.TASK_STARTED: {
      const taskStarted = event as TaskStartedEvent;
      if (typeof taskStarted.started_at === 'number') {
        builder.startTime = new Date(taskStarted.started_at * 1000);
        // Align the first chat's start to the authoritative turn start so a chat
        // span can't begin before its parent turn. Only before any model output.
        if (builder.pendingItems.length === 0)
          builder.lastBoundaryTime = builder.startTime;
      }
      return false;
    }
    case EVENT_MSG.TASK_COMPLETE: {
      const taskComplete = event as TaskCompleteEvent;
      // Flush any model output not yet closed by a token_count.
      if (builder.pendingItems.length > 0)
        closeChat(builder, timestamp, undefined);
      builder.endTime = timestamp;
      if (taskComplete.last_agent_message) {
        builder.finalAssistantMessage = taskComplete.last_agent_message;
      }
      return true;
    }
    default:
      return false;
  }
}

function beginChatIfNeeded(builder: TurnBuilder): void {
  if (builder.pendingItems.length === 0)
    builder.chatStartTime = builder.lastBoundaryTime;
}

function closeChat(
  builder: TurnBuilder,
  endTime: Date,
  usage?: TokenUsage
): void {
  if (builder.pendingItems.length === 0 && !usage) return;
  const toolCalls = builder.pendingToolCalls;
  const text = joinText(
    builder.pendingItems
      .filter(
        (item): item is MessageItem => item.type === RESPONSE_ITEM.MESSAGE
      )
      .map(message => textFromContent(message.content))
  );
  const reasoning = joinText(
    builder.pendingItems
      .filter(
        (item): item is ReasoningItem => item.type === RESPONSE_ITEM.REASONING
      )
      .map(reasoningText)
  );
  const chat: ChatCall = {
    startTime: builder.chatStartTime ?? builder.lastBoundaryTime,
    endTime,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_call' : 'stop',
  };
  if (text) chat.text = text;
  if (reasoning) chat.reasoning = reasoning;
  if (usage) chat.usage = normalizeUsage(usage);

  builder.chats.push(chat);
  builder.lastBoundaryTime = endTime;
  builder.pendingItems = [];
  builder.pendingToolCalls = [];
  builder.chatStartTime = undefined;
}

function registerRequestedTool(builder: TurnBuilder, tool: ToolCall): void {
  builder.pendingToolCalls.push({
    callId: tool.callId,
    name: tool.name,
    arguments: tool.arguments,
  });
  registerTool(builder, tool);
}

function registerTool(builder: TurnBuilder, tool: ToolCall): void {
  builder.tools.push(tool);
  builder.toolsByCallId.set(tool.callId, tool);
}

function finalizeTurn(builder: TurnBuilder): ReconstructedTurn {
  const usageTotal = builder.chats.reduce<NormalizedUsage>(
    (total, chat) => {
      if (!chat.usage) return total;
      return {
        inputTokens: total.inputTokens + chat.usage.inputTokens,
        outputTokens: total.outputTokens + chat.usage.outputTokens,
        cachedInputTokens:
          total.cachedInputTokens + chat.usage.cachedInputTokens,
        reasoningOutputTokens:
          total.reasoningOutputTokens + chat.usage.reasoningOutputTokens,
      };
    },
    {...EMPTY_USAGE}
  );

  return {
    sessionId: builder.sessionId,
    turnId: builder.turnId,
    conversationId: builder.sessionId,
    model: builder.model,
    startTime: builder.startTime,
    endTime: builder.endTime,
    cwd: builder.cwd,
    cliVersion: builder.cliVersion,
    userMessage: builder.userMessage,
    finalAssistantMessage: builder.finalAssistantMessage,
    chats: builder.chats,
    tools: builder.tools,
    usageTotal,
  };
}

// --- Pure helpers -----------------------------------------------------------

function parseTimestamp(iso: string): Date {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function normalizeUsage(usage: TokenUsage): NormalizedUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedInputTokens: usage.cached_input_tokens ?? 0,
    reasoningOutputTokens: usage.reasoning_output_tokens ?? 0,
  };
}

function textFromContent(content: ContentItem[] | undefined): string {
  if (!Array.isArray(content)) return '';
  return joinText(content.map(part => part.text ?? ''));
}

function reasoningText(reasoning: ReasoningItem): string {
  const summary = joinText(
    (reasoning.summary ?? []).map(part => part.text ?? '')
  );
  const content = joinText(
    (reasoning.content ?? []).map(part => part.text ?? '')
  );
  return joinText([summary, content]);
}

function joinText(parts: string[]): string {
  return parts.filter(text => text && text.length > 0).join('\n');
}

function renderOutput(output: FunctionCallOutput): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return textFromContent(output);
  return safeJson(output);
}

function renderResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return safeJson(result);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
