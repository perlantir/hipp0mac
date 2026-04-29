# Safety Predicates

Phase 5B safety predicates are deterministic AST nodes. They are
evaluated against post-schema-validation tool input. No model is involved.

## AST

```json
{ "op": "always" }
{ "op": "never" }
{ "op": "and", "clauses": [] }
{ "op": "or", "clauses": [] }
{ "op": "not", "clause": {} }
{ "op": "match", "path": "command", "regex": "sudo" }
{ "op": "equals", "path": "mode", "value": "fast" }
{ "op": "in", "path": "host", "values": ["example.com"] }
{ "op": "pathOutsideScope", "inputPath": "path", "scope": "filesystem" }
```

`path` is a minimal JSONPath-like selector. Both `command` and
`$.command` are accepted for top-level fields.

## Evaluation Order

The Safety Governor evaluates in this order:

1. `forbiddenInputPatterns`; any match is a terminal deny.
2. Manifest filesystem and network scope checks; any violation is a
   terminal deny.
3. `approvalPolicy`; a match returns `approval_required`.
4. Otherwise the call is allowed.

Every decision appends a canonical `safety_decision` event before any
`tool_call_intended` event. The event stores the decision, matched
predicate if any, scope violation if any, and a SHA-256 input digest
instead of raw input.

## Examples

Shell root delete denial:

```json
{
  "op": "match",
  "path": "command",
  "regex": "(^|[;&|]\\s*)rm\\s+-(?:[A-Za-z]*r[A-Za-z]*f|[A-Za-z]*f[A-Za-z]*r)\\s+/"
}
```

Always require approval:

```json
{ "op": "always" }
```

Workspace path guard:

```json
{
  "op": "pathOutsideScope",
  "inputPath": "path",
  "scope": "filesystem"
}
```
