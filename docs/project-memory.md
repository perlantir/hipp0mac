# Project Memory

These directives are standing project context for Operator Dock.

## Quality Bar

- Build Operator Dock as a top-tier, enterprise-grade Mac-first autonomous AI agent workspace.
- No shortcuts: prefer production-quality architecture, strong typing, secure defaults, real tests, and maintainable implementation seams.
- Keep the Mac app premium, dense, polished, and native to macOS.
- The Mac app is dark-first. Preserve the Claude handoff's density, card rhythm, and operator-workspace feel while translating it to a native macOS surface.
- Avoid generic chatbot UI. Operator Dock should feel like an operator workspace for autonomous work, not a chat wrapper.
- Wire UI and services for real data even when a phase uses realistic sample data.
- Treat security and local safety as first-class product requirements.
- Never log secrets. Never store plaintext API keys in SQLite.
- Preserve a clean monorepo architecture with native SwiftUI app, local TypeScript daemon, shared protocol schemas, local SQLite, and explicit tests.

## Design Source

The Claude design handoff lives in `docs/design/claude-handoff`. It is the visual and interaction source for the Mac app shell work in Phase 1.

## Current Roadmap

The next implementation phases are captured in `docs/roadmap.md` and should be executed to production quality.
