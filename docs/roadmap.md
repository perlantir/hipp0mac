# Operator Dock Roadmap

## Phase 0 - Repo Setup and Architecture

Status: implemented.

Goal: create the initial monorepo architecture for Operator Dock, a Mac-first autonomous AI agent workspace.

Requirements:

- Use a monorepo structure.
- Include a native Mac app folder and a local agent daemon folder.
- Mac app should be SwiftUI.
- Agent daemon should be TypeScript/Node.
- Mac app communicates with daemon over localhost HTTP and WebSocket.
- Include shared protocol schemas for task events, tool calls, approvals, artifacts, and model messages.
- Include local SQLite database setup for tasks, projects, memory, settings, schedules, and artifacts.
- Include basic README with setup instructions.
- Include development scripts.
- Include test scaffolding.

Implemented baseline:

- `/apps/mac`
- `/apps/daemon`
- `/packages/protocol`
- `/packages/shared`
- `/docs`
- SwiftUI app shell with sidebar navigation placeholders.
- TypeScript Fastify daemon with HTTP server and WebSocket event stream.
- `GET /health`.
- zod protocol package.
- SQLite migrations.
- `POST /v1/tasks`.
- Mac app can create a test task and receive live task events.

Quality bar:

- Production-style structure.
- Strong typing.
- Clear errors.
- No fake hardcoded architecture beyond demo placeholders.
- Tests for protocol schemas and daemon health/task creation.

## Phase 1 - Mac App Shell and Design Integration

Status: implemented.

Goal: create the production-quality Mac app shell for Operator Dock based on the provided Claude design system and screens.

Implement:

- Dark-first design system.
- Sidebar navigation.
- Home dashboard.
- Task list screen.
- Workspace screen shell.
- Projects screen shell.
- Memory screen shell.
- Skills screen shell.
- Integrations screen shell.
- Schedules screen shell.
- Artifacts screen shell.
- Settings screen shell.

Reusable components:

- `SidebarItem`
- `CommandComposer`
- `TaskCard`
- `StepTimelineCard`
- `ToolCallCard`
- `ArtifactCard`
- `ApprovalModal`
- `IntegrationCard`
- `SkillCard`
- `MemoryRecordRow`
- `StatusBadge`

Design requirements:

- Match the Claude design direction closely.
- Use realistic sample data where backend data is not available yet.
- Keep components wired for real data.
- App should feel premium, dense, and polished.
- Avoid generic chatbot UI.
- Do not implement full agent logic yet.
- Do not add integrations yet.
- Focus on UI architecture, state models, and navigation.
- Add snapshot or component tests where possible.

## Phase 2 - Provider Setup and Model Router

Status: implemented.

Goal: implement provider setup and the normalized model routing layer.

Providers for V1:

- OpenAI API key.
- Anthropic API key.
- OpenRouter API key.
- Ollama local endpoint.
- LM Studio or OpenAI-compatible local endpoint.

Requirements:

- Add provider settings UI in Mac app.
- Store credentials securely in macOS Keychain.
- Daemon should request credentials from secure local storage when needed.
- Implement connection tests for each provider.
- Implement a normalized `ModelRouter` interface.
- Support chat completion, streaming, and tool-call style responses where available.
- Track model capabilities: vision, tools, streaming, max context, and cost estimate if known.
- Allow user to set default model for planner, executor, verifier, summarizer, and memory curator.
- Add Auto mode selection.

Security:

- Never log API keys.
- Redact keys from errors.
- Do not store plaintext keys in SQLite.

Tests:

- Unit tests for provider config validation.
- Mock provider tests for `ModelRouter`.
- UI test for adding/testing provider.

## Phase 3 - Local Workspace and Enterprise File Tools

Status: implemented.

Goal: replace basic file tooling with production-grade local workspace and file infrastructure.

Implemented:

- User-selectable Operator Dock workspace folder.
- Required workspace folders: `projects`, `tasks`, `artifacts`, `logs`, `skills`, and `memory`.
- Workspace settings persisted locally.
- File permission boundary system.
- `fs.read`, `fs.write`, `fs.append`, `fs.list`, `fs.search`, `fs.copy`, `fs.move`, and `fs.delete`.
- Structured tool events: `tool.started`, `tool.output`, `tool.completed`, `tool.failed`, and `approval.required`.
- Safety checks for write/delete outside the workspace.
- System directory delete blocking.
- Raw file operation logs.
- File explorer in Workspace UI.

Tests:

- Workspace creation.
- Project folder creation.
- File read/write/list/search.
- Blocked unsafe delete.
- Approval required outside workspace.
- Event emission.

## Phase 4 - Enterprise Tool Runtime and Safety Governor

Status: implemented.

Goal: centralize all future agent actions behind a strongly typed, auditable, approval-aware local tool runtime.

Implemented:

- Strict tool definition interface with input/output schema validation.
- Standard `ToolResult` shape with deterministic error codes.
- `safe`, `medium`, and `dangerous` risk classification.
- Timeout, retry, cancellation, raw output refs, and replay metadata.
- Persisted runtime events and approval records.
- Approval pause/resume flow with Mac Workspace approval modal wiring.
- Secret redaction for tool outputs, errors, raw refs, and persisted inputs.
- File tools registered through the runtime.
- `shell.run` and `shell.runInteractive` with cancellation and bounded execution.
- Shell command risk classifier with destructive denylist.
- Approval requirements for sudo, broad deletes, curl-pipe-shell, and outside-workspace mutations.

Tests:

- Schema validation.
- Command classification.
- Approval pause/resume.
- Cancellation.
- Timeout.
- Secret redaction.
- Replay metadata and persisted events.
