//
//  AnalyticsService.swift
//  Native Intelligence
//
//  PostHog analytics wrapper — replaces Supabase analytics_events tracking
//

import Foundation
import PostHog

class AnalyticsService {
    static let shared = AnalyticsService()

    private init() {}

    // MARK: - Setup

    func setup() {
        let config = PostHogConfig(apiKey: AnalyticsConfig.apiKey, host: AnalyticsConfig.host)
        config.captureApplicationLifecycleEvents = true
        config.captureScreenViews = false
        config.flushAt = 20
        config.flushIntervalSeconds = 30

        PostHogSDK.shared.setup(config)

        // Register super properties so every event includes platform + environment
        PostHogSDK.shared.register([
            "platform": "ios",
            "environment": AnalyticsConfig.currentEnvironment.description.lowercased(),
        ])

        // Identify with device ID by default (anonymous)
        let deviceId = DeviceManager.shared.deviceId
        PostHogSDK.shared.identify(deviceId)

        print("📊 AnalyticsService: Initialized with PostHog (\(AnalyticsConfig.currentEnvironment.description))")
    }

    // MARK: - Identity

    func identifyUser(userId: UUID, email: String?) {
        let userIdString = userId.uuidString
        let deviceId = DeviceManager.shared.deviceId

        // Identify with user ID
        var properties: [String: Any] = [:]
        if let email = email {
            properties["email"] = email
        }
        PostHogSDK.shared.identify(userIdString, userProperties: properties)

        // Alias device ID to user ID so pre-auth events merge
        PostHogSDK.shared.alias(deviceId)

        // Alias email to user ID so the website early-access identity
        // (identified by email) merges with this app identity (by UUID)
        if let email = email {
            PostHogSDK.shared.alias(email)
        }

        print("📊 AnalyticsService: Identified user \(email ?? userIdString)")
    }

    func reset() {
        PostHogSDK.shared.reset()

        // Re-identify with device ID after reset
        let deviceId = DeviceManager.shared.deviceId
        PostHogSDK.shared.identify(deviceId)

        print("📊 AnalyticsService: Reset and re-identified with device ID")
    }

    // MARK: - App Lifecycle Events

    func trackAppLaunched() {
        let deviceInfo = DeviceManager.shared.getDeviceInfo()
        PostHogSDK.shared.capture("app_launched", properties: [
            "app_version": deviceInfo.appVersion,
            "os_version": deviceInfo.osVersion,
            "device_model": deviceInfo.model,
        ])
    }

    // MARK: - Chat Events

    /// Thumbs up / down on an assistant reply. `reaction` is "up", "down", or
    /// "none" when the user un-taps the one they had set.
    func trackChatMessageReaction(reaction: String) {
        PostHogSDK.shared.capture("chat_message_reaction", properties: [
            "reaction": reaction,
        ])
    }

    // MARK: - User Properties Sync

    /// Syncs rich user properties to PostHog so the People tab shows subscription status,
    /// configured AI providers, onboarding state, etc. Call after sign-in, feature sync,
    /// purchase completion, and AI provider configuration changes.
    func syncUserProperties() {
        guard let userId = SupabaseManager.shared.currentUser?.id else { return }

        let deviceInfo = DeviceManager.shared.getDeviceInfo()
        // Embeddings are the one AI feature the app calls (through the server proxy).
        let embeddingsReady = EmbeddingService.shared.hasAPIKey()

        // Purchase state belonged to the retired Mac app; iOS has none, so these stay at their defaults
        let subscriptionStatus = "unknown"
        let trialDaysRemaining = 0
        let isInTrial = false
        let hasSTTPurchased = false
        let hasTTSPurchased = false
        let hasCompleteBundle = false

        let properties: [String: Any] = [
            "app_version": deviceInfo.appVersion,
            "os_version": deviceInfo.osVersion,
            "subscription_status": subscriptionStatus,
            "is_in_trial": isInTrial,
            "trial_days_remaining": trialDaysRemaining,
            "has_stt_purchased": hasSTTPurchased,
            "has_tts_purchased": hasTTSPurchased,
            "has_complete_bundle": hasCompleteBundle,
            "onboarding_completed": UserDefaults.standard.hasCompletedOnboarding,
            "openai_configured": embeddingsReady,
            "ai_providers_configured_count": embeddingsReady ? 1 : 0,
        ]

        PostHogSDK.shared.identify(userId.uuidString, userProperties: properties)
    }
}
