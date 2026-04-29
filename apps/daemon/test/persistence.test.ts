import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedRecordCodec } from "../src/persistence/encryptedRecordCodec.js";
import { EventStore } from "../src/persistence/eventStore.js";
import { CheckpointStore } from "../src/persistence/checkpointStore.js";
import { LockController, LockHeldError } from "../src/persistence/lockController.js";
import {
  encryptionKeyAccount,
  hmacKeyAccount,
  MemoryPersistenceKeychainClient,
  PersistenceKeyManager,
  persistenceKeyAccessClass
} from "../src/persistence/persistenceKeys.js";
import { OperatorDockPaths } from "../src/persistence/paths.js";
import { migrationKey, SchemaMigrationManager, UnknownFutureSchemaVersionError } from "../src/persistence/schemaMigration.js";
import { TaskMetadataStore } from "../src/persistence/taskMetadataStore.js";
import { tempRoot } from "./harness.js";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  tempRoots.clear();
});

function makeRoot(prefix: string): string {
  const root = tempRoot(prefix);
  tempRoots.add(root);
  return root;
}

async function harness(prefix = "operator-dock-node-persistence-") {
  const root = makeRoot(prefix);
  const paths = new OperatorDockPaths(root);
  paths.createLayout();
  const keys = await new PersistenceKeyManager(new MemoryPersistenceKeychainClient()).loadOrCreateKeys();
  const eventStore = new EventStore(paths, keys);
  return { root, paths, keys, eventStore };
}

describe("Node Phase 5A persistence foundation", () => {
  it("generates encryption and HMAC keys with required access class", async () => {
    const keychain = new MemoryPersistenceKeychainClient();

    const keys = await new PersistenceKeyManager(keychain).loadOrCreateKeys();

    expect(keys.encryptionKey).toHaveLength(32);
    expect(keys.hmacKey).toHaveLength(32);
    expect(keychain.accessClassFor("OperatorDock.encryption.master")).toBe("kSecAttrAccessibleAfterFirstUnlock");
    expect(keychain.accessClassFor("OperatorDock.signing.hmac")).toBe("kSecAttrAccessibleAfterFirstUnlock");
  });

  it("fails closed when persistence keys are unavailable", async () => {
    const keychain = new MemoryPersistenceKeychainClient({ failReads: true });

    await expect(new PersistenceKeyManager(keychain).loadOrCreateKeys()).rejects.toThrow("Keychain unavailable");
  });

  it("reuses existing persistence keys and rejects malformed key material", async () => {
    const keychain = new MemoryPersistenceKeychainClient();
    const encryptionKey = Buffer.alloc(32, 0x10);
    const hmacKey = Buffer.alloc(32, 0x20);
    await keychain.set(encryptionKeyAccount, encryptionKey, persistenceKeyAccessClass);
    await keychain.set(hmacKeyAccount, hmacKey, persistenceKeyAccessClass);

    const keys = await new PersistenceKeyManager(keychain).loadOrCreateKeys();

    expect(keys.encryptionKey).toEqual(encryptionKey);
    expect(keys.hmacKey).toEqual(hmacKey);

    await keychain.set(encryptionKeyAccount, Buffer.alloc(12), persistenceKeyAccessClass);
    await expect(new PersistenceKeyManager(keychain).loadOrCreateKeys()).rejects.toThrow("Invalid persistence key length");
  });

  it("append then read preserves order and encrypted raw logs contain no plaintext", async () => {
    const { paths, eventStore } = await harness();
    const taskId = "task-append-read";

    const ids = [
      eventStore.append(taskId, "task_created", { title: "top secret task" }),
      eventStore.append(taskId, "task_state_transition", { state: "paused" }),
      eventStore.append(taskId, "task_state_transition", { state: "completed" })
    ];

    const events = eventStore.readAll(taskId);
    expect(events.map((event) => event.eventId)).toEqual(ids);
    expect(events.map((event) => event.payload)).toEqual([
      { title: "top secret task" },
      { state: "paused" },
      { state: "completed" }
    ]);
    expect(eventStore.verify(taskId).ok).toBe(true);
    expect(eventStore.readSince(taskId, ids[0]!)).toHaveLength(2);
    expect(readFileSync(paths.eventLog(taskId), "utf8")).not.toContain("top secret task");
  });

  it("detects HMAC tampering at the correct event id", async () => {
    const { keys, paths, eventStore } = await harness();
    const taskId = "task-hmac-tamper";
    eventStore.append(taskId, "task_created", { index: 1 });
    const targetEventId = eventStore.append(taskId, "task_state_transition", { index: 2 });

    const records = EncryptedRecordCodec.readRecords(paths.eventLog(taskId), keys);
    const tampered = { ...records[1]!.plaintext, hmac: "0".repeat(64) };
    EncryptedRecordCodec.rewriteRecords(paths.eventLog(taskId), keys, [
      records[0]!.plaintext,
      tampered
    ]);

    expect(() => eventStore.verify(taskId)).toThrow(targetEventId);
  });

  it("truncates a torn final event record and preserves the valid chain", async () => {
    const { paths, eventStore } = await harness();
    const taskId = "task-torn-write";
    eventStore.append(taskId, "task_created", { ok: true });
    const before = readFileSync(paths.eventLog(taskId));
    writeFileSync(paths.eventLog(taskId), Buffer.concat([before, Buffer.from([0, 0, 4, 0, 1, 2])]));

    const recovery = eventStore.recoverTaskLog(taskId);

    expect(recovery.truncated).toBe(true);
    expect(eventStore.verify(taskId).ok).toBe(true);
    expect(eventStore.readAll(taskId)).toHaveLength(1);
  });

  it("generates monotonic UUIDv7 event ids", async () => {
    const { eventStore } = await harness();
    const taskId = "task-monotonic";
    const ids = Array.from({ length: 100 }, (_, index) => (
      eventStore.append(taskId, "task_state_transition", { index })
    ));

    expect([...ids].sort()).toEqual(ids);
  });

  it("writes and recovers checkpoints without making them authoritative", async () => {
    const { eventStore, paths, keys } = await harness();
    const checkpoints = new CheckpointStore(paths, keys, eventStore);
    const taskId = "task-checkpoints";
    const eventId = eventStore.append(taskId, "task_created", { title: "checkpoint" });

    checkpoints.writeCheckpoint(taskId, eventId, { counter: 1 });
    expect(checkpoints.latestCheckpoint(taskId)?.derivedState).toEqual({ counter: 1 });
    expect(checkpoints.loadCheckpoint(taskId, eventId)?.derivedState).toEqual({ counter: 1 });
    expect(checkpoints.latestCheckpoint("task-without-checkpoints")).toBeNull();

    writeFileSync(paths.checkpoint(taskId, eventId), Buffer.from("corrupt"));
    expect(checkpoints.latestCheckpoint(taskId)).toBeNull();
    expect(eventStore.readAll(taskId).map((event) => event.eventType)).toEqual([
      "task_created",
      "checkpoint_written"
    ]);
  });

  it("enforces exclusive task locks and reclaims stale locks safely", async () => {
    const { eventStore, paths } = await harness();
    const first = new LockController(paths, eventStore, {
      daemonInstanceId: "daemon-a",
      staleAfterMs: 60_000,
      reclaimDelayMs: 1
    });
    const second = new LockController(paths, eventStore, {
      daemonInstanceId: "daemon-b",
      staleAfterMs: 60_000,
      reclaimDelayMs: 1
    });

    const handle = first.acquire("task-lock");
    expect(() => second.acquire("task-lock")).toThrow(LockHeldError);

    const stale = JSON.parse(readFileSync(paths.lockFile("task-lock"), "utf8")) as Record<string, unknown>;
    stale.lastHeartbeat = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(paths.lockFile("task-lock"), JSON.stringify(stale));
    const reclaimed = await second.acquire("task-lock");

    expect(reclaimed.daemonInstanceId).toBe("daemon-b");
    second.heartbeat(reclaimed);
    expect(JSON.parse(readFileSync(paths.lockFile("task-lock"), "utf8")).daemonInstanceId).toBe("daemon-b");
    second.release(reclaimed);
    expect(eventStore.readAll("task-lock").map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["lock_acquired", "lock_reclaimed", "lock_released"])
    );
    expect(() => first.release(handle)).toThrow("Lock is not owned");
  });

  it("creates the daemon state layout under Application Support and migrates v0 state", () => {
    const home = makeRoot("operator-dock-node-state-");
    const legacyRoot = join(home, ".operator-dock");
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, "operator-dock.sqlite"), "legacy-db");

    const paths = OperatorDockPaths.production({ home });

    expect(paths.root).toBe(join(home, "Library", "Application Support", "OperatorDock", "state"));
    expect(existsSync(join(paths.root, "operator-dock.sqlite"))).toBe(true);
    expect(existsSync(join(paths.root, ".migrated-from-v0"))).toBe(true);
    expect(existsSync(legacyRoot)).toBe(false);
  });

  it("migrates a synthetic v0 fixture to v1 and emits schema migration events once", async () => {
    const { eventStore } = await harness();
    const manager = new SchemaMigrationManager(
      1,
      new Map([
        [migrationKey(0, 1), (record) => ({
          schemaVersion: 1,
          title: record.name,
          migrated: true
        })]
      ]),
      eventStore
    );

    const first = manager.migrate("task-migration", {
      schemaVersion: 0,
      name: "legacy fixture"
    });
    const second = manager.migrate("task-migration", {
      schemaVersion: 0,
      name: "legacy fixture"
    });

    expect(first).toEqual(second);
    expect(first).toEqual({
      schemaVersion: 1,
      title: "legacy fixture",
      migrated: true
    });
    expect(eventStore.readAll("task-migration").map((event) => event.eventType)).toEqual([
      "schema_migration_applied"
    ]);
  });

  it("hard-errors on unknown future schema versions", async () => {
    const { eventStore } = await harness();
    const manager = new SchemaMigrationManager(1, new Map(), eventStore);

    expect(() => manager.migrate("task-future", { schemaVersion: 99 })).toThrow(UnknownFutureSchemaVersionError);
  });

  it("persists encrypted task metadata and mirrors state transitions to the event store", async () => {
    const { eventStore, paths, keys } = await harness();
    const metadata = new TaskMetadataStore(paths, keys, eventStore);

    const created = metadata.create("task-metadata");
    const paused = metadata.transition("task-metadata", "paused");
    const completed = metadata.transition("task-metadata", "completed");

    expect(created.state).toBe("created");
    expect(paused.state).toBe("paused");
    expect(completed.state).toBe("completed");
    expect(metadata.get("task-metadata")?.state).toBe("completed");
    expect(readFileSync(join(paths.tasksRoot, "task-metadata.json"))).not.toContain(Buffer.from("completed"));
    expect(eventStore.readAll("task-metadata").map((event) => event.eventType)).toEqual([
      "task_created",
      "task_state_transition",
      "task_state_transition"
    ]);
  });
});
