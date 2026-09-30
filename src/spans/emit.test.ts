// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-codex

import * as tracing from '@coreweave/forge-sdk/agentlens/tracing';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {DEFAULT_PROVIDER_NAME, VERSION} from '../constants.js';
import {parseLineMaybe, reconstructTurns} from '../rollout/parser.js';
import {FIXTURE_SESSION_ID, multiToolTurn} from '../test-support/fixtures.js';
import {emitTurn} from './emit.js';
import {RetainingSpanExporter} from '../test-support/retainingExporter.js';

function turnFromFixture() {
  return reconstructTurns(multiToolTurn().map(parseLineMaybe), {
    fallbackSessionId: 'x',
  }).turns[0]!;
}

const op = (s: ReadableSpan) => s.attributes['gen_ai.operation.name'];
const parentId = (s: ReadableSpan) =>
  (
    s as unknown as {
      parentSpanContext?: {spanId: string};
      parentSpanId?: string;
    }
  ).parentSpanContext?.spanId ??
  (s as unknown as {parentSpanId?: string}).parentSpanId;
const hrToMs = ([sec, nano]: [number, number]) => sec * 1000 + nano / 1e6;

function spanTree(spans: ReadableSpan[]) {
  const root = spans.find(s => parentId(s) === undefined)!;
  return {
    name: root.name,
    children: spans
      .filter(s => parentId(s) === root.spanContext().spanId)
      .map(s => s.name),
  };
}

describe('emitTurn', () => {
  let exporter: InMemorySpanExporter;
  let spans: ReadableSpan[];

  beforeEach(async () => {
    exporter = new InMemorySpanExporter();
    await tracing.init('ent/proj', {
      spanProcessor: new SimpleSpanProcessor(exporter),
      serviceName: 'forge-codex',
    });
    await emitTurn(turnFromFixture(), true, DEFAULT_PROVIDER_NAME);
    spans = exporter.getFinishedSpans();
  });

  afterEach(async () => {
    await tracing.shutdown();
  });

  it('builds one invoke_agent root with sibling chat and tool spans', () => {
    expect(spans).toHaveLength(6);
    expect(spanTree(spans)).toEqual({
      name: 'invoke_agent codex',
      children: [
        'chat gpt-5-codex',
        'chat gpt-5-codex',
        'chat gpt-5-codex',
        'execute_tool shell',
        'execute_tool read_file',
      ],
    });
  });

  it('stamps the conversation id and integration attributes on every span', () => {
    for (const span of spans) {
      expect(span.attributes).toMatchObject({
        'gen_ai.conversation.id': FIXTURE_SESSION_ID,
        'forge.integration.name': 'forge-codex',
        'forge.integration.version': VERSION,
        'forge.integration.codex.cli_version': '0.50.0',
        'codex.session.id': FIXTURE_SESSION_ID,
        'codex.turn.id': 't9',
      });
    }
  });

  it('uses typed Forge fields for the turn and model calls', () => {
    const root = spans.find(s => op(s) === 'invoke_agent')!;
    expect(root.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'codex',
      'gen_ai.agent.version': '0.50.0',
      'gen_ai.request.model': 'gpt-5-codex',
    });

    const chat = spans.find(s => op(s) === 'chat')!;
    expect(chat.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-5-codex',
      'gen_ai.response.model': 'gpt-5-codex',
      'gen_ai.response.finish_reasons': ['tool_call'],
      'gen_ai.usage.input_tokens': 1000,
    });
  });

  it('records the bridge provider override on model spans only', async () => {
    exporter.reset();
    await emitTurn(turnFromFixture(), true, 'wandb-inference');
    const overridden = exporter.getFinishedSpans();
    expect(
      overridden
        .filter(s => op(s) === 'chat')
        .map(s => s.attributes['gen_ai.provider.name'])
    ).toEqual(['wandb-inference', 'wandb-inference', 'wandb-inference']);
    expect(
      overridden.find(s => op(s) === 'invoke_agent')!.attributes[
        'gen_ai.provider.name'
      ]
    ).toBeUndefined();
  });

  it('records per-chat usage and keeps cached input separate', () => {
    const chats = spans.filter(s => op(s) === 'chat');
    expect(chats.map(s => s.attributes['gen_ai.usage.input_tokens'])).toEqual([
      1000, 1100, 1200,
    ]);
    expect(
      chats.map(s => s.attributes['gen_ai.usage.cache_read.input_tokens'] ?? 0)
    ).toEqual([100, 0, 0]);
    expect(
      spans.find(s => op(s) === 'invoke_agent')!.attributes[
        'gen_ai.usage.input_tokens'
      ]
    ).toBeUndefined();
  });

  it('emits tool content and structural MCP server metadata', () => {
    const tools = spans.filter(s => op(s) === 'execute_tool');
    expect(
      tools.find(s => s.attributes['gen_ai.tool.name'] === 'shell')!.attributes
    ).toMatchObject({
      'gen_ai.tool.name': 'shell',
      'gen_ai.tool.call.id': 'call_1',
      'gen_ai.tool.call.arguments': '{"command":["ls"]}',
      'gen_ai.tool.call.result': 'a.txt\nb.txt',
    });
    expect(
      tools.find(s => s.attributes['mcp.server.name'] === 'fs')
    ).toBeDefined();
  });

  it('backdates and clamps child timestamps to the turn window', async () => {
    const turn = turnFromFixture();
    turn.chats[0]!.startTime = new Date(turn.startTime.getTime() - 1000);
    turn.chats[0]!.endTime = new Date(turn.endTime.getTime() + 1000);
    exporter.reset();
    await emitTurn(turn, true, DEFAULT_PROVIDER_NAME);

    const emitted = exporter.getFinishedSpans();
    const root = emitted.find(s => op(s) === 'invoke_agent')!;
    const firstChat = emitted.find(s => op(s) === 'chat')!;
    expect(hrToMs(root.endTime) - hrToMs(root.startTime)).toBe(8000);
    expect(hrToMs(firstChat.startTime)).toBe(hrToMs(root.startTime));
    expect(hrToMs(firstChat.endTime)).toBe(hrToMs(root.endTime));
  });

  it('omits content but keeps structure, usage, and MCP metadata', async () => {
    exporter.reset();
    await emitTurn(turnFromFixture(), false, DEFAULT_PROVIDER_NAME);
    const noContent = exporter.getFinishedSpans();
    for (const span of noContent) {
      expect(span.attributes['gen_ai.input.messages']).toBeUndefined();
      expect(span.attributes['gen_ai.output.messages']).toBeUndefined();
      expect(span.attributes['gen_ai.tool.call.arguments']).toBeUndefined();
      expect(span.attributes['gen_ai.tool.call.result']).toBeUndefined();
      expect(span.attributes['codex.cwd']).toBeUndefined();
    }
    expect(
      noContent.find(s => op(s) === 'chat')!.attributes[
        'gen_ai.usage.input_tokens'
      ]
    ).toBe(1000);
    expect(
      noContent.find(s => s.attributes['mcp.server.name'] === 'fs')
    ).toBeDefined();
  });

  it('returns stable turn identifiers and lets Forge own resource attribution', async () => {
    exporter.reset();
    const result = await emitTurn(
      turnFromFixture(),
      true,
      DEFAULT_PROVIDER_NAME
    );
    expect(result).toEqual({
      turnId: 't9',
      conversationId: FIXTURE_SESSION_ID,
    });
    const emitted = exporter.getFinishedSpans();
    expect([
      ...new Set(emitted.map(s => s.spanContext().traceId)),
    ]).toHaveLength(1);
    expect(
      emitted.find(s => op(s) === 'invoke_agent')!.resource.attributes[
        'wandb.sdk.name'
      ]
    ).toBe('forge');
  });

  it('flushes within a large turn before the SDK batch queue can overflow', async () => {
    await tracing.shutdown();
    const retaining = new RetainingSpanExporter();
    await tracing.init('ent/proj', {
      spanProcessor: new BatchSpanProcessor(retaining, {
        maxQueueSize: 160,
        maxExportBatchSize: 64,
        scheduledDelayMillis: 60_000,
      }),
      serviceName: 'forge-codex',
    });
    const turn = turnFromFixture();
    turn.chats = Array.from({length: 300}, () => ({...turn.chats[0]!}));
    turn.tools = [];

    await emitTurn(turn, true, DEFAULT_PROVIDER_NAME, tracing.forceFlush);
    await tracing.shutdown();

    expect(retaining.getFinishedSpans()).toHaveLength(301);
  });
});
