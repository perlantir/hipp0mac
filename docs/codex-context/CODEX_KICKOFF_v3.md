# Codex Kickoff — Read This First (v3)

You are building one sub-phase of a five-phase Enterprise Agent Core for
Operator Dock, a Mac-first autonomous AI agent workspace. The full phase
specification follows this kickoff. Read all of it before writing any
code.

## Critical context — DO NOT MISREAD

This product has an existing codebase from Phases 0-4:
- Monorepo at /apps/mac (SwiftUI), /apps/daemon (TypeScript/Node),
  /packages/protocol (zod schemas), /packages/shared
- Mac app communicates with daemon over localhost HTTP + WebSocket
- SQLite database (in daemon) for tasks, projects, memory, settings,
  schedules, artifacts
- macOS Keychain integration for credentials (Phase 2)
- File tools (fs.*) and shell tool (shell.run) with classification-
  based safety governor and approval flow (Phases 3-4)
- Mac app shells for all major screens (Phase 1)

**Phase 5 builds INSIDE this existing TypeScript/Node daemon.**

It does NOT introduce a Swift helper. It does NOT use XPC. It does NOT
use launchd. It does NOT require SecCodeCheckValidity. It does NOT
require code signing of the daemon.

The Mac app is signed; the daemon is a Node process the Mac app
supervises. That architecture stays. Phase 5 adds capabilities to the
existing daemon, not new daemons or new IPC mechanisms.

If anything in your prior context, training, or instinct suggests a
Swift macOS helper, XPC communication, signed-daemon requirements, or
launchd integration: that suggestion is wrong for this project.
Disregard it. Build into the existing /apps/daemon.

Refer to PHASES_0_TO_4_AUDIT.md for the list of items in the existing
codebase that this phase corrects, extends, or verifies.

## Anti-drift rules — read these carefully

The specs in this project make deliberate architectural decisions.
Some decisions explicitly rule out approaches that you might consider
"more principled" or "future-direction." Those rule-outs are not
defaults that you can override — they are decisions made for reasons
you may not have full context on (existing code investment, team
size, distribution model, scope management).

**Rule 1: If a spec rules something out, you may not implement it.**
This includes implementing it as:
- Scaffolding for "future direction"
- A parallel infrastructure you'll integrate later
- A "temporary bridge" that reproduces the spec's intended approach
  alongside a ruled-out approach
- Optional code paths gated behind config flags
- "Just in case" abstractions

If the spec says "do not introduce X," there is no X in the deliverable.
Period.

**Rule 2: If you believe a spec is wrong, ask before building.**
You may genuinely disagree with a spec. That's fine. The correct path
when you disagree:

1. Stop coding
2. Write a message describing what you'd want to change and why
3. Wait for an answer
4. Proceed based on the answer

The wrong path:
- Building both the spec'd approach and your preferred approach
- Building your preferred approach as scaffolding while keeping the
  spec'd approach working through a "bridge"
- Implementing a hybrid that "leaves the door open"
- Assuming the spec author didn't consider what you're now considering

A 30-minute conversation about architecture is cheaper than days of
work that has to be rolled back.

**Rule 3: When the spec is ambiguous, ask. Don't pick.**
If a spec doesn't clearly say what to do, that's a question, not a
license to choose. Surface the ambiguity in your first message back.

**Rule 4: Scope creep is rejected by default.**
If you find yourself thinking "while I'm in here, I should also..."
— stop. The phase has explicit scope. Items beyond scope go in the
carry-forward section of the sign-off, not into the implementation.

**Rule 5: Honesty in sign-offs.**
Sign-offs distinguish between done, blocked, and deferred. A test
that wasn't run on the real environment because the environment
isn't available is BLOCKED, not passing. A piece of the spec you
didn't implement is DEFERRED, not done. Codex is expected to be
explicit about this distinction. The sign-off is a contract, not a
performance.

## Ground rules — non-negotiable

1. **Read the entire phase spec first.** Do not start coding from the
   first section. The gate criterion at the bottom defines done; the
   tests define correctness; the scope defines what to build. All
   three bind you.

2. **Tests first, then implementation.** For every test listed in
   the spec, write the test before the code it exercises. If a test
   requires fixtures or harnesses, build those first.

3. **The gate criterion is a hard stop.** This phase is not complete
   until every box in the gate criterion is checked with evidence.
   "Mostly working" is not done. Do not declare completion or
   suggest moving to the next phase until every criterion holds.

4. **Every test in the spec is mandatory.** Tests are tagged "unit"
   or "macos-integration." Unit tests run anywhere. macos-integration
   tests run on a macOS runner with real Keychain and filesystem.
   Neither tier may be silently skipped. If a test cannot run in the
   current environment, mark it BLOCKED in the sign-off with a clear
   reason — do not use `.skip` or `xit`.

5. **Schemas are exact.** Where the spec gives a schema, implement
   it field-for-field in /packages/protocol with zod. Field names,
   types, and required-vs-optional distinctions matter. Later phases
   depend on these shapes.

6. **Cross-phase invariants must hold.** This phase builds on earlier
   phases. The README in the spec directory lists invariants that
   must remain true forever once established. If your work would
   break any of them, stop and ask.

7. **Existing systems are extended, not replaced.** Phase 4 safety
   classifier becomes a predicate operator, not garbage. Phase 3 file
   tools get manifests retrofitted, not rewrites. The existing
   approval modal continues to work. Phase 5 augments; it does not
   demolish.

## How to work

- Build in the order the spec presents subsystems. They are ordered
  by dependency.
- After each subsystem, run its tests and confirm they pass before
  moving on. Don't accumulate untested code.
- Commit at logical boundaries (subsystem complete, tests passing).
  Each commit message should reference the spec section it
  implements.
- Maintain documentation files the spec lists as deliverables as you
  go. Don't leave docs for the end.
- Coverage target is 90%+ for new modules in this phase.

## What "production infrastructure" means here

- No silent failures. Every error path is logged, classified, and
  surfaced.
- No "we'll fix it later" comments in code. If it's not done, file
  an issue, don't ship a TODO.
- No hardcoded paths, secrets, or environment assumptions.
- No skipped tests. Tests that cannot run in current environment
  are explicitly BLOCKED in the sign-off, not silently disabled.
- No "works on my machine." If it doesn't work in CI on three
  consecutive runs, it doesn't work.
- No scope creep. New ideas go in carry-forward, not in the
  implementation.

## When you're done with this phase

Produce a sign-off document with:

- Every gate criterion item, marked DONE / BLOCKED / DEFERRED, with
  evidence (test run id, coverage report path, audit notes)
- A list of any deviations from the spec, each with rationale and
  the question that should have been asked before deviating
- A list of carry-forward items: things noticed during this phase
  that the next phase needs to know about
- A list of BLOCKED tests with the reason and unblock condition for
  each

Then stop. Do not begin the next phase. The human driver decides
when to proceed.

---

The phase specification follows below. Read all of it before you
start. If anything in the spec rules out an approach you'd prefer,
that's a decision — see Rule 1. If you genuinely think the spec is
wrong, see Rule 2.

---
