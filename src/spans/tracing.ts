// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

import * as tracing from '@coreweave/forge-sdk/agentlens/tracing';

import type {ResolvedConfig} from '../config.js';

export interface TracingHandle {
  init(): Promise<void>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

let available = Promise.resolve();

export function buildTracing(config: ResolvedConfig): TracingHandle {
  let initPromise: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  return {
    init: () => {
      if (closed) return Promise.reject(new Error('Tracing handle has closed'));
      if (initPromise) return initPromise;

      const previous = available;
      available = new Promise<void>(resolve => {
        release = resolve;
      });
      initPromise = (async () => {
        await previous;
        try {
          await tracing.init(config.projectId, {
            apiKey: config.apiKey,
            serviceName: 'forge-agent-lens-for-codex',
          });
        } catch (error) {
          release?.();
          throw error;
        }
      })();
      return initPromise;
    },
    forceFlush: tracing.forceFlush,
    shutdown: () =>
      (closing ??= (async () => {
        closed = true;
        if (!initPromise) return;
        try {
          await initPromise;
        } catch {
          return;
        }
        try {
          await tracing.shutdown();
        } finally {
          release?.();
        }
      })()),
  };
}
