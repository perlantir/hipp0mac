import XCTest
@testable import OperatorDockCore

final class DaemonClientTests: XCTestCase {
  func testDefaultURLsPointAtLocalDaemon() {
    let client = DaemonClient()

    XCTAssertEqual(client.baseURL.absoluteString, "http://127.0.0.1:4768")
    XCTAssertEqual(client.webSocketURL.absoluteString, "ws://127.0.0.1:4768/v1/events")
  }

  func testDecodesTaskCreatedEvent() throws {
    let json = """
    {
      "id": "054cdb48-950b-4794-9316-c7b0987efbef",
      "type": "task.created",
      "occurredAt": "2026-04-29T13:01:00.000Z",
      "payload": {
        "task": {
          "id": "3c765f62-0b9e-4902-a776-1fa2b9a0b513",
          "title": "Index repo",
          "prompt": "Inspect the repository.",
          "status": "queued",
          "priority": "normal",
          "metadata": {
            "source": "test"
          },
          "createdAt": "2026-04-29T13:00:00.000Z",
          "updatedAt": "2026-04-29T13:00:00.000Z"
        }
      }
    }
    """

    let event = try JSONDecoder().decode(OperatorEvent.self, from: Data(json.utf8))

    XCTAssertEqual(event.type, "task.created")
    XCTAssertEqual(event.task?.title, "Index repo")
  }
}

