//
//  AnalyticsConfig.swift
//  Native Intelligence
//
//  PostHog analytics configuration
//

import Foundation

enum AnalyticsConfig {
    // MARK: - Environment Selection

    static var currentEnvironment: Environment {
        #if PRODUCTION
        return .production
        #else
        return .development
        #endif
    }

    // MARK: - Environment Configuration

    enum Environment {
        case development
        case production

        var apiKey: String {
            switch self {
            case .development:
                return "phc_pDr8AOo6MZ2kxPbkYA9622Vx02zIvEcOz3g4hDkivAA"
            case .production:
                return "phc_pDr8AOo6MZ2kxPbkYA9622Vx02zIvEcOz3g4hDkivAA"
            }
        }

        var host: String {
            switch self {
            case .development:
                return "https://us.i.posthog.com"
            case .production:
                return "https://us.i.posthog.com"
            }
        }

        var description: String {
            switch self {
            case .development:
                return "Development"
            case .production:
                return "Production"
            }
        }
    }

    // MARK: - Public API

    static let apiKey = currentEnvironment.apiKey
    static let host = currentEnvironment.host
}
