# How To Add A Tool

Phase 5B tools run only through the daemon `ToolRuntime`. A tool is not
eligible to execute until it has a schema-valid capability manifest and is
registered at daemon startup.

## Required Pieces

Add three things together:

1. A zod input schema and output schema in `packages/protocol` or the
   daemon module that owns the tool.
2. A `ToolCapabilityManifest` with `schemaVersion: 1`.
3. A `ToolDefinition` whose `manifest`, zod schemas, and `execute`
   function describe the same behavior.

The runtime validates input before safety, runs the Safety Governor,
checks budgets, appends `tool_call_intended`, invokes the function, and
then appends `tool_call_result`.

## Manifest Rules

The manifest is the execution contract:

- `pure`: no I/O, no idempotency key.
- `read`: reads state, no mutation, no idempotency key.
- `write-idempotent`: requires an idempotency key.
- `write-non-idempotent`: requires an idempotency key and
  `supportsIdempotency: true`.
- `external`: requires an idempotency key. If
  `supportsIdempotency: false`, `approvalPolicy` must be `{ "op":
  "always" }`.

Filesystem and network scopes are enforced mechanically. A tool with
`filesystemScope.mode: "workspace"` cannot access paths outside the
configured workspace. A tool with `networkScope.mode: "explicit"` can
only access manifest hosts plus request-scoped allowlisted hosts.

## Idempotency

Write and external tools receive `context.idempotencyKey`. Reuse that key
for retries of the same logical call.

Tools that can answer whether a key applied should implement
`statusQuery(idempotencyKey)`. Reconciliation uses that query to
synthesize a `tool_call_result` after a crash if the side effect already
applied.

Filesystem mutation tools use durable logs for status queries. `fs.append`
uses per-file append logs under `state/tool-tombstones/fs.append/`;
`fs.copy` and `fs.move` use tombstone logs at
`state/tool-tombstones/fs.copy.log` and
`state/tool-tombstones/fs.move.log`.

## Required Tests

Each new tool needs tests for:

- manifest registration
- happy path
- input schema rejection before safety
- safety denial for forbidden input and scope violations
- approval pause/resume if approval can be required
- output schema failure
- timeout default and max enforcement
- idempotency replay for write/external tools
- orphan reconciliation behavior for its side-effect class
