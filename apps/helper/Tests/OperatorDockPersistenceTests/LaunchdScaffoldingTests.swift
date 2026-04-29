import Foundation
import XCTest
@testable import OperatorDockPersistence

final class LaunchdScaffoldingTests: XCTestCase {
  func testLaunchdPlistContainsMachServiceAndKeepAlive() throws {
    let config = LaunchdConfiguration(
      label: "com.perlantir.operatordock.helper",
      executablePath: "/Applications/OperatorDock.app/Contents/Library/LoginItems/OperatorDockHelper",
      machServiceName: "com.perlantir.operatordock.helper.xpc"
    )

    let plist = try PropertyListSerialization.propertyList(
      from: LaunchdPlistRenderer(configuration: config).data(),
      options: [],
      format: nil
    ) as? [String: Any]

    XCTAssertEqual(plist?["Label"] as? String, config.label)
    XCTAssertEqual(plist?["KeepAlive"] as? Bool, true)
    XCTAssertEqual(plist?["RunAtLoad"] as? Bool, true)
    XCTAssertEqual(
      (plist?["MachServices"] as? [String: Bool])?[config.machServiceName],
      true
    )
  }

  func testLaunchdManagerWritesVersionedPlist() throws {
    let root = try temporaryDirectory()
    let manager = LaunchdManager(launchAgentsDirectory: root)
    let config = LaunchdConfiguration(
      label: "com.perlantir.operatordock.helper",
      executablePath: "/tmp/OperatorDockHelper",
      machServiceName: "com.perlantir.operatordock.helper.xpc"
    )

    let url = try manager.writePlist(configuration: config)

    XCTAssertEqual(url.lastPathComponent, "com.perlantir.operatordock.helper.plist")
    let data = try Data(contentsOf: url)
    XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("schemaVersion"))
  }

  func testHelperAndClientEntitlementResourcesExist() throws {
    let resources = packageRoot()
      .appendingPathComponent("Resources", isDirectory: true)
      .appendingPathComponent("Entitlements", isDirectory: true)
    let helper = resources.appendingPathComponent("OperatorDockHelper.entitlements")
    let client = resources.appendingPathComponent("OperatorDockClient.entitlements")

    let helperPlist = try readPlist(helper)
    let clientPlist = try readPlist(client)

    XCTAssertEqual(helperPlist["com.apple.security.app-sandbox"] as? Bool, true)
    XCTAssertEqual(helperPlist["com.apple.security.application-groups"] as? [String], ["group.com.perlantir.operatordock"])
    XCTAssertEqual(clientPlist["com.perlantir.operatordock.client"] as? Bool, true)
  }

  private func packageRoot() -> URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
  }

  private func readPlist(_ url: URL) throws -> [String: Any] {
    try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: url), options: [], format: nil) as? [String: Any])
  }
}
