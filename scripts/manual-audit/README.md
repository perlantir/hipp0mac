# Phase 5B Manual Audit Harness

These scripts exercise the Phase 5B manual audit gates against the real
localhost daemon supervised by the Mac app. They intentionally use the
HTTP approval flow and `kill -9`, so run them only when the Mac app is
open and supervising the daemon.

The scripts temporarily point the daemon at an audit workspace, defaulting
to:

```text
/tmp/operator-dock-phase5b-manual-audit-workspace
```

They restore the previous workspace at the end unless `--keep-workspace`
is supplied.

## Prerequisites

1. Open the Operator Dock Mac app so `DaemonSupervisor` owns the Node
   daemon.
2. Confirm the daemon is healthy:

```sh
curl -sS http://127.0.0.1:4768/health \
  -H "Authorization: Bearer $(security find-generic-password -s com.perlantir.operatordock.daemon -a daemon:httpBearerToken -w)"
```

If you run on a non-default daemon URL, pass `--daemon-url`.

## Crash And Idempotency Audit

Run:

```sh
node scripts/manual-audit/phase5b-crash-audit.mjs
```

Optional flags:

```sh
node scripts/manual-audit/phase5b-crash-audit.mjs \
  --daemon-url http://127.0.0.1:4768 \
  --workspace /tmp/operator-dock-phase5b-manual-audit-workspace \
  --kill-delay-ms 25
```

What it verifies:

- `fs.delete`: creates file `X`, submits `fs.delete` with idempotency key
  `K`, approves it, sends `kill -9` shortly after approval starts, waits
  for Phase 5A respawn, re-submits with the same key, approves, and
  verifies the file is gone and a second same-key retry does not error.
- `fs.append`: creates file `Y`, submits `fs.append` with idempotency key
  `K` to append `hello\n`, approves it, sends `kill -9`, waits for
  respawn, re-submits with the same key, approves, and verifies `hello\n`
  appears exactly once.
- `shell.run`: submits a single-use approved command whose side effect is
  delayed, sends `kill -9` after approval starts, waits for respawn, and
  verifies the marker was not written. It then re-submits the same
  logical command and verifies a fresh approval is required. By default,
  it denies that fresh approval for cleanup.

Because the file tools are intentionally fast, `--kill-delay-ms` is
tunable. The verification condition is the gate: same-key retry produces
one final side effect, not zero and not two.

## Safety Audit

Run:

```sh
node scripts/manual-audit/phase5b-safety-audit.mjs
```

The script submits 50 malicious `shell.exec` payloads and requires every
one to fail with `TOOL_DENIED` before execution. The corpus covers:

- command injection with `;`, `&&`, `||`, pipes, backticks, and `$()`
- remote download piped to `sh`, `bash`, `zsh`, and `env bash`
- destructive filesystem commands such as `rm -rf /`, `rm -rf ~`,
  traversal deletes, `diskutil`, `mkfs`, and raw `dd of=/dev/...`
- exfiltration with `curl`, `wget`, `nc`, `scp`, and `rsync`
- privilege escalation and permission broadening with `sudo`, `su`,
  `chmod 777`, and `chown root`
- path traversal and sensitive file reads such as `../../../etc/passwd`,
  `/etc/shadow`, SSH keys, and Keychain paths
- explicit argv variants such as `/bin/rm ["-rf", "/"]` and
  `/usr/bin/curl ["-d", "@secret.txt"]`
- workspace scope regression via `cwd: "/etc"`

The list lives in `phase5b-safety-audit.mjs` as
`maliciousShellExecInputs` so the exact gate inputs are reviewable.
