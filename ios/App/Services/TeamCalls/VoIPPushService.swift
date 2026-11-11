//
//  VoIPPushService.swift
//  Native Intelligence
//
//  PushKit: the phone's VoIP token, and the team call rings that arrive on
//  it (web/src/lib/team-calls/ring-push.ts), kept thin. What a push means is
//  TeamCallBook's; TeamCallCenter reports it to CallKit before the handler
//  returns, as Apple requires.
//
//  The token's lifecycle is the alert token's (PushNotificationService):
//  registered as the person on every signed-in launch and return
//  (push_token_register, kind 'voip', migration 570: last seen moves, the
//  server rings only installs seen within 30 days); removed as the person
//  before an explicit sign-out; forgotten by the token alone when the session
//  ends any other way; a removal that can't reach the server is done on the
//  next launch before anything is registered. Calls ring whatever the
//  notification settings say (like a phone call): turning banners off does
//  not take the VoIP token off.
//
//  The registry is made at launch, every launch: a ring can be what launched
//  the app, and PushKit hands the push only to a registry that exists.
//

import Foundation
import PushKit
import UIKit

@MainActor
final class VoIPPushService: NSObject {
    static let shared = VoIPPushService()

    /// This phone's VoIP token, as hex (the device's, whoever is signed in).
    private(set) var token: String? {
        get { defaults.string(forKey: Self.tokenKey) }
        set { defaults.set(newValue, forKey: Self.tokenKey) }
    }

    private static let tokenKey = "voip_push_token_hex"
    private static let pendingForgetKey = "voip_push_token_pending_forget"

    /// A sign-out's removal hasn't reached the server yet: pushes still meant for that person may arrive.
    var forgetPending: Bool { defaults.string(forKey: Self.pendingForgetKey) != nil }
    private var defaults: UserDefaults { .standard }
    private var registry: PKPushRegistry?

    private override init() {
        super.init()
    }

    /// At launch (the app delegate), before anything else can need it.
    func start() {
        guard registry == nil else { return }
        let r = PKPushRegistry(queue: .main)
        r.delegate = self
        r.desiredPushTypes = [.voIP]
        registry = r
        let resync: @Sendable (Notification) -> Void = { _ in
            Task { @MainActor in await VoIPPushService.shared.sync() }
        }
        NotificationCenter.default.addObserver(forName: .authenticationComplete, object: nil, queue: .main, using: resync)
        NotificationCenter.default.addObserver(forName: .userSignedIn, object: nil, queue: .main, using: resync)
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main, using: resync)
        NotificationCenter.default.addObserver(forName: .userSignedOut, object: nil, queue: .main) { _ in
            Task { @MainActor in await VoIPPushService.shared.forget() }
        }
        Task { await sync() }
    }

    /// Signed in, with a token: the server holds it for the person (last seen moves).
    func sync() async {
        guard await flushPendingForget(), SupabaseManager.shared.isAuthenticated, let token else { return }
        do {
            try await SupabaseManager.shared.client
                .rpc("push_token_register", params: [
                    "device_token": token,
                    "token_environment": PushNotificationService.environment,
                    "app_bundle_id": Bundle.main.bundleIdentifier ?? "",
                    "name_of_device": UIDevice.current.name,
                    "token_kind": "voip",
                ])
                .execute()
            print("📞 VoIP push: install registered (\(PushNotificationService.environment))")
        } catch {
            print("❌ VoIP push: register failed: \(error)")
        }
    }

    /// Before an explicit sign-out (while the session still works): this install comes off the person.
    func unregister() async {
        guard let token else { return }
        do {
            try await SupabaseManager.shared.client.rpc("push_token_remove", params: ["device_token": token]).execute()
        } catch {
            print("⚠️ VoIP push: remove failed: \(error)")
        }
    }

    /// The session has ended (any way): forgotten by the token alone; offline, done on the next launch.
    func forget() async {
        guard let token else { return }
        defaults.set(token, forKey: Self.pendingForgetKey)
        await flushPendingForget()
    }

    @discardableResult
    private func flushPendingForget() async -> Bool {
        guard let hex = defaults.string(forKey: Self.pendingForgetKey) else { return true }
        do {
            try await SupabaseManager.shared.client.rpc("push_token_forget", params: ["device_token": hex]).execute()
            defaults.removeObject(forKey: Self.pendingForgetKey)
            return true
        } catch {
            print("⚠️ VoIP push: forget failed, kept for the next launch: \(error)")
            return false
        }
    }
}

extension VoIPPushService: PKPushRegistryDelegate {
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let hex = PushToken.hex(pushCredentials.token)
        MainActor.assumeIsolated {
            let changed = token != hex
            token = hex
            if changed { Task { await sync() } }
        }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        MainActor.assumeIsolated {
            Task {
                await forget()
                token = nil
            }
        }
    }

    /// Before iOS 26.4: every VoIP push owes a reported call.
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        guard type == .voIP else {
            completion()
            return
        }
        MainActor.assumeIsolated {
            TeamCallCenter.shared.voipPush(payload.dictionaryPayload, mustReport: true, completion: completion)
        }
    }

    /// iOS 26.4 and later: the system says whether this push owes a reported call (not in the
    /// foreground, not while on a call, not for a push delayed too long).
    @available(iOS 26.4, *)
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingVoIPPushWith payload: PKPushPayload, metadata: PKVoIPPushMetadata, withCompletionHandler completion: @escaping () -> Void) {
        let mustReport = metadata.mustReport
        MainActor.assumeIsolated {
            TeamCallCenter.shared.voipPush(payload.dictionaryPayload, mustReport: mustReport, completion: completion)
        }
    }
}
