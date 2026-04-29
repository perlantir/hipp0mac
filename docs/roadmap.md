# Operator Dock Roadmap

## Phase 1 - Mac App Shell and Design Integration

Goal: create the production-quality Mac app shell for Operator Dock based on the provided Claude design system and screens.

Implement:

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

- Match the Claude design as closely as possible.
- Use realistic sample data where backend data is not available yet.
- Keep components wired for real data.
- App should feel premium, dense, and polished.
- Avoid generic chatbot UI.
- Do not implement full agent logic yet.
- Do not add integrations yet.
- Focus on UI architecture, state models, and navigation.
- Add snapshot or component tests where possible.

## Phase 2 - Provider Setup and Model Router

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
- Track model capabilities: vision, tools, streaming, max context, and cost estimate when known.
- Allow user to set default model for planner, executor, verifier, summarizer, and memory curator.
- Add Auto mode selection.

Security:

- Never log API keys.
- Redact keys from errors.
- Do not store plaintext keys in SQLite.

Tests:

- Unit tests for provider config validation.
- Mock provider tests for `ModelRouter`.
- UI test for adding and testing a provider.

## Phase 3 - Local Workspace and File Tools

Goal: implement local workspace management and safe file tools.

Requirements:

- Create a default Operator Dock workspace folder under a user-selected location.
- Projects live inside `workspace/projects`.
- Tasks live inside `workspace/tasks`.
- Artifacts live inside `workspace/artifacts`.
- Logs live inside `workspace/logs`.
- Skills live inside `workspace/skills`.
- Add onboarding step to choose workspace location.
- Add permissions explanation.

Tools:

- `fs.read`
- `fs.write`
- `fs.append`
- `fs.list`
- `fs.search`
- `fs.copy`
- `fs.move`
- `fs.delete` with approval requirement

Tool execution events:

- `tool.started`
- `tool.output`
- `tool.completed`
- `tool.failed`

Safety:

- Default file writes are restricted to the workspace.
- Any write or delete outside the workspace requires approval.
- Block deletion of system directories.

Tests:

- File tool unit tests.
- Safety boundary tests.
- Event emission tests.

