import Foundation
import OperatorDockCore

enum WorkStatus: String, CaseIterable, Identifiable {
  case running
  case waiting
  case success
  case queued
  case failed

  var id: String {
    rawValue
  }

  var label: String {
    switch self {
    case .running: "Running"
    case .waiting: "Waiting"
    case .success: "Done"
    case .queued: "Queued"
    case .failed: "Failed"
    }
  }
}

struct OperatorTask: Identifiable, Hashable {
  let id: String
  let title: String
  let detail: String
  let source: String
  let started: String
  let cost: String
  let status: WorkStatus
  let tag: String

  init(task: DockTask) {
    id = task.id.uuidString
    title = task.title
    detail = task.prompt
    source = "Mac app"
    started = task.createdAt
    cost = "$0.00"
    status = WorkStatus(taskStatus: task.status)
    tag = task.priority.rawValue.capitalized
  }

  init(
    id: String,
    title: String,
    detail: String,
    source: String,
    started: String,
    cost: String,
    status: WorkStatus,
    tag: String
  ) {
    self.id = id
    self.title = title
    self.detail = detail
    self.source = source
    self.started = started
    self.cost = cost
    self.status = status
    self.tag = tag
  }
}

extension WorkStatus {
  init(taskStatus: TaskStatus) {
    switch taskStatus {
    case .queued: self = .queued
    case .running: self = .running
    case .waitingForApproval: self = .waiting
    case .completed: self = .success
    case .failed, .cancelled: self = .failed
    }
  }
}

struct PlanStep: Identifiable, Hashable {
  enum State: String {
    case done
    case active
    case pending
  }

  let id: String
  let title: String
  let detail: String
  let state: State
  let requiresApproval: Bool
}

struct ToolCallRecord: Identifiable, Hashable {
  let id: String
  let name: String
  let status: WorkStatus
  let input: String
  let output: String
}

struct ArtifactRecord: Identifiable, Hashable {
  let id: String
  let name: String
  let kind: String
  let location: String
  let status: WorkStatus
}

struct IntegrationRecord: Identifiable, Hashable {
  let id: String
  let name: String
  let account: String
  let status: WorkStatus
  let scopes: [String]
}

struct SkillRecord: Identifiable, Hashable {
  let id: String
  let name: String
  let vendor: String
  let usage: String
  let verified: Bool
}

struct MemoryRecord: Identifiable, Hashable {
  let id: String
  let title: String
  let kind: String
  let source: String
  let confidence: Double
}

struct ProjectRecord: Identifiable, Hashable {
  let id: String
  let name: String
  let summary: String
  let status: WorkStatus
  let updated: String
}

struct ScheduleRecord: Identifiable, Hashable {
  let id: String
  let name: String
  let cron: String
  let lastRun: String
  let nextRun: String
  let enabled: Bool
}

enum SampleData {
  static let tasks: [OperatorTask] = [
    OperatorTask(
      id: "sample-1",
      title: "Pull Q2 churn cohorts from Mixpanel",
      detail: "Inspect pricing funnels, export cohorts, and prepare a short findings memo.",
      source: "Workspace",
      started: "9:41 AM",
      cost: "$0.84",
      status: .running,
      tag: "Browser"
    ),
    OperatorTask(
      id: "sample-2",
      title: "Draft launch announcement for Loop",
      detail: "Create partner-ready copy and flag claims that need approval before sending.",
      source: "Command",
      started: "Yesterday",
      cost: "$0.32",
      status: .waiting,
      tag: "Writing"
    ),
    OperatorTask(
      id: "sample-3",
      title: "Refactor settings page in handle-web",
      detail: "Summarize changes, test the settings flow, and attach diff artifacts.",
      source: "GitHub",
      started: "Mon",
      cost: "$1.12",
      status: .success,
      tag: "Build"
    )
  ]

  static let planSteps: [PlanStep] = [
    PlanStep(id: "step-1", title: "Find current retention dashboards", detail: "Mixpanel workspace discovery", state: .done, requiresApproval: false),
    PlanStep(id: "step-2", title: "Export Q2 cohort CSV", detail: "Browser automation", state: .done, requiresApproval: false),
    PlanStep(id: "step-3", title: "Compare pricing page variants", detail: "Inspecting public page", state: .active, requiresApproval: false),
    PlanStep(id: "step-4", title: "Write churn narrative", detail: "Drafting concise report", state: .pending, requiresApproval: false),
    PlanStep(id: "step-5", title: "Send summary to partners", detail: "Requires Gmail approval", state: .pending, requiresApproval: true)
  ]

  static let tools: [ToolCallRecord] = [
    ToolCallRecord(
      id: "tool-1",
      name: "browser.click",
      status: .running,
      input: "{ selector: \"button[data-export='csv']\" }",
      output: "Waiting for download confirmation"
    ),
    ToolCallRecord(
      id: "tool-2",
      name: "memory.search",
      status: .success,
      input: "{ query: \"Q2 pricing experiments\" }",
      output: "3 records returned"
    )
  ]

  static let artifacts: [ArtifactRecord] = [
    ArtifactRecord(id: "artifact-1", name: "q2-churn.csv", kind: "CSV", location: "workspace/artifacts/q2-churn.csv", status: .running),
    ArtifactRecord(id: "artifact-2", name: "pricing-notes.md", kind: "Markdown", location: "workspace/artifacts/pricing-notes.md", status: .success),
    ArtifactRecord(id: "artifact-3", name: "run-log.txt", kind: "Log", location: "workspace/logs/run-log.txt", status: .success)
  ]

  static let integrations: [IntegrationRecord] = [
    IntegrationRecord(id: "int-1", name: "GitHub", account: "perlantir", status: .success, scopes: ["repo", "workflow"]),
    IntegrationRecord(id: "int-2", name: "Notion", account: "Rae workspace", status: .success, scopes: ["read", "write"]),
    IntegrationRecord(id: "int-3", name: "Linear", account: "Product", status: .success, scopes: ["issues"]),
    IntegrationRecord(id: "int-4", name: "Gmail", account: "Needs review", status: .waiting, scopes: ["draft"])
  ]

  static let skills: [SkillRecord] = [
    SkillRecord(id: "skill-1", name: "Browser Operator", vendor: "Operator Dock", usage: "42 runs this month", verified: true),
    SkillRecord(id: "skill-2", name: "Research Synthesizer", vendor: "Operator Dock", usage: "18 runs this month", verified: true),
    SkillRecord(id: "skill-3", name: "Code Builder", vendor: "Operator Dock", usage: "11 runs this month", verified: true),
    SkillRecord(id: "skill-4", name: "Memory Curator", vendor: "Operator Dock", usage: "8 runs this month", verified: true)
  ]

  static let memory: [MemoryRecord] = [
    MemoryRecord(id: "mem-1", title: "Rae prefers concise partner updates", kind: "Preference", source: "Notion", confidence: 0.94),
    MemoryRecord(id: "mem-2", title: "Pricing model v4 is the active GTM plan", kind: "Project", source: "Workspace", confidence: 0.88),
    MemoryRecord(id: "mem-3", title: "Design partners require explicit send approval", kind: "Policy", source: "Approval history", confidence: 1.0)
  ]

  static let projects: [ProjectRecord] = [
    ProjectRecord(id: "proj-1", name: "Q3 competitive scan", summary: "Research, browser captures, and a short executive memo.", status: .running, updated: "12 min ago"),
    ProjectRecord(id: "proj-2", name: "Pricing model v4", summary: "Model defaults, risk notes, and partner narrative.", status: .waiting, updated: "Yesterday"),
    ProjectRecord(id: "proj-3", name: "Onboarding rewrite", summary: "Copy and UI tasks for the first-run experience.", status: .success, updated: "Mon")
  ]

  static let schedules: [ScheduleRecord] = [
    ScheduleRecord(id: "sched-1", name: "Daily customer signal digest", cron: "0 8 * * 1-5", lastRun: "Today 8:00", nextRun: "Tomorrow 8:00", enabled: true),
    ScheduleRecord(id: "sched-2", name: "Weekly competitor sweep", cron: "0 9 * * 1", lastRun: "Mon 9:00", nextRun: "Next Mon 9:00", enabled: true),
    ScheduleRecord(id: "sched-3", name: "Memory hygiene review", cron: "0 16 * * 5", lastRun: "Fri 4:00", nextRun: "Fri 4:00", enabled: false)
  ]
}

