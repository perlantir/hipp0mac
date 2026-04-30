# Phase 5A Daemon Logging

The Mac app supervises the local Node daemon and captures daemon stdout
and stderr to:

`~/Library/Logs/OperatorDock/daemon.log`

The log is intended for startup, crash, and recovery diagnostics. The
Settings daemon diagnostics panel shows the path and includes a reveal
button.

## Rotation

`DaemonSupervisor` rotates the log when it reaches 10 MB. It keeps the
active `daemon.log` plus five rotated files:

- `daemon.log.1`
- `daemon.log.2`
- `daemon.log.3`
- `daemon.log.4`
- `daemon.log.5`

The oldest rotated file is removed when a new rotation occurs.

## Redaction

Daemon application logs still flow through the Phase 5A redaction layer.
The supervisor only redirects process streams; it does not bypass daemon
logging policy or write secrets itself.
