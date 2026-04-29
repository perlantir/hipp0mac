import Foundation
import XCTest
@testable import OperatorDockPersistence

final class XPCSecurityTests: XCTestCase {
  func testUnsignedClientRejectedEmitsEvent() throws {
    let harness = try XPCHarness(validator: MockClientCodeValidator(result: .rejected(reason: "unsigned client")))

    let result = try harness.gate.establishConnection(
      XPCConnectionRequest(clientIdentifier: "unsigned-test", auditToken: Data([0x01]))
    )

    XCTAssertEqual(result, .rejected(reason: "unsigned client"))
    let event = try XCTUnwrap(harness.eventStore.readAll(taskId: PlatformEvent.taskId).last)
    XCTAssertEqual(event.eventType, "xpc_connection_rejected")
    XCTAssertEqual(event.payload["clientIdentifier"], .string("unsigned-test"))
    XCTAssertEqual(event.payload["reason"], .string("unsigned client"))
  }

  func testSignedClientAcceptedEmitsEvent() throws {
    let harness = try XPCHarness(validator: MockClientCodeValidator(result: .accepted(teamIdentifier: "TEAMID", entitlements: ["com.perlantir.operatordock.client"])))

    let result = try harness.gate.establishConnection(
      XPCConnectionRequest(clientIdentifier: "signed-test", auditToken: Data([0x02]))
    )

    XCTAssertEqual(result, .accepted(teamIdentifier: "TEAMID", entitlements: ["com.perlantir.operatordock.client"]))
    let event = try XCTUnwrap(harness.eventStore.readAll(taskId: PlatformEvent.taskId).last)
    XCTAssertEqual(event.eventType, "xpc_connection_accepted")
    XCTAssertEqual(event.payload["clientIdentifier"], .string("signed-test"))
    XCTAssertEqual(event.payload["teamIdentifier"], .string("TEAMID"))
  }
}

private final class XPCHarness {
  let paths: OperatorDockPaths
  let keys = PersistenceKeys(
    encryptionKeyBytes: Data(repeating: 0x99, count: 32),
    hmacKeyBytes: Data(repeating: 0xAA, count: 32)
  )
  let eventStore: EventStore
  let gate: XPCSecurityGate

  init(validator: ClientCodeValidator) throws {
    paths = try OperatorDockPaths(root: FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-xpc-\(UUID().uuidString)", isDirectory: true))
    try paths.createLayout()
    eventStore = EventStore(paths: paths, keys: keys)
    gate = XPCSecurityGate(eventStore: eventStore, validator: validator)
  }
}
