import Foundation
// App-only dependencies replaced for the standalone transport contract harness.
enum AIBackendError: LocalizedError {
    case notAuthenticated, invalidResponse, invalidURL(String), serverError(String)
    var errorDescription: String? { if case .serverError(let text) = self { return text }; return "Invalid backend response" }
}
enum AIProxyConfig { static func getAccessToken() async -> String? { "fixture" } }
struct FixtureUser { var id = UUID() }
struct FixtureSession { var user = FixtureUser(); var accessToken = "fixture" }
struct FixtureAuth {
    var session: FixtureSession { get async throws { FixtureSession() } }
    func refreshSession() async throws {}
}
struct FixtureClient { let auth = FixtureAuth() }
struct SupabaseManager { static let shared = SupabaseManager(); let client = FixtureClient() }
