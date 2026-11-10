//
//  ClaudeConfiguration.swift
//  Native Intelligence
//
//  Configuration for Claude AI Chat
//  Manages models, API keys, and system prompts
//

import Foundation
import Combine

/// Configuration manager for Claude AI Chat
class ClaudeConfiguration: ObservableObject {
    static let shared = ClaudeConfiguration()

    // MARK: - Published Properties

    @Published var selectedModel: ClaudeModel {
        didSet {
            saveSelectedModel()
        }
    }

    // MARK: - Private Properties

    private let modelDefaultsKey = "dial8_claude_model"

    // MARK: - Initialization

    private init() {
        // Load saved model or use default. Reject a stale saved id that is no
        // longer in the website's roster (e.g. the retired Opus 4.1) so the
        // picker never surfaces a model the /eve/chat-agent/v1/session route would silently
        // fall back on — the migration target is `.auto`, which asks the server
        // to pick rather than pinning a model the client guessed at.
        if let savedModelString = UserDefaults.standard.string(forKey: modelDefaultsKey),
           let savedModel = ClaudeModel(rawValue: savedModelString) {
            self.selectedModel = savedModel
        } else {
            self.selectedModel = .default // .auto — server applies DEFAULT_MODEL
        }

        print("🤖 ClaudeConfiguration: Initialized with model \(selectedModel.displayName)")
    }

    // MARK: - Model Management

    /// Save selected model to UserDefaults
    private func saveSelectedModel() {
        UserDefaults.standard.set(selectedModel.rawValue, forKey: modelDefaultsKey)
        print("🤖 ClaudeConfiguration: Model saved: \(selectedModel.displayName)")
    }

    /// Check if ready to use (user is authenticated for server-side proxy)
    var isReady: Bool {
        return AIProxyConfig.isAuthenticated
    }
}

// MARK: - Chat Model

/// Chat models the eve backend (`/eve/chat-agent/v1/session`) accepts. Mirrors the website's
/// `CHAT_MODELS` roster in `src/lib/ai/models.ts` — the rawValue MUST be in the
/// route's `ALLOWED_MODELS` set or the server silently falls back to
/// `DEFAULT_MODEL`. Multi-provider (Anthropic / Moonshot / DeepSeek): the route
/// resolves the gateway provider prefix from the model id, so the client only
/// sends the id. Kept the type name `ClaudeModel` to avoid churn at call sites.
enum ClaudeModel: String, CaseIterable, Codable {
    /// Not a backend model id — a sentinel meaning "send no model field at all"
    /// so `/eve/chat-agent/v1/session` applies its own DEFAULT_MODEL. Never put this rawValue
    /// on the wire: `iOSEveChatViewModel` leaves the model out of the run context
    /// when this is selected.
    case auto = "auto"
    case haiku45 = "claude-haiku-4-5-20251001"
    case sonnet45 = "claude-sonnet-4-5-20250929"
    case kimiK26 = "kimi-k2.6"
    case kimiK3 = "kimi-k3"
    case deepseekV4Flash = "deepseek-v4-flash"
    case deepseekV4Pro = "deepseek-v4-pro"

    /// What a fresh install (and any stale persisted id) lands on. `.auto` defers
    /// to the backend's DEFAULT_MODEL instead of pinning a client-side guess.
    static let `default`: ClaudeModel = .auto

    /// Premium (paid-plan-only) models, mirroring website PREMIUM_MODELS.
    /// Free/trial users are clamped server-side to `.default`.
    var isPremium: Bool {
        self == .sonnet45
    }

    var displayName: String {
        switch self {
        case .auto:             return "Auto"
        case .haiku45:          return "Haiku 4.5"
        case .sonnet45:         return "Sonnet 4.5"
        case .kimiK26:          return "Kimi K2.6"
        case .kimiK3:           return "Kimi K3"
        case .deepseekV4Flash:  return "DeepSeek V4 Flash"
        case .deepseekV4Pro:    return "DeepSeek V4 Pro"
        }
    }

    var description: String {
        switch self {
        case .auto:             return "Let Native Intelligence pick"
        case .haiku45:          return "Fast & efficient"
        case .sonnet45:         return "Most capable"
        case .kimiK26:          return "Cheap & capable"
        case .kimiK3:           return "Frontier-level, open weight"
        case .deepseekV4Flash:  return "Cheapest option"
        case .deepseekV4Pro:    return "Strong coding, low cost"
        }
    }

    var icon: String {
        switch self {
        case .haiku45, .deepseekV4Flash:
            return "bolt.fill"
        case .auto, .sonnet45, .kimiK3, .deepseekV4Pro:
            return "sparkles"
        case .kimiK26:
            return "sparkle"
        }
    }
}
