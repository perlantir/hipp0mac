# Phases 0-4 Audit — Items Needing Attention in Phase 5

This document captures items in the existing codebase (Phases 0-4) that
conflict with, need extension for, or must be verified before Phase 5.

Phase 5 work picks these up as it touches the relevant subsystem. Nothing
here is a separate workstream — these are corrections folded into the
appropriate Phase 5 sub-phase.

==================================================
PHASE 0 — Repo / Daemon / Storage
==================================================

ITEM: HTTP/WS authentication
- Current state: Mac app talks to daemon over localhost HTTP + WebSocket.
  Verify that requests carry a bearer token; verify daemon binds to
  127.0.0.1 only.
- If missing: add a shared secret generated at first daemon start,
  stored in Keychain (reusing Phase 2's Keychain integration), required
  on every HTTP request and WebSocket upgrade.
- Picked up in: Phase 5A (foundation security).

ITEM: SQLite vs event store ownership
- Current state: SQLite holds tasks, projects, memory, settings,
  schedules, artifacts.
- Phase 5 introduces an append-only event store as the source of truth
  for execution history (events, tool calls, verifications, recoveries).
- Resolution:
    SQLite owns: user-facing metadata (task titles, tags, project info,
    memory entries, settings, schedule definitions, artifact descriptors).
    SQLite is an INDEX/CACHE where its data overlaps with execution
    history — never the source of truth for execution.
    Event store owns: every execution event for every task, ordered,
    hash-chained, encrypted, append-only.
    On any conflict between SQLite and event store, event store wins;
    SQLite gets rebuilt from event store.
- Picked up in: Phase 5A (storage layer); Phase 5E (observability
  cross-references both).

ITEM: Filesystem layout
- Phase 3 introduced a user-selected workspace folder for projects,
  tasks output, artifacts.
- Phase 5 needs daemon-owned state (event store, checkpoints, locks,
  encrypted configs) which is NOT user content.
- Resolution: daemon state goes under
    ~/Library/Application Support/OperatorDock/state/
  and is distinct from the user workspace. The workspace remains the
  user's place for content; daemon state is opaque to the user.
- Picked up in: Phase 5A.

==================================================
PHASE 2 — Model Router
==================================================

ITEM: Prompt and model version recording
- Current state: ModelRouter handles chat completion, streaming, tool
  calls, capabilities. Likely does not record promptVersion and
  modelVersion per call.
- Phase 5C requires every model_call_result event to include both, so
  replays and quality analysis can be tied to specific prompt + model
  combinations.
- Resolution: Extend ModelRouter response shape to include modelVersion
  (provider's reported model identifier) and promptVersion (a hash or
  semver of the prompt template used). Caller passes promptVersion;
  router echoes back.
- Picked up in: Phase 5C.

ITEM: Deterministic mock mode
- Current state: real providers only.
- Phase 5C requires a fixture-driven mock provider for tests and evals:
  given a prompt hash, returns a recorded response; missing fixture is
  a test failure that logs the hash for recording.
- Resolution: Add a "mock" provider to ModelRouter that loads fixtures
  from a configured directory. Reused across all unit, integration, and
  eval tests.
- Picked up in: Phase 5C.

ITEM: Model fallback chain
- Current state: each task uses a configured model; no fallback on
  rate_limit / server_error.
- Phase 5C requires per-task fallback chains (e.g., Anthropic primary →
  OpenAI secondary → local tertiary), with model_fallback_used events
  emitted when a fallback is invoked.
- Resolution: Extend ModelRouter to accept a fallback chain. Honor only
  for retryable errors (rate_limit, server_error); never for
  bad_request or auth.
- Picked up in: Phase 5C.

ITEM: Cancellation mid-stream
- Current state: streaming exists; cancellation behavior unclear.
- Phase 5C requires clean cancellation with no orphaned partial state.
- Resolution: Verify and harden cancellation; ensure partial tokens are
  never persisted to events; aborted streams are not retried automatically.
- Picked up in: Phase 5C.

==================================================
PHASE 3 — File Tools
==================================================

ITEM: Tool manifests
- Current state: fs.read, fs.write, fs.append, fs.list, fs.search,
  fs.copy, fs.move, fs.delete exist with workspace boundary safety.
- Phase 5B requires every tool to declare a manifest:
  inputSchema, outputSchema, sideEffectClass, supportsIdempotency,
  filesystemScope, networkScope, approvalPolicy (predicate),
  forbiddenInputPatterns, timeoutPolicy.
- Resolution: Wrap each existing tool with a manifest. Side effect
  classes:
    fs.read    → read
    fs.list    → read
    fs.search  → read
    fs.append  → write-non-idempotent (idempotency key required)
    fs.write   → write-idempotent (xattr-based key check)
    fs.copy    → write-non-idempotent
    fs.move    → write-non-idempotent
    fs.delete  → write-non-idempotent (tombstone keyed by idempotencyKey)
- Picked up in: Phase 5B.

ITEM: Idempotency support
- Current state: tools mutate without idempotency keys.
- Phase 5B requires write-* tools to accept and honor idempotencyKey.
- Resolution: For fs.write, store key as xattr (or sidecar) and dedupe
  re-applies. For fs.append, fs.copy, fs.move, fs.delete, maintain a
  per-tool tombstone log keyed by idempotencyKey so re-execution after
  a crash is safe.
- Picked up in: Phase 5B.

ITEM: Event emission alignment
- Current state: tools emit tool.started, tool.output, tool.completed,
  tool.failed.
- Phase 5B's canonical model is tool_call_intended (before) and
  tool_call_result (after), with strict ordering.
- Resolution: Existing events become a UI-facing projection of the
  canonical events. Internally, every tool call goes through the
  intended/result pair. The UI continues to receive started/output/
  completed/failed for compatibility, derived from the canonical events.
- Picked up in: Phase 5B.

==================================================
PHASE 4 — Shell Tool + Safety Governor
==================================================

ITEM: Safety Governor expressiveness
- Current state: classifies commands as safe / medium / dangerous;
  approval depends on classification + user settings; blocks known
  destructive patterns.
- Phase 5B extends to a predicate AST that can express approval and
  forbidden-action rules over arbitrary tool inputs (not just shell).
- Resolution: Keep existing three-level classification as one class of
  predicate (the legacy classifier becomes an evaluator that produces a
  predicate result). Add the predicate AST for new tools and for plan
  forbiddenActions. The existing classification rules migrate into
  predicate form over time; both work in parallel during migration.
- Picked up in: Phase 5B.

ITEM: shell.run side effect class
- Current state: shell.run runs arbitrary commands.
- Phase 5B classification: external. Per the rules, external tools
  without supportsIdempotency=true must require approval on every call.
- Resolution: shell.run's existing classification-based approval is
  RICHER than blanket approval (some commands don't need approval). This
  is acceptable — keep the existing approval model and treat shell.run
  as external + supportsIdempotency=false + approvalPolicy=existing
  classifier. The classifier's "safe" verdict means approvalPolicy
  evaluates false; "medium"/"dangerous" mean it evaluates true.
- Picked up in: Phase 5B.

ITEM: Approval flow → persistent approvals
- Current state: approval modal supports allow once, always allow in
  project, deny, edit instruction.
- Phase 5E formalizes "persistent approvals" with scope (specific tool
  + input pattern) and expiry.
- Resolution: The existing "always allow in project" IS a persistent
  approval. Formalize its representation as an event with explicit
  scope and (optional) expiry. Extend the approval modal to capture
  scope and expiry where relevant.
- Picked up in: Phase 5E.

ITEM: Approval event semantics
- Current state: daemon emits approval.requested.
- Phase 5B model: a safety_decision event with decision=approval_required
  precedes any pending approval; approval_granted or approval_denied
  follows the user action.
- Resolution: approval.requested becomes a UI-facing projection of
  safety_decision events with decision=approval_required. Granting/
  denying emits the canonical events; UI events follow.
- Picked up in: Phase 5B and 5E.

==================================================
CROSS-CUTTING
==================================================

ITEM: Canonical event types vs UI event types
- Phase 5 introduces a strict canonical event vocabulary in the event
  store. Phases 0-4 emit UI-friendly events over WebSocket.
- Resolution: Canonical events are written to the event store. UI
  events are derived projections, sent over WebSocket. Both must remain
  in sync; the projection is deterministic and tested.
- Picked up in: Phase 5A (event store) and 5E (observability /
  projections).

ITEM: Encryption at rest for existing SQLite
- Current state: SQLite likely unencrypted.
- Phase 5 requires encryption at rest for execution data.
- Resolution: Phase 5A introduces encrypted event store. SQLite
  containing execution-derived data should also be encrypted (SQLCipher
  or equivalent). Phase 5A scope.
- Picked up in: Phase 5A.

ITEM: Logs may contain secrets
- Current state: log redaction policy unclear for Phases 0-4 outputs.
- Phase 5 requires secret redaction across all logs, contexts, and
  traces.
- Resolution: Implement a redaction layer that wraps daemon logging.
  Apply retroactively — verify no existing log path bypasses it.
- Picked up in: Phase 5A.

==================================================
NON-ISSUES (verified compatible)
==================================================

- Mac app screens (Phase 1): all major surfaces exist. Phase 5E fills
  them with real data; no new screens needed.
- ModelRouter role concept (planner/executor/verifier/summarizer/memory
  curator): aligns with Phase 5C's verifier hierarchy and self-improvement
  hook. Reuse the existing roles.
- Workspace folder concept (Phase 3): orthogonal to daemon state; both
  coexist cleanly.
- WebSocket event stream (Phase 0): the right channel for streaming
  observability data to the UI. Phase 5E extends rather than replaces.
