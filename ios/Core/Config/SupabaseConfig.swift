//
//  SupabaseConfig.swift
//  Native Intelligence
//
//  Supabase configuration - IMPORTANT: Only use public anon key here
//

import Foundation

enum SupabaseConfig {
    // MARK: - Environment Selection

    private static let overrideKey = "dial8_environment_override"

    /// Current environment: runtime override if set, otherwise build configuration
    static var currentEnvironment: Environment {
        if let override = overriddenEnvironment {
            return override
        }
        #if PRODUCTION
        return .production
        #else
        return .development
        #endif
    }

    /// The runtime override, or nil if using build default
    static var overriddenEnvironment: Environment? {
        guard let raw = UserDefaults.standard.string(forKey: overrideKey) else { return nil }
        return Environment(rawValue: raw)
    }

    /// Set a runtime environment override (nil = use build default)
    static func setOverride(_ env: Environment?) {
        if let env {
            UserDefaults.standard.set(env.rawValue, forKey: overrideKey)
        } else {
            UserDefaults.standard.removeObject(forKey: overrideKey)
        }
    }

    // MARK: - Environment Configuration

    enum Environment: String, Equatable {
        case development
        case production

        var projectURL: String {
            switch self {
            case .development:
                // Your development Supabase project (current/existing one)
                return "https://edrjddsxjoigpbecqgfb.supabase.co"
            case .production:
                // Your production Supabase project (to be created)
                // TODO: Replace with your production project URL after creating it
                return "https://bzfthjzyzevjokbuhqci.supabase.co"
            }
        }

        var anonPublicKey: String {
            switch self {
            case .development:
                // Development anon key (current/existing one)
                return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkcmpkZHN4am9pZ3BiZWNxZ2ZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTYzMTgwOTEsImV4cCI6MjA3MTg5NDA5MX0.bUXL02fAi1mBmW-ox8KxVkMaA9Xkr8ydcngIjvqXVJA"
            case .production:
                // Production anon key (to be filled in)
                // TODO: Replace with your production anon key after creating the project
                return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6ZnRoanp5emV2am9rYnVocWNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI1MzEyODMsImV4cCI6MjA3ODEwNzI4M30.kkzsbKZxFSuJgpkri_cVtSLHBp3BzxKns79Kz1WtL4w"
            }
        }

        var redirectURL: String {
            switch self {
            case .development:
                return "dial8-dev://auth-callback"
            case .production:
                return "dial8://auth-callback"
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

    // MARK: - Public API (backwards compatible, always reflects current environment)

    static var projectURL: String { currentEnvironment.projectURL }
    static var anonPublicKey: String { currentEnvironment.anonPublicKey }
    static var redirectURL: String { currentEnvironment.redirectURL }

    // Database schema (optional, defaults to "public")
    static let schema = "public"

    // WARNING: NEVER include these in client code:
    // - service_role key (starts with "eyJ..." but has admin privileges)
    // - JWT secret
    // - Database password
    // These should only be used in secure backend environments
}

// MARK: - Security Check

extension SupabaseConfig {
    static func validateConfiguration() -> Bool {
        print("🔷 SupabaseConfig: Environment = \(currentEnvironment.description)")
        print("🔷 SupabaseConfig: Project URL = \(projectURL)")

        // Check for placeholder values in production
        if currentEnvironment == .production {
            if projectURL.contains("YOUR_PRODUCTION") || anonPublicKey.contains("YOUR_PRODUCTION") {
                fatalError("""
                    ⚠️ CONFIGURATION ERROR: Production environment not configured!

                    You're building for PRODUCTION but haven't set up your production Supabase project.

                    Steps to fix:
                    1. Create a new Supabase project for production
                    2. Update SupabaseConfig.swift with your production URL and anon key
                    3. Deploy edge functions to the production project
                    4. Set up Stripe secrets in production project

                    Or switch to Development build configuration to use the dev environment.
                    """)
            }
        }

        // Check that we're not using a service role key
        guard !anonPublicKey.contains("service_role") && !anonPublicKey.contains("secret") else {
            fatalError("""
                ⚠️ SECURITY ERROR: Service role key detected in client configuration!
                Please use the 'anon public' key instead.
                Find it in Supabase Dashboard → Settings → API → anon public key
                """)
        }

        // Check that the key looks like a valid JWT
        guard anonPublicKey.starts(with: "eyJ") else {
            print("⚠️ WARNING: Supabase anon key not configured. Please add your anon public key.")
            return false
        }

        // Check URL is valid
        guard URL(string: projectURL) != nil else {
            print("⚠️ WARNING: Invalid Supabase project URL")
            return false
        }

        return true
    }
}
