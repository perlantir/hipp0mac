import Foundation

public enum DaemonClientError: LocalizedError, Equatable {
  case invalidResponse
  case httpStatus(Int, String)
  case invalidWebSocketMessage

  public var errorDescription: String? {
    switch self {
    case .invalidResponse:
      "The daemon returned an invalid response."
    case .httpStatus(let status, let message):
      "Daemon request failed with HTTP \(status): \(message)"
    case .invalidWebSocketMessage:
      "The daemon sent an unsupported WebSocket message."
    }
  }
}

public struct DaemonClient: Sendable {
  public let baseURL: URL
  public let webSocketURL: URL

  private let session: URLSession
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()

  public init(
    baseURL: URL = URL(string: "http://127.0.0.1:4768")!,
    webSocketURL: URL = URL(string: "ws://127.0.0.1:4768/v1/events")!,
    session: URLSession = .shared
  ) {
    self.baseURL = baseURL
    self.webSocketURL = webSocketURL
    self.session = session
  }

  public func health() async throws -> HealthResponse {
    try await get("/health")
  }

  public func listTasks() async throws -> [DockTask] {
    let response: TaskListResponse = try await get("/v1/tasks")
    return response.tasks
  }

  public func createTask(
    title: String,
    prompt: String,
    priority: TaskPriority = .normal,
    metadata: [String: JSONValue] = [:]
  ) async throws -> DockTask {
    let response: CreateTaskResponse = try await post(
      "/v1/tasks",
      body: CreateTaskRequest(
        title: title,
        prompt: prompt,
        priority: priority,
        metadata: metadata
      )
    )
    return response.task
  }

  public func events() -> AsyncThrowingStream<OperatorEvent, Error> {
    AsyncThrowingStream { continuation in
      let task = session.webSocketTask(with: webSocketURL)
      task.resume()
      receiveNextMessage(from: task, continuation: continuation)

      continuation.onTermination = { _ in
        task.cancel(with: .goingAway, reason: nil)
      }
    }
  }

  private func get<Response: Decodable>(_ path: String) async throws -> Response {
    var request = URLRequest(url: baseURL.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))))
    request.httpMethod = "GET"
    return try await send(request)
  }

  private func post<RequestBody: Encodable, Response: Decodable>(
    _ path: String,
    body: RequestBody
  ) async throws -> Response {
    var request = URLRequest(url: baseURL.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try encoder.encode(body)
    return try await send(request)
  }

  private func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
    let (data, response) = try await session.data(for: request)

    guard let httpResponse = response as? HTTPURLResponse else {
      throw DaemonClientError.invalidResponse
    }

    guard (200..<300).contains(httpResponse.statusCode) else {
      let message = decodeErrorMessage(from: data) ?? HTTPURLResponse.localizedString(forStatusCode: httpResponse.statusCode)
      throw DaemonClientError.httpStatus(httpResponse.statusCode, message)
    }

    return try decoder.decode(Response.self, from: data)
  }

  private func decodeErrorMessage(from data: Data) -> String? {
    struct ErrorEnvelope: Decodable {
      struct ErrorBody: Decodable {
        let message: String
      }

      let error: ErrorBody
    }

    return try? decoder.decode(ErrorEnvelope.self, from: data).error.message
  }

  private func receiveNextMessage(
    from task: URLSessionWebSocketTask,
    continuation: AsyncThrowingStream<OperatorEvent, Error>.Continuation
  ) {
    task.receive { result in
      switch result {
      case .failure(let error):
        continuation.finish(throwing: error)
      case .success(let message):
        do {
          let data: Data

          switch message {
          case .string(let text):
            data = Data(text.utf8)
          case .data(let messageData):
            data = messageData
          @unknown default:
            throw DaemonClientError.invalidWebSocketMessage
          }

          let event = try decoder.decode(OperatorEvent.self, from: data)
          continuation.yield(event)
          receiveNextMessage(from: task, continuation: continuation)
        } catch {
          continuation.finish(throwing: error)
        }
      }
    }
  }
}

