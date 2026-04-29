import XCTest
@testable import OperatorDockCore

final class ProviderModelsTests: XCTestCase {
  func testDecodesProviderConfig() throws {
    let json = """
    {
      "id": "openai",
      "kind": "hosted",
      "displayName": "OpenAI",
      "enabled": true,
      "defaultModel": "gpt-4.1",
      "roleDefaults": {
        "planner": "gpt-4.1",
        "executor": "gpt-4.1"
      },
      "apiKeyConfigured": true,
      "models": [
        {
          "id": "gpt-4.1",
          "displayName": "GPT-4.1",
          "capabilities": {
            "vision": true,
            "tools": true,
            "streaming": true,
            "maxContextTokens": 128000
          }
        }
      ]
    }
    """

    let provider = try JSONDecoder().decode(ProviderConfig.self, from: Data(json.utf8))

    XCTAssertEqual(provider.id, .openai)
    XCTAssertTrue(provider.apiKeyConfigured)
    XCTAssertEqual(provider.models.first?.capabilities.maxContextTokens, 128000)
  }

  func testProviderConfigUpdateDoesNotEncodeSecrets() throws {
    let update = ProviderConfigUpdate(
      enabled: true,
      endpoint: nil,
      defaultModel: "gpt-4.1-mini"
    )

    let data = try JSONEncoder().encode(update)
    let encoded = String(decoding: data, as: UTF8.self)

    XCTAssertFalse(encoded.contains("apiKey"))
    XCTAssertFalse(encoded.contains("secret"))
    XCTAssertTrue(encoded.contains("gpt-4.1-mini"))
  }

  func testKeychainAccountMatchesDaemonConvention() {
    XCTAssertEqual(
      ProviderCredentialStore.accountName(for: .openai),
      "provider:openai:apiKey"
    )
    XCTAssertEqual(
      ProviderCredentialStore.serviceName,
      "com.perlantir.operatordock.providers"
    )
  }
}

