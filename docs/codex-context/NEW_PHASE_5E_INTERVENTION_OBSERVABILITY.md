# Phase 5E: Intervention + Observability + Hardening (TypeScript / Node)

This is the final sub-phase of the Enterprise Agent Core. It delivers the
surfaces a human operator needs to actually use, debug, and trust the
agent, plus the streaming and resilience hardening that ties everything
together.

Do not begin until Phase 5D's gate is fully satisfied.

This phase ends with the Phase 5 release gate. After this, and only
after this, you may begin building features that depend on the agent
core.

==================================================
ARCHITECTURAL CONTEXT
==================================================

Already built:
- Mac app (SwiftUI) with all major screen shells: Home, Tasks,
  Workspace, Projects, Memory, Skills, Integrations, Schedules,
  Artifacts, Settings (Phase 1)
- Approval modal with allow-once / always-in-project / deny / edit
  options (Phase 4)
- WebSocket event stream from daemon to Mac app (Phase 0)
- Reusable components: SidebarItem, CommandComposer, TaskCard,
  StepTimelineCard, ToolCallCard, ArtifactCard, ApprovalModal,
  IntegrationCard, SkillCard, MemoryRecordRow, StatusBadge (Phase 1)

Phase 5E EXTENDS these surfaces with real data from the agent core.
It does NOT introduce new screens; it fills the existing shells.
It DOES add new components within those screens (replay timeline,
diff view, quality breakdown).

==================================================
GOAL
==================================================

Make the agent operable, debuggable, and battle-tested:

- Full human intervention surface (extends existing approval flow)
- Constraint propagation triggering subgraph replan
- Step edits invalidating descendants only
- Streaming model + tool output handling end-to-end
- Full observability: replay, step inspection, run diff, quality
  breakdown, root cause inspection, cross-task search
- End-to-end stress and soak tests
- Sleep/wake cycle resilience proven under load
- Final Phase 5 release gate

==================================================
HUMAN INTERVENTION SURFACE
==================================================

User actions (all emit user_intervention events):

- approve(taskId, decisionId)
- deny(taskId, decisionId, reason?)
- editStep(taskId, stepId, newStep)
- modifyPlan(taskId, planPatch)
- addConstraint(taskId, constraint)
- takeOver(taskId)
- releaseControl(taskId)
- pause(taskId)
- resume(taskId)
- killHard(taskId)
- cancel(taskId)

Each action exposed via:
- HTTP API (daemon, with bearer token from Phase 5A)
- WebSocket commands for real-time UI
- Mac app UI surfaces

Event payload structure:

  user_intervention {
    interventionType,
    actor: { kind: "user", id },
    targetEntity: { kind, id },
    rationale: string?,
    payload: object,                  // type-specific
    appliedAt
  }

==================================================
INTERVENTION SEMANTICS
==================================================

approve / deny:
- Targets a pending safety_decision with approval_required (Phase 5B)
- approve emits approval_granted event; orchestrator resumes loop
- deny emits approval_denied; orchestrator runs Recovery Manager
  with auth_required-equivalent classification (NOT auto-retry of
  same call)
- Existing "always allow in project" UI option (Phase 4) becomes
  persistent_approval_granted with explicit scope (toolName,
  projectId, optional inputPattern) and optional expiry
- The system never auto-creates a persistent approval; only the
  user can opt in via the modal

editStep:
- Replaces step's selectedTool, toolInput, expectedObservation, or
  successCheck
- Validates new step against tool manifest + inputSchema (Phase 5B)
- Marks descendant steps as invalidated (must be replanned per
  Phase 5C)
- Emits plan_revised with the diff
- If task was running, pauses orchestrator until edit applied; then
  resumes with the new step as the next executable

modifyPlan:
- Patch operations: add step, remove step, reorder dependsOn,
  modify successCriteria, modify doneConditions, modify
  forbiddenActions
- Patch validated as a whole: result must be a valid DAG with valid
  references
- Affected subgraph identified; descendants invalidated
- Emits plan_revised

addConstraint:
- Constraint is a Predicate (same AST as Phase 5B)
- Added to plan.constraints AND, if it implies a forbidden action,
  to plan.forbiddenActions
- Triggers re-evaluation of all incomplete steps; any step matching
  the new forbidden predicate is invalidated and the affected
  subgraph replanned
- Emits constraint_added + plan_revised events

takeOver / releaseControl:
- takeOver: task transitions to human_controlled state; agent loop
  pauses; human can manually emit step_selected and tool_call_*
  events via API (with appropriate validation)
- releaseControl: returns to autonomous mode; agent loop resumes
  from current state; existing evidence preserved

pause / resume:
- Phase 5B graceful pause is the foundation; this layer adds the
  user-facing API + UI affordances
- Pause completes the in-flight tool call, then transitions to
  paused
- Resume re-acquires lock, replays orphan reconciliation (defensive
  even after graceful pause), continues loop

killHard:
- SIGKILL-equivalent for the task's runner
- Orphan reconciliation runs on next resume per Phase 5B rules
- Distinct from cancel: killHard expects the user to resume later;
  cancel ends the task

cancel:
- Final state; no resume
- Emits task_cancelled; releases all resources
- Final Output assembled with state = cancelled and partial results

Concurrency considerations:
- All intervention APIs are serialized per task via the same
  concurrency lock used by the agent loop (Phase 5A)
- An intervention may need to wait briefly for the loop to reach a
  safe pause point; the API exposes this via async semantics with a
  configurable timeout

==================================================
STREAMING — END TO END
==================================================

Phase 5C introduced streaming model output; this phase completes the
story for tools and surfaces.

Streaming tool outputs:
- Tools may produce output incrementally (e.g., shell command
  stdout, large file reads, network responses)
- Stream chunks are persisted with sequence numbers in a sidecar
  log per tool_call_intended (NOT in the main event store)
- Sidecar location: state/event-store/<taskId>.streams/<eventId>.log
- Sidecar format: append-only, encrypted, per-chunk integrity hash
- tool_call_result is appended only when stream completes or
  errors; result references the sidecar log
- Crash mid-stream: sidecar may be partial; result is missing →
  treated as orphan per Phase 5B
- Replay: tool is not re-executed; sidecar contents (up to last
  valid chunk) + result event provide deterministic playback

UI streaming:
- Existing WebSocket channel from Phase 0 carries chunks to UI
- UI receives tool.output events as chunks arrive (existing
  Phase 3-4 contract)
- UI subscribes to a task; on subscribe, receives current state
  snapshot, then live updates
- If WebSocket disconnects, UI reconnects and resyncs from latest
  persisted state

Cancellation during stream:
- User pause / kill during model stream: stream aborted; tokens
  generated so far discarded; orphan reconciliation handles cleanup
- User pause / kill during tool stream: tool process signaled
  (SIGTERM then SIGKILL after grace period); sidecar truncated to
  last valid chunk; orphan reconciliation handles result

==================================================
OBSERVABILITY
==================================================

Required surfaces in the Mac app, each fills part of an existing
screen shell:

1. Tasks screen (existing) — extended to show:
   - Filter by state, score range, date range, project
   - Sort by recency, overallScore, duration
   - Indexed via SQLite for fast query

2. Task detail (existing) — replay view:
   - Step-by-step playback of any task
   - Each event shown with: type, timestamp, payload, related
     events (parent, child)
   - For tool calls: input, output, idempotency key, side effect
     class, safety decision
   - For model calls: prompt (with sentinel blocks rendered),
     output, tokens, model version
   - For verifications: passed/failed, evidence refs (clickable to
     source events), issues found
   - For recovery: failure type, strategy chosen, retry count
   - Time-travel: navigate to any point in the task's history

3. Step inspection (within task detail):
   - For any selected step: full lineage (which events produced its
     inputs, which events consumed its outputs)
   - All verifier passes for the step
   - All recovery attempts touching the step

4. Run diff view (Tasks screen):
   - Side-by-side comparison of two task runs (typically original +
     auto-rerun)
   - Aligned by step intent / tool / outcome
   - Highlights: structural differences, metric differences,
     decision differences

5. Quality breakdown (within task detail):
   - QualityReport rendered with each metric explained
   - Per-metric provenance: which events contributed to numerator
     and denominator
   - Weight redistribution shown when N/A metrics present
   - Threshold comparison (passed / failed each threshold)

6. Root cause inspection (within task detail, for failed/low-score):
   - The rootCauseIfLowScore classification
   - The events that led to it
   - The recommendedFixes with their evidenceRefs as deep links

7. Cross-task search (Tasks screen):
   - Search across all tasks by:
       - eventType
       - tool name + version
       - failure type
       - score range
       - taskType
       - text in goal / artifacts
   - Useful for triage ("show me all tasks where shell.run timed
     out last week")

API endpoints (HTTP, all require bearer token from Phase 5A):

  GET  /tasks?filter=&sort=&page=
  GET  /tasks/:id/events?from=&to=&types=
  GET  /tasks/:id/replay?atEventId=
  GET  /tasks/diff?a=&b=
  GET  /tasks/:id/quality
  GET  /events/search?q=

WebSocket channels (existing channel extended):

  /ws/tasks/:id/live           live event stream (existing)
  /ws/tasks/:id/replay         scrubbing replay events

Performance targets:
- listTasks: < 100ms for first page across 10k tasks
- getEvents: streaming, < 50ms time-to-first-byte
- search: < 1s for indexed fields across 100k events
- An SQLite index file mirrors searchable fields; rebuilt on demand
  if missing or stale (rebuild from event store, the source of
  truth)

All endpoints respect encryption-at-rest: data is decrypted in
daemon, served over authenticated WebSocket/HTTP; UI never sees raw
ciphertext.

==================================================
HARDENING
==================================================

Sleep / wake under load:
- Tasks may be running when system sleeps
- On sleep:
    - Daemon receives sleep notification (via Mac app bridge or
      direct OS hook)
    - In-flight tool calls signaled to pause where supported
    - Otherwise allowed to complete or be interrupted by sleep
    - Heartbeats paused
- On wake:
    - Daemon re-reads Keychain entries
    - Locks verified still owned (timestamp comparison)
    - Orphan reconciliation runs for any interrupted calls
    - Heartbeats resume
    - WebSocket clients reconnect to live streams

Daemon crash under load:
- Process supervisor (Mac app or launchd) restarts daemon
- Startup sequence: load keys → reconcile stale locks → reconcile
  orphans → resume tasks → accept new connections
- Tasks resume from latest checkpoint + event replay
- No double execution (verified by Phase 5B tests)

Disk pressure:
- Event store grows unboundedly per task; address via:
    - Compaction policy (after task completion, optionally archive
      old events to compressed format)
    - User-initiated archive / delete from Tasks screen
    - Disk space monitoring with warning thresholds
- Encryption preserved through any compaction / archival

Memory pressure:
- Streaming sidecars and large context packs are file-backed, not
  memory-resident
- Daemon RSS bounded; large data stays on disk

Clock changes:
- All event timestamps use monotonic clock for ordering within a
  task; wall clock for display
- Clock jumps (NTP sync, manual change) do not corrupt ordering

==================================================
TESTS THAT MUST PASS
==================================================

All Phase 5A, 5B, 5C, 5D tests must continue to pass.

INTERVENTION — APPROVALS  (macos-integration)

- approve_resumes_loop: pending approval, approve, loop continues,
  tool runs
- deny_runs_recovery: pending approval, deny, recovery_decision
  emitted, no tool execution
- approve_targets_specific_decision: only the targeted decision is
  granted; other pending decisions unaffected
- single_use_approval: approval granted once; later identical
  request requires fresh approval
- persistent_approval_honored: user-marked persistent approval with
  scope auto-grants matching subsequent requests until expiry
- persistent_approval_scoped: out-of-scope subsequent request still
  requires fresh approval
- existing_phase_4_approval_modal_still_works: regression

INTERVENTION — STEP EDITS  (macos-integration)

- edit_step_invalidates_descendants_only
- edit_step_validates_against_manifest
- invalid_edit_rejected: malformed or scope-violating edit refused
- edited_step_runs_after_resume

INTERVENTION — PLAN MODIFICATION  (unit + macos-integration)

- add_step_validates_dag
- remove_step_invalidates_dependents
- reorder_dependsOn_recomputes_executable_set
- modify_done_conditions_revisits_goal_verifier_state
- invalid_patch_rejected_atomically

INTERVENTION — CONSTRAINTS  (unit + macos-integration)

- constraint_invalidates_matching_steps
- constraint_does_not_affect_completed_evidence
- constraint_persisted_in_plan
- constraint_emits_plan_revised

INTERVENTION — TAKE OVER / RELEASE  (macos-integration)

- takeover_pauses_loop
- human_actions_logged_with_actor
- release_resumes_loop_from_current_state

INTERVENTION — PAUSE / RESUME / KILL / CANCEL  (macos-integration)

- pause_completes_in_flight
- resume_runs_orphan_reconciliation
- killHard_then_resume_no_double_effect: across all
  sideEffectClasses
- cancel_terminal: after cancel, resume rejected; final output
  produced with state = cancelled
- intervention_serialized: 10 simultaneous intervention requests on
  one task processed in a defined order with no corruption

STREAMING  (macos-integration)

- tool_stream_sidecar_persisted: chunks written, sequence numbers
  monotonic
- tool_stream_crash_truncates_cleanly
- tool_stream_replay_deterministic
- model_stream_no_partial_tokens_in_events: across 100 model calls
- ui_stream_reconnect: WebSocket disconnects mid-stream, reconnects,
  observes correct state
- cancel_during_tool_stream

OBSERVABILITY  (macos-integration)

- replay_view_correct: random task replayed step-by-step;
  reconstructed state at each point matches event-store-derived
  state
- step_inspection_lineage_correct
- run_diff_aligns_correctly
- quality_breakdown_provenance: each metric's claimed contributing
  events are real and sufficient to compute the metric
- root_cause_links_resolve
- search_indexed_fields_fast: < 1s for 100k events
- search_index_rebuild_from_event_store: delete index, query
  triggers rebuild from event store, results correct
- raw_ciphertext_never_leaves_daemon

HARDENING — SLEEP / WAKE  (macos-integration)

- sleep_wake_mid_tool_call_resumes
- sleep_wake_mid_model_call_resumes
- sleep_wake_does_not_lose_lock
- keys_readable_after_wake (regression of 5A test under load)

HARDENING — DAEMON CRASH UNDER LOAD  (macos-integration)

- daemon_crash_with_10_active_tasks: kill daemon while 10 tasks are
  mid-execution; restart; all 10 tasks resume correctly
- crash_during_intervention_processing: kill during intervention
  apply; on restart, intervention is either fully applied or fully
  rolled back (atomic)

HARDENING — DISK / MEMORY  (macos-integration)

- disk_full_handled_gracefully
- task_archive_round_trip
- daemon_rss_bounded: under sustained load (100 tasks, scaled-down
  events for CI), daemon RSS stays under documented ceiling

HARDENING — CLOCK  (unit)

- clock_jump_forward_safe
- clock_jump_backward_safe

INTEGRATION — END-TO-END SCENARIOS  (macos-integration)

- happy_path_with_full_intervention: real-time UI receives stream;
  user pauses; user adds constraint; user resumes; task completes
  with revised plan
- approval_flow_real_time: external tool requires approval; user
  notified; user approves; task continues
- intervention_storm: 50 interventions across a task lifecycle
- soak_24_hour: 100 tasks running over 24 hours with random
  interventions, sleep/wake, and daemon restarts; zero corruption,
  zero double effects, all final outputs valid (CI may run
  scaled-down version; full version run before release gate
  sign-off)
- replay_consistency_across_full_corpus: replay every test corpus
  task; 100% byte-identical state reconstruction

==================================================
PHASE 5 RELEASE GATE
==================================================

This is the master release gate. ALL must hold:

CORE GATES (must all be true)

[ ] Every Phase 5A, 5B, 5C, 5D test passes
[ ] Every Phase 5E test passes
[ ] All tests pass on three consecutive CI runs
[ ] Safety evals pass at 100%
[ ] Injection eval set passes at 100%
[ ] Replay consistency: 100% byte-identical across full corpus
[ ] No uncontrolled loops in stress tests
[ ] No unclassified failures (unknown rate < 1% of induced
    failures)
[ ] No unredacted secrets in any trace, log, or checkpoint (verified
    by automated scanner across full corpus)
[ ] Recovery system proven across every failure type
[ ] Behavioral Quality System emits valid QualityReport for every
    completed task
[ ] Eval mode reliably fails low-quality technically-passing
    behavior across the eval suite
[ ] Daemon survives crash, restart, sleep/wake, hard kill, disk
    pressure without duplicate side effects
[ ] Schema versioning + migration tested end-to-end
[ ] All intervention surfaces functional and tested
[ ] All observability surfaces functional and performance targets
    met
[ ] All Phase 0-4 regression suites still pass

24-HOUR SOAK (must pass full version, not scaled-down)

[ ] 100 mock tasks running concurrently over 24 hours
[ ] Random interventions injected throughout
[ ] At least 5 simulated sleep/wake cycles
[ ] At least 5 simulated daemon crashes
[ ] At least 50 simulated tool / model errors
[ ] Final state: all tasks either completed, failed (with valid
    failure_output), or cancelled (with valid cancelled output);
    zero stuck or corrupted; zero secret leaks; zero unclassified
    failures; zero replay divergences

MANUAL AUDITS (signed off)

[ ] Security audit: encryption at rest verified; bearer token auth
    verified; localhost-only binding verified; Keychain access
    classes correct; no plaintext secrets anywhere
[ ] Safety audit: every malicious payload in injection eval set
    handled correctly; every forbidden shell command denied;
    every out-of-scope filesystem access denied; Phase 4 legacy
    classifier behavior preserved
[ ] Idempotency audit: for fs.delete, fs.append, and shell.run,
    manual crash injection produces zero double effects (or
    correct blocked state for shell.run)
[ ] Observability audit: replay any random task and reconstruct
    its history; root cause inspection for every failed task in
    test corpus produces actionable analysis

COVERAGE

[ ] Aggregate test coverage across all Phase 5 modules ≥ 90%

DOCUMENTATION COMPLETE

[ ] state/README.md
[ ] EVENT_STORE.md
[ ] SCHEMA_MIGRATIONS.md
[ ] SECURITY.md
[ ] HOW_TO_ADD_A_TOOL.md
[ ] SAFETY_PREDICATES.md
[ ] RECONCILIATION.md
[ ] RETROFIT_NOTES.md
[ ] PROMPT_TEMPLATES.md
[ ] INJECTION_DEFENSE.md
[ ] VERIFIER_DESIGN.md
[ ] REPLAY.md
[ ] FAILURE_TAXONOMY.md
[ ] RECOVERY_STRATEGIES.md
[ ] QUALITY_METRICS.md
[ ] EVAL_MODE.md
[ ] SELF_IMPROVEMENT.md
[ ] OBSERVABILITY.md (this phase)
[ ] OPERATIONS.md (this phase: deploy, monitor, recover, archive)

Until every box is checked, no work begins on Phase 6 or later.
The agent core is production infrastructure. It either holds the
line or it doesn't.

==================================================
DELIVERABLES
==================================================

- Source code: full intervention API + UI bindings, streaming
  pipeline (model + tool sidecars), observability layer (replay,
  inspection, diff, search), hardening fixes, sleep/wake handlers,
  archive tooling
- Mac app extensions: replay timeline component, diff view,
  quality breakdown component, root cause panel, search UI
- Test suite for all Phase 5E tests + the 24-hour soak harness
- Documentation:
    - OBSERVABILITY.md (surfaces, APIs, performance targets)
    - OPERATIONS.md (deployment, monitoring, common recovery
      procedures, archive/restore)
- Final architecture summary covering the complete agent core
- Phase 5 Release Gate sign-off document with each criterion
  checked and evidence (test run id, audit report id, etc.)
