// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-codex

import {InMemorySpanExporter} from '@opentelemetry/sdk-trace-base';

/** In-memory exporter that keeps finished spans after provider shutdown. */
export class RetainingSpanExporter extends InMemorySpanExporter {
  override shutdown(): Promise<void> {
    return this.forceFlush();
  }
}
