// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

import {beforeEach, describe, expect, it, vi} from 'vitest';

const sdk = vi.hoisted(() => ({
  init: vi.fn<(project: string) => Promise<void>>(),
  forceFlush: vi.fn<() => Promise<void>>(),
  shutdown: vi.fn<() => Promise<void>>(),
}));

vi.mock('@coreweave/forge-sdk/agentlens/tracing', () => sdk);

import type {ResolvedConfig} from '../config.js';
import {buildTracing} from './tracing.js';

const config = (project: string): ResolvedConfig => ({
  apiKey: 'key',
  projectId: `entity/${project}`,
  entity: 'entity',
  project,
  providerName: 'openai',
  includeContent: true,
  debug: false,
});

describe('buildTracing', () => {
  beforeEach(() => {
    sdk.init.mockReset().mockResolvedValue(undefined);
    sdk.forceFlush.mockReset().mockResolvedValue(undefined);
    sdk.shutdown.mockReset().mockResolvedValue(undefined);
  });

  it('keeps each caller on the global provider until it shuts down', async () => {
    const first = buildTracing(config('first'));
    const second = buildTracing(config('second'));

    await first.init();
    const secondInit = second.init();
    await Promise.resolve();

    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init).toHaveBeenLastCalledWith(
      'entity/first',
      expect.any(Object)
    );

    await first.shutdown();
    await secondInit;
    expect(sdk.init).toHaveBeenCalledTimes(2);
    expect(sdk.init).toHaveBeenLastCalledWith(
      'entity/second',
      expect.any(Object)
    );
    await second.shutdown();
  });

  it('lets the next caller proceed when initialization fails', async () => {
    sdk.init.mockRejectedValueOnce(new Error('init failed'));
    const failed = buildTracing(config('failed'));
    const next = buildTracing(config('next'));

    await expect(failed.init()).rejects.toThrow('init failed');
    await next.init();

    expect(sdk.init).toHaveBeenLastCalledWith(
      'entity/next',
      expect.any(Object)
    );
    await next.shutdown();
  });

  it('releases ownership when provider shutdown fails', async () => {
    sdk.shutdown.mockRejectedValueOnce(new Error('shutdown failed'));
    const failed = buildTracing(config('failed'));
    const next = buildTracing(config('next'));

    await failed.init();
    const nextInit = next.init();
    await expect(failed.shutdown()).rejects.toThrow('shutdown failed');
    await nextInit;

    expect(sdk.init).toHaveBeenLastCalledWith(
      'entity/next',
      expect.any(Object)
    );
    await next.shutdown();
  });

  it('does not reserve ownership before initialization starts', async () => {
    buildTracing(config('unused'));
    const used = buildTracing(config('used'));

    await used.init();

    expect(sdk.init).toHaveBeenCalledOnce();
    expect(sdk.init).toHaveBeenCalledWith('entity/used', expect.any(Object));
    await used.shutdown();
  });

  it('finishes a pending initialization before shutdown', async () => {
    const first = buildTracing(config('first'));
    const second = buildTracing(config('second'));

    await first.init();
    const secondInit = second.init();
    const secondShutdown = second.shutdown();
    await Promise.resolve();
    expect(sdk.init).toHaveBeenCalledTimes(1);

    await first.shutdown();
    await secondInit;
    await secondShutdown;

    expect(sdk.init).toHaveBeenCalledTimes(2);
    expect(sdk.shutdown).toHaveBeenCalledTimes(2);
  });
});
