import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ToolApprovalSchema,
  type JsonValue,
  type ToolApproval,
  type ToolRiskLevel
} from "@operator-dock/protocol";
import { ProjectionCipher } from "../../db/projectionCipher.js";

export interface CreateToolApprovalInput {
  executionId: string;
  toolName: string;
  riskLevel: ToolRiskLevel;
  reason: string;
  input: Record<string, JsonValue>;
}

export interface StoredToolApproval extends ToolApproval {
  input: Record<string, JsonValue>;
  token: string;
}

interface ToolApprovalRow {
  id: string;
  execution_id: string;
  tool_name: string;
  risk_level: ToolRiskLevel;
  reason: string;
  status: "pending" | "approved" | "rejected";
  input_json: string;
  token: string;
  created_at: string;
  resolved_at: string | null;
}

export class ToolApprovalStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: ProjectionCipher
  ) {}

  create(input: CreateToolApprovalInput): StoredToolApproval {
    const now = new Date().toISOString();
    const approval: StoredToolApproval = {
      id: randomUUID(),
      executionId: input.executionId,
      toolName: input.toolName,
      riskLevel: input.riskLevel,
      reason: input.reason,
      status: "pending",
      input: input.input,
      token: approvalToken(),
      createdAt: now
    };

    this.database
      .prepare(`
        INSERT INTO tool_approvals (
          id,
          execution_id,
          tool_name,
          risk_level,
          reason,
          status,
          input_json,
          token,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        approval.id,
        approval.executionId,
        approval.toolName,
        approval.riskLevel,
        this.cipher.encrypt(approval.reason),
        approval.status,
        this.cipher.encrypt(JSON.stringify(approval.input)),
        this.cipher.encrypt(approval.token),
        approval.createdAt
      );

    this.database
      .prepare("UPDATE tool_executions SET approval_id = ?, updated_at = ? WHERE id = ?")
      .run(approval.id, now, approval.executionId);

    return approval;
  }

  listPending(): ToolApproval[] {
    const rows = this.database
      .prepare("SELECT * FROM tool_approvals WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as unknown as ToolApprovalRow[];

    return rows.map((row) => publicApproval(row, this.cipher));
  }

  get(id: string): StoredToolApproval | undefined {
    const row = this.database
      .prepare("SELECT * FROM tool_approvals WHERE id = ?")
      .get(id) as ToolApprovalRow | undefined;

    return row === undefined ? undefined : storedApproval(row, this.cipher);
  }

  resolve(id: string, approved: boolean): StoredToolApproval | undefined {
    const existing = this.get(id);
    if (existing === undefined || existing.status !== "pending") {
      return undefined;
    }

    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE tool_approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(approved ? "approved" : "rejected", now, id);

    return this.get(id);
  }
}

function publicApproval(row: ToolApprovalRow, cipher: ProjectionCipher): ToolApproval {
  return ToolApprovalSchema.parse({
    id: row.id,
    executionId: row.execution_id,
    toolName: row.tool_name,
    riskLevel: row.risk_level,
    reason: cipher.decrypt(row.reason),
    status: row.status,
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at })
  });
}

function storedApproval(row: ToolApprovalRow, cipher: ProjectionCipher): StoredToolApproval {
  const approval = publicApproval(row, cipher);
  return {
    ...approval,
    input: JSON.parse(cipher.decrypt(row.input_json)) as Record<string, JsonValue>,
    token: cipher.decrypt(row.token)
  };
}

function approvalToken(): string {
  return randomBytes(24).toString("base64url");
}
