# Phase 5C Injection Defense

Untrusted data is any byte returned by a tool, fetched from a network source,
or read from externally controlled content. Before untrusted content reaches a
prompt, `ContextEngine` wraps it with:

```xml
<untrusted_data source="..." event="...">
...
</untrusted_data>
```

The heuristic detector in `apps/daemon/src/agent/untrustedData.ts` flags:

- attempts to ignore or replace instructions
- role or system-prompt mimicry
- embedded role tags such as `<system>` and `[INST]`
- goal hijacks such as “your real task is”
- attempts to introduce new tools
- false authority claims
- references to forbidden actions

Positive detection emits `injection_detected` and Phase 5C halts with
`agent_loop_halted`. Phase 5D will replace this halt with Recovery Manager
strategy selection.

The curated eval set lives in `state/fixtures/injection-eval/payloads.json`
and currently contains 42 synthetic malicious payloads.
