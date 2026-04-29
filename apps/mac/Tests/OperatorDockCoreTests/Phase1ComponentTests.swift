import XCTest
import SwiftUI
@testable import OperatorDock

final class Phase1ComponentTests: XCTestCase {
  func testSidebarContainsRequiredPhaseOneDestinations() {
    let sections = Set(SidebarSection.allCases.map(\.rawValue))

    XCTAssertTrue(sections.isSuperset(of: [
      "home",
      "tasks",
      "workspace",
      "projects",
      "memory",
      "skills",
      "integrations",
      "schedules",
      "artifacts",
      "settings"
    ]))
  }

  func testSampleDataSupportsDashboardAndWorkspaceShells() {
    XCTAssertGreaterThanOrEqual(SampleData.tasks.count, 3)
    XCTAssertFalse(SampleData.planSteps.isEmpty)
    XCTAssertFalse(SampleData.tools.isEmpty)
    XCTAssertFalse(SampleData.artifacts.isEmpty)
    XCTAssertFalse(SampleData.integrations.isEmpty)
    XCTAssertFalse(SampleData.skills.isEmpty)
    XCTAssertFalse(SampleData.memory.isEmpty)
  }

  @MainActor
  func testReusableComponentsInstantiate() {
    _ = SidebarItem(section: .home, isActive: true) {}
    _ = CommandComposer(text: .constant(""), placeholder: "Run a task") {}
    _ = TaskCard(task: SampleData.tasks[0])
    _ = StepTimelineCard(steps: SampleData.planSteps)
    _ = ToolCallCard(tool: SampleData.tools[0])
    _ = ArtifactCard(artifact: SampleData.artifacts[0])
    _ = IntegrationCard(integration: SampleData.integrations[0])
    _ = SkillCard(skill: SampleData.skills[0])
    _ = MemoryRecordRow(record: SampleData.memory[0])
    _ = StatusBadge(status: .running)
    _ = ApprovalModal(title: "Approve", details: "Review requested action.", onApprove: {}, onDecline: {})
  }
}
