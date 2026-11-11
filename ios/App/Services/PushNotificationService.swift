//
//  PushNotificationService.swift
//  Native Intelligence
//
//  Pushes from the server (web/src/lib/push): team chat messages and the
//  agent's messages while the person is away from every app.
//
//  - Permission is asked when it means something: the first time team chat
//    opens, never at launch. Once granted, every signed-in launch registers
//    again, so a token Apple rotated reaches the server (last_seen moves).
//  - The token goes to the server as the person (migration 562's
//    push_token_register: their own install only), and is taken off before
//    they sign out (push_token_remove), so a phone handed on never gets the
//    last person's messages.
//  - In the foreground a push for the conversation on screen shows nothing
//    (the message is right there); any other shows its banner.
//  - A tap opens where the push says (TeamChatRouter), switching workspace
//    first when it is another workspace's.
//  - The badge is the server's (563's team_chat_badge) on every push; the app
//    sets it again whenever team chat reads its list.
//

import Foundation
import Supabase
import UIKit
import UserNotifications

@MainActor
final class PushNotificationService: NSObject, ObservableObject {
    static let shared = PushNotificationService()

    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined

    private let center = UNUserNotificationCenter.current()
    private static let tokenKey = "push_device_token_hex"

    /// Apple's environment this build's tokens come from: a Development build is signed for
    /// the sandbox (Config/Dial8-Development.entitlements), Release for production.
    static var environment: String {
        #if DEVELOPMENT
        return "sandbox"
        #else
        return "production"
        #endif
    }

    private override init() {
        super.init()
    }

    /// At launch (the app delegate): the delegate is set before any push can be tapped.
    func start() {
        center.delegate = self
        NotificationCenter.default.addObserver(forName: .authenticationComplete, object: nil, queue: .main) { _ in
            Task { @MainActor in await PushNotificationService.shared.registerIfAllowed() }
        }
        NotificationCenter.default.addObserver(forName: .userSignedIn, object: nil, queue: .main) { _ in
            Task { @MainActor in await PushNotificationService.shared.registerIfAllowed() }
        }
        Task { await registerIfAllowed() }
    }

    /// Signed in and already allowed: register again (the token may have changed).
    func registerIfAllowed() async {
        let settings = await center.notificationSettings()
        authorization = settings.authorizationStatus
        guard SupabaseManager.shared.isAuthenticated else { return }
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
        default:
            break
        }
    }

    /// The first time team chat opens: ask, then register. Asked once; a "no" is the person's.
    func askIfUndecided() async {
        let settings = await center.notificationSettings()
        authorization = settings.authorizationStatus
        guard settings.authorizationStatus == .notDetermined else {
            await registerIfAllowed()
            return
        }
        let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        authorization = granted ? .authorized : .denied
        if granted { UIApplication.shared.registerForRemoteNotifications() }
    }

    // MARK: - The token

    func didRegister(deviceToken: Data) {
        let hex = PushToken.hex(deviceToken)
        UserDefaults.standard.set(hex, forKey: Self.tokenKey)
        Task { await upload(hex) }
    }

    func didFailToRegister(_ error: Error) {
        print("⚠️ Push: registration failed: \(error.localizedDescription)")
    }

    private func upload(_ hex: String) async {
        guard SupabaseManager.shared.isAuthenticated else { return }
        do {
            try await SupabaseManager.shared.client
                .rpc("push_token_register", params: [
                    "device_token": hex,
                    "token_environment": Self.environment,
                    "app_bundle_id": Bundle.main.bundleIdentifier ?? "",
                    "name_of_device": UIDevice.current.name,
                ])
                .execute()
            print("🔔 Push: install registered (\(Self.environment))")
        } catch {
            print("❌ Push: register failed: \(error)")
        }
    }

    /// Before signing out (while the session still works): this install is taken off the person.
    func unregister() async {
        guard let hex = UserDefaults.standard.string(forKey: Self.tokenKey) else { return }
        do {
            try await SupabaseManager.shared.client.rpc("push_token_remove", params: ["device_token": hex]).execute()
        } catch {
            print("⚠️ Push: remove failed: \(error)")
        }
        try? await center.setBadgeCount(0)
        center.removeAllDeliveredNotifications()
    }
}

extension PushNotificationService: UNUserNotificationCenterDelegate {
    /// In the foreground: nothing for the conversation on screen, a banner for anything else.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let route = PushRoute.parse(notification.request.content.userInfo)
        return await MainActor.run {
            if case .teamChat = route { TeamChatStore.shared.refreshSoon() }
            let shows = PushPresentation.showsBanner(route, onScreen: TeamChatStore.shared.onScreen, chatOpen: TeamChatRouter.shared.chatOpen)
            return shows ? [.banner, .list, .sound, .badge] : [.badge]
        }
    }

    /// Tapped: open where it says.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let route = PushRoute.parse(response.notification.request.content.userInfo) else { return }
        await TeamChatRouter.shared.open(route)
    }
}

/// The app delegate: APNs hands the device token here, and the notification delegate is set at launch.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-previewEveChat") || ProcessInfo.processInfo.arguments.contains("-previewTeamChat") { return true }
        #endif
        MainActor.assumeIsolated { PushNotificationService.shared.start() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { PushNotificationService.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        MainActor.assumeIsolated { PushNotificationService.shared.didFailToRegister(error) }
    }
}
