//
//  SupabaseManager.swift
//  dial8
//
//  Manages all Supabase interactions including auth, database, and realtime
//

import Foundation
import Supabase
import Combine
import UIKit

// MARK: - Database Models

class SupabaseManager: ObservableObject {
    static let shared = SupabaseManager()

    // MARK: - Properties

    private(set) var client: SupabaseClient
    @Published private(set) var currentUser: User?
    @Published private(set) var isAuthenticated = false
    @Published private(set) var hasCheckedInitialSession = false
    @Published private(set) var isLoading = false
    @Published private(set) var error: Error?
    @Published private(set) var activeEnvironment: SupabaseConfig.Environment

    private var cancellables = Set<AnyCancellable>()
    private var authStateListener: Task<Void, Never>?

    // MARK: - Initialization

    private init() {
        let env = SupabaseConfig.currentEnvironment
        self.activeEnvironment = env

        // Validate configuration
        guard SupabaseConfig.validateConfiguration() else {
            fatalError("Invalid Supabase configuration. Please check your API keys.")
        }

        // Initialize Supabase client
        self.client = SupabaseClient(
            supabaseURL: URL(string: env.projectURL)!,
            supabaseKey: env.anonPublicKey
        )

        // Setup auth state listener
        setupAuthListener()

        print("🔷 SupabaseManager: Initialized with project: \(env.projectURL)")
    }

    // MARK: - Environment Switching

    /// Switch to a different Supabase environment at runtime.
    /// This signs out the current user and recreates the client.
    @MainActor
    func switchEnvironment(_ env: SupabaseConfig.Environment) async {
        guard env != activeEnvironment else { return }

        print("🔷 SupabaseManager: Switching environment to \(env.description)...")

        // Sign out from current environment
        try? await client.auth.signOut()
        authStateListener?.cancel()

        // Update the persistent override
        SupabaseConfig.setOverride(env)
        activeEnvironment = env
        currentUser = nil
        isAuthenticated = false
        hasCheckedInitialSession = false

        // Recreate client
        client = SupabaseClient(
            supabaseURL: URL(string: env.projectURL)!,
            supabaseKey: env.anonPublicKey
        )

        // Re-setup auth listener for the new client
        setupAuthListener()

        print("🔷 SupabaseManager: Now using \(env.description) (\(env.projectURL))")
    }

    deinit {
        authStateListener?.cancel()
    }

    // MARK: - Authentication

    private func setupAuthListener() {
        authStateListener = Task {
            for await (event, session) in client.auth.authStateChanges {
                await MainActor.run {
                    switch event {
                    case .signedIn:
                        if let session = session {
                            self.currentUser = session.user
                            self.isAuthenticated = true
                            print("🔷 SupabaseManager: User authenticated: \(session.user.email ?? "No email")")

                            // Identify user in PostHog
                            AnalyticsService.shared.identifyUser(userId: session.user.id, email: session.user.email)

                            // Sync user properties after a brief delay to let FeatureManager load
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                                AnalyticsService.shared.syncUserProperties()
                            }

                            // Resolve the user's workspace/team/status context. Every
                            // workspace-scoped write depends on this, so bootstrap eagerly.
                            self.bootstrapWorkspace()

                            // Notify the app that user signed in (different from initial session restore)
                            NotificationCenter.default.post(name: .userSignedIn, object: nil)
                        }

                    case .signedOut:
                        self.currentUser = nil
                        self.isAuthenticated = false
                        print("🔷 SupabaseManager: User signed out")

                        // Reset PostHog identity
                        AnalyticsService.shared.reset()

                        // Clear cached workspace context
                        WorkspaceService.shared.reset()

                        // Notify the app that user signed out
                        NotificationCenter.default.post(name: .userSignedOut, object: nil)

                    case .initialSession:
                        if let session = session {
                            self.currentUser = session.user
                            self.isAuthenticated = true
                            print("🔷 SupabaseManager: Initial session restored")

                            // Identify user in PostHog
                            AnalyticsService.shared.identifyUser(userId: session.user.id, email: session.user.email)

                            // Sync user properties after a brief delay to let FeatureManager load
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                                AnalyticsService.shared.syncUserProperties()
                            }

                            // Resolve the user's workspace/team/status context on
                            // session restore too, so a relaunched app can write.
                            self.bootstrapWorkspace()

                            // Notify observers that authentication is complete (session restored)
                            NotificationCenter.default.post(name: .authenticationComplete, object: nil)
                        }
                        self.hasCheckedInitialSession = true

                    default:
                        break
                    }
                }
            }
        }
    }

    /// Kick off workspace/team/status resolution for the signed-in user.
    /// Fire-and-forget: failures are surfaced via `WorkspaceService.lastError`
    /// and do not block the auth flow. Safe to call repeatedly (idempotent).
    private func bootstrapWorkspace() {
        Task { @MainActor in
            do {
                try await WorkspaceService.shared.bootstrap()
            } catch {
                print("❌ SupabaseManager: workspace bootstrap failed: \(error)")
            }
        }
    }

    func signUpWithEmail(email: String, password: String) async throws {
        await MainActor.run {
            isLoading = true
            error = nil
        }

        defer {
            Task { @MainActor in
                isLoading = false
            }
        }

        do {
            // Set redirect URL for email confirmation
            #if PRODUCTION
            let redirectURL = URL(string: "https://dial8.ai/welcome")!
            #else
            let redirectURL = URL(string: "http://localhost:3000/welcome")!
            #endif

            let response = try await client.auth.signUp(
                email: email,
                password: password,
                redirectTo: redirectURL
            )

            print("🔷 SupabaseManager: User signed up: \(response.user.email ?? "No email"), confirmation will redirect to: \(redirectURL.absoluteString)")

            // Note: Don't post authenticationComplete here - the user needs to verify their email first.
            // The auth state listener will handle posting the notification when they actually sign in.
        } catch {
            await MainActor.run {
                self.error = error
            }
            print("❌ SupabaseManager: Sign up failed: \(error)")
            throw error
        }
    }

    func signInWithEmail(email: String, password: String) async throws {
        await MainActor.run {
            isLoading = true
            error = nil
        }

        defer {
            Task { @MainActor in
                isLoading = false
            }
        }

        do {
            let session = try await client.auth.signIn(
                email: email,
                password: password
            )

            print("🔷 SupabaseManager: User signed in: \(session.user.email ?? "No email")")

            // Link device to account after successful signin
            if currentUser != nil {
                try await linkDeviceToAccount()
            }

            // Notify app of successful auth
            await MainActor.run {
                NotificationCenter.default.post(name: .authenticationComplete, object: nil)
            }
        } catch {
            await MainActor.run {
                self.error = error
            }
            print("❌ SupabaseManager: Sign in failed: \(error)")
            throw error
        }
    }

    func resetPasswordForEmail(_ email: String) async throws {
        await MainActor.run {
            isLoading = true
            error = nil
        }

        defer {
            Task { @MainActor in
                isLoading = false
            }
        }

        do {
            // Use the welcome page as redirect with type=recovery parameter
            // This ensures the welcome page knows it's a password reset
            #if PRODUCTION
            let redirectURL = URL(string: "https://dial8.ai/welcome?type=recovery")!
            #else
            let redirectURL = URL(string: "http://localhost:3000/welcome?type=recovery")!
            #endif

            try await client.auth.resetPasswordForEmail(
                email,
                redirectTo: redirectURL
            )
            print("🔷 SupabaseManager: Password reset email sent to: \(email) with redirect: \(redirectURL)")
        } catch {
            await MainActor.run {
                self.error = error
            }
            print("❌ SupabaseManager: Password reset failed: \(error)")
            throw error
        }
    }

    func signInWithProvider(_ provider: Provider) async throws {
        await MainActor.run {
            isLoading = true
            error = nil
        }

        defer {
            Task { @MainActor in
                isLoading = false
            }
        }

        do {
            // Redirect to welcome page after successful OAuth
            // The welcome page will then redirect back to the app via dial8://auth-callback
            #if PRODUCTION
            let redirectURL = URL(string: "https://dial8.ai/welcome")!
            #else
            let redirectURL = URL(string: "http://localhost:3000/welcome")!
            #endif

            let oauthURL = try client.auth.getOAuthSignInURL(
                provider: provider,
                redirectTo: redirectURL
            )

            // Debug: Print the full OAuth URL
            print("🔷 SupabaseManager: OAuth URL: \(oauthURL.absoluteString)")
            print("🔷 SupabaseManager: Redirect URL: \(redirectURL.absoluteString)")

            // Open in default browser
            await MainActor.run {
                UIApplication.shared.open(oauthURL)
            }

            print("🔷 SupabaseManager: Initiated OAuth with \(provider), redirecting to dial8.ai/welcome")
        } catch {
            await MainActor.run {
                self.error = error
            }
            print("❌ SupabaseManager: OAuth failed: \(error)")
            throw error
        }
    }

    func handleOAuthCallback(_ url: URL) async throws {
        do {
            let session = try await client.auth.session(from: url)
            print("🔷 SupabaseManager: OAuth callback handled, user: \(session.user.email ?? "No email")")

            // Wait a moment for auth state to update
            try await Task.sleep(nanoseconds: 500_000_000) // 0.5 seconds

            // Link device to account after auth state is ready
            if currentUser != nil {
                try await linkDeviceToAccount()
            } else {
                print("⚠️ SupabaseManager: Waiting for auth state to update before linking device")
            }

            // Notify app of successful auth
            await MainActor.run {
                NotificationCenter.default.post(name: .authenticationComplete, object: nil)
            }
        } catch {
            print("❌ SupabaseManager: OAuth callback failed: \(error)")

            // Check if this might be a password reset that's incorrectly formatted
            let errorMessage = error.localizedDescription.lowercased()
            if errorMessage.contains("flow_state_not_found") || errorMessage.contains("flow state") {
                print("⚠️ SupabaseManager: This might be a password reset link. Please check Supabase email template configuration.")
            }

            throw error
        }
    }

    func signOut() async throws {
        do {
            try await client.auth.signOut()
            print("🔷 SupabaseManager: Signed out successfully")
        } catch {
            print("❌ SupabaseManager: Sign out failed: \(error)")
            throw error
        }
    }

    // MARK: - Device Management

    func linkDeviceToAccount() async throws {
        guard let userId = currentUser?.id else {
            throw SupabaseError.authRequired
        }

        let deviceInfo = DeviceManager.shared.getDeviceInfo()
        let deviceId = DeviceManager.shared.deviceId

        // Use the new track_device_activity function to handle device tracking
        do {
            // Call the Supabase function to track device activity
            let _ = try await client.rpc(
                "track_device_activity",
                params: [
                    "p_user_id": userId.uuidString,
                    "p_device_id": deviceId,
                    "p_device_model": deviceInfo.model,
                    "p_os_version": deviceInfo.osVersion,
                    "p_app_version": deviceInfo.appVersion
                ]
            ).execute()

            print("🔷 SupabaseManager: Tracked device activity for user")

            // Note: We no longer need to transfer purchases since they're account-only now

        } catch {
            print("⚠️ SupabaseManager: Device tracking error: \(error)")
            // Don't throw - device tracking is not critical for auth success
        }
    }

    // MARK: - Insights Suggestions

    /// Dismiss a suggestion with optional feedback
    func dismissSuggestion(id: UUID, feedback: String? = nil) async throws {
        var updates: [String: String] = [
            "status": "dismissed",
            "user_action_at": ISO8601DateFormatter().string(from: Date())
        ]

        if let feedback = feedback {
            updates["user_feedback"] = feedback
        }

        try await client
            .from("insights_suggestions")
            .update(updates)
            .eq("id", value: id.uuidString)
            .execute()

        print("❌ SupabaseManager: Dismissed suggestion \(id)")
    }

    // MARK: - Action Reads
    //
    // These all embed `workflow_state` because `actions` has no `status`
    // column: an action's lifecycle is the category of the board column that
    // `status_id` points at. Filtering on that embedded category needs the
    // `!inner` join form — see `ActionsService.actionSelectInner`.

    // MARK: - Storage Operations

    /// Upload file to Supabase Storage
    /// - Parameters:
    ///   - bucket: Storage bucket name
    ///   - path: Path within the bucket (e.g., "user_id/note_id/file.png")
    ///   - data: File data to upload
    ///   - contentType: MIME type of the file
    /// - Returns: The storage path of the uploaded file
    func uploadFile(bucket: String, path: String, data: Data, contentType: String) async throws -> String {
        print("📦 SupabaseManager: Uploading file to \(bucket)/\(path) (\(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)))")

        try await client.storage
            .from(bucket)
            .upload(
                path,
                data: data,
                options: FileOptions(contentType: contentType)
            )

        print("📦 SupabaseManager: Upload complete: \(path)")
        return path
    }

    /// Delete file from Supabase Storage
    /// - Parameters:
    ///   - bucket: Storage bucket name
    ///   - path: Path within the bucket
    func deleteFile(bucket: String, path: String) async throws {
        print("📦 SupabaseManager: Deleting file \(bucket)/\(path)")

        try await client.storage
            .from(bucket)
            .remove(paths: [path])

        print("📦 SupabaseManager: Deleted \(path)")
    }

    /// Get a signed URL for temporary access to a private file
    /// - Parameters:
    ///   - bucket: Storage bucket name
    ///   - path: Path within the bucket
    ///   - expiresIn: Expiration time in seconds (default: 1 hour)
    /// - Returns: Signed URL for accessing the file
    func getSignedURL(bucket: String, path: String, expiresIn: Int = 3600) async throws -> URL {
        print("📦 SupabaseManager: Generating signed URL for \(bucket)/\(path)")

        let signedURL = try await client.storage
            .from(bucket)
            .createSignedURL(path: path, expiresIn: expiresIn)

        print("📦 SupabaseManager: Generated signed URL (expires in \(expiresIn)s)")
        return signedURL
    }

    /// Get public URL for a file (only works for public buckets)
    /// - Parameters:
    ///   - bucket: Storage bucket name
    ///   - path: Path within the bucket
    /// - Returns: Public URL for accessing the file
    func getPublicURL(bucket: String, path: String) throws -> URL {
        let publicURL = try client.storage
            .from(bucket)
            .getPublicURL(path: path)

        return publicURL
    }
}

// MARK: - Custom Errors

enum SupabaseError: LocalizedError {
    case authRequired
    case invalidConfiguration
    case networkError(Error)

    var errorDescription: String? {
        switch self {
        case .authRequired:
            return "Authentication required"
        case .invalidConfiguration:
            return "Invalid Supabase configuration"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        }
    }
}

// MARK: - Provider Extension

extension Provider {
    var displayName: String {
        switch self {
        case .apple: return "Apple"
        case .google: return "Google"
        case .github: return "GitHub"
        case .facebook: return "Facebook"
        case .discord: return "Discord"
        default: return String(describing: self)
        }
    }

    var icon: String {
        switch self {
        case .apple: return "apple.logo"
        case .google: return "globe"
        case .github: return "chevron.left.forwardslash.chevron.right"
        case .facebook: return "f.square"
        case .discord: return "bubble.left.and.bubble.right"
        default: return "person.circle"
        }
    }
}

// MARK: - Notification Names

extension Notification.Name {
    static let authenticationComplete = Notification.Name("authenticationComplete")
    static let userSignedIn = Notification.Name("userSignedIn")
    static let userSignedOut = Notification.Name("userSignedOut")
    static let trialExpired = Notification.Name("trialExpired")
    static let featurePurchased = Notification.Name("featurePurchased")
    static let featuresUnlocked = Notification.Name("featuresUnlocked")
    static let featuresLocked = Notification.Name("featuresLocked")
}
