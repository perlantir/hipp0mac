# Phase 5C Verifier Design

Phase 5C has three verifier roles:

- StepVerifier runs after meaningful steps and checks the step success
  predicate against tool output.
- GoalVerifier runs before completion and independently checks every success
  criterion and done condition.
- Double verification runs StepVerifier twice for external steps, critical
  steps, tainted steps, and irreversible write-class steps.

No verifier may pass on confidence alone. A passing StepVerifier must contain
at least one `evidenceRefs` entry. A passing GoalVerifier requires every
criterion and done condition to be met with evidence refs.

Disagreement in double verification halts the Phase 5C loop. Phase 5D wires
that halt into structured recovery.
