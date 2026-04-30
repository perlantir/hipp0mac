# Phase 5C Replay

Replay derives state from the event log. It does not invoke models and does
not re-execute write-class or external tools.

The Phase 5C replay helper is `apps/daemon/src/agent/replay.ts`. It consumes
event slices and returns deterministic derived state plus counters proving
that replay performed zero model invocations and zero write/external
re-executions.

Debugging replay divergence:

1. Compare canonical JSON of derived state between baseline and replay.
2. Locate the first differing event digest.
3. Inspect the source event in the encrypted event store.
4. If divergence involves a write or external tool, treat it as a regression:
   replay must use recorded results, not re-execute.
