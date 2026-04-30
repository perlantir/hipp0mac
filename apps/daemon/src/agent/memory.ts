import { randomUUID } from "node:crypto";
import type {
  JsonValue,
  MemoryRef,
  MemoryWriteProposal
} from "@operator-dock/protocol";
import { MemoryWriteProposalSchema } from "@operator-dock/protocol";
import type { EventStore } from "../persistence/eventStore.js";

export interface MemoryTaskContext {
  taskId: string;
}

export class StubMemoryInterface {
  private readonly proposals = new Map<string, MemoryWriteProposal>();

  constructor(private readonly eventStore: EventStore) {}

  async retrieve(query: string, taskContext: MemoryTaskContext): Promise<MemoryRef[]> {
    this.eventStore.append(taskContext.taskId, "memory_retrieve", {
      query,
      count: 0
    });
    return [];
  }

  async proposeWrite(item: JsonValue, provenance: { taskId: string } & Record<string, JsonValue>): Promise<MemoryWriteProposal> {
    const proposal = MemoryWriteProposalSchema.parse({
      proposalId: randomUUID(),
      item,
      provenance,
      status: "proposed"
    });
    this.proposals.set(proposal.proposalId, proposal);
    this.eventStore.append(provenance.taskId, "memory_propose_write", {
      proposalId: proposal.proposalId
    });
    return proposal;
  }

  async commitWrite(proposalId: string, approval: boolean): Promise<string> {
    const proposal = this.proposals.get(proposalId);
    const taskId = typeof proposal?.provenance.taskId === "string" ? proposal.provenance.taskId : "memory";
    this.eventStore.append(taskId, "memory_commit_write", {
      proposalId,
      approval,
      memoryId: proposalId
    });
    return proposalId;
  }

  async delete(memoryId: string, taskContext: MemoryTaskContext): Promise<void> {
    this.eventStore.append(taskContext.taskId, "memory_delete", {
      memoryId
    });
  }
}
