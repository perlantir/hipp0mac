import { ContextPackSchema, type ContextPack, type ContextPackItem } from "@operator-dock/protocol";
import type { EventStore } from "../persistence/eventStore.js";
import { redactText } from "../tools/runtime/secretRedaction.js";
import { wrapUntrustedData } from "./untrustedData.js";

export interface ContextSourceItem {
  itemId: string;
  content: string;
  provenance: {
    source: string;
    eventRef: string;
    includedBecause: string;
    taint: boolean;
  };
}

export interface ContextEngineOptions {
  eventStore?: EventStore;
}

interface UsageRecord {
  itemId: string;
  unusedFor: number;
}

export class ContextEngine {
  private readonly usage = new Map<string, UsageRecord>();

  constructor(private readonly options: ContextEngineOptions = {}) {}

  buildPack(taskId: string, budgetTokens: number, sourceItems: ContextSourceItem[]): ContextPack {
    let items = sourceItems.map((item) => this.contextItem(item));
    let compacted = false;

    while (totalTokens(items) > budgetTokens && items.length > 0) {
      const largest = [...items]
        .filter((item) => !item.compacted)
        .sort((left, right) => right.provenance.tokens - left.provenance.tokens)[0];
      if (largest === undefined) {
        break;
      }
      items = items.map((item) =>
        item.itemId === largest.itemId
          ? compactItem(item)
          : item
      );
      compacted = true;
      if (items.every((item) => item.compacted)) {
        break;
      }
    }

    if (totalTokens(items) > budgetTokens) {
      items = items.sort((left, right) => left.provenance.tokens - right.provenance.tokens);
      while (totalTokens(items) > budgetTokens && items.length > 1) {
        items.pop();
      }
    }

    if (compacted) {
      this.options.eventStore?.append(taskId, "context_compacted", {
        itemRefs: items.map((item) => ({
          itemId: item.itemId,
          eventRef: item.provenance.eventRef,
          rawEventRef: item.rawEventRef ?? item.provenance.eventRef,
          compacted: item.compacted
        }))
      });
    }

    for (const item of items) {
      if (!this.usage.has(item.itemId)) {
        this.usage.set(item.itemId, { itemId: item.itemId, unusedFor: 0 });
      }
    }

    const pack = ContextPackSchema.parse({
      schemaVersion: 1,
      taskId,
      budgetTokens,
      totalTokens: totalTokens(items),
      items
    });
    this.options.eventStore?.append(taskId, "context_pack_built", {
      totalTokens: pack.totalTokens,
      budgetTokens,
      items: pack.items.map((item) => ({
        itemId: item.itemId,
        source: item.provenance.source,
        eventRef: item.provenance.eventRef,
        tokens: item.provenance.tokens,
        taint: item.provenance.taint,
        compacted: item.compacted
      }))
    });
    return pack;
  }

  markUsed(itemId: string): void {
    this.usage.delete(itemId);
  }

  advanceIteration(): void {
    for (const record of this.usage.values()) {
      record.unusedFor += 1;
    }
  }

  unusedForAtLeast(iterations: number): UsageRecord[] {
    return [...this.usage.values()]
      .filter((record) => record.unusedFor >= iterations)
      .sort((left, right) => left.itemId.localeCompare(right.itemId));
  }

  private contextItem(item: ContextSourceItem): ContextPackItem {
    const redacted = redactText(item.content);
    const content = item.provenance.taint
      ? wrapUntrustedData(item.provenance.source, item.provenance.eventRef, redacted)
      : redacted;

    return {
      itemId: item.itemId,
      content,
      provenance: {
        ...item.provenance,
        tokens: estimateTokens(content)
      },
      rawEventRef: item.provenance.eventRef,
      compacted: false
    };
  }
}

function compactItem(item: ContextPackItem): ContextPackItem {
  const content = `[summary:${item.provenance.eventRef}]`;
  return {
    ...item,
    content,
    provenance: {
      ...item.provenance,
      tokens: estimateTokens(content)
    },
    rawEventRef: item.rawEventRef ?? item.provenance.eventRef,
    compacted: true
  };
}

function totalTokens(items: ContextPackItem[]): number {
  return items.reduce((sum, item) => sum + item.provenance.tokens, 0);
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}
