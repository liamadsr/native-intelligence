//
//  PushNotificationService.swift
//  Native Intelligence
//
//  Pushes from the server (web/src/lib/push): team chat messages and the
//  agent's messages while the person is away from every app.
//
//  - Permission is asked when it means something: the first time team chat
//    opens, never at launch.
//  - On every launch and every return to the foreground the app reads what
//    iOS Settings say (PushSync): allowed, it registers again (the server's
//    last_seen_at moves, and the server pushes only to installs seen within
//    30 days); turned off, or nothing would show, it takes the install off
//    (push_token_remove), so the server sends the text, Slack or email the
//    person will actually see instead of a push nobody sees.
//  - The token goes to the server as the person (migration 562's
//    push_token_register: their own install only). It never outlives the
//    session: before an explicit sign-out it is removed as the person, and
//    when the session ends any other way (expired, its refresh failed) it is
//    forgotten by the token alone (push_token_forget, no sign-in needed). A
//    removal that can't reach the server (offline) is remembered and done on
//    the next launch, before anything is registered.
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
    /// This phone's APNs token, as hex (the device's, whoever is signed in).
    private static let tokenKey = "push_device_token_hex"
    /// The server holds this install for the signed-in person.
    private static let registeredKey = "push_token_registered"
    /// A removal that didn't reach the server yet: done before anything is registered.
    private static let pendingForgetKey = "push_token_pending_forget"

    private var defaults: UserDefaults { .standard }

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
        let resync: @Sendable (Notification) -> Void = { _ in
            Task { @MainActor in await PushNotificationService.shared.sync() }
        }
        NotificationCenter.default.addObserver(forName: .authenticationComplete, object: nil, queue: .main, using: resync)
        NotificationCenter.default.addObserver(forName: .userSignedIn, object: nil, queue: .main, using: resync)
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main, using: resync)
        // The session ended, however it ended: this install stops getting the person's pushes.
        NotificationCenter.default.addObserver(forName: .userSignedOut, object: nil, queue: .main) { _ in
            Task { @MainActor in await PushNotificationService.shared.forget() }
        }
        Task { await sync() }
    }

    /// Launch, sign-in, every return to the foreground: what Settings say now, told to the server.
    func sync() async {
        await flushPendingForget()
        let settings = await center.notificationSettings()
        authorization = settings.authorizationStatus
        let action = PushSync.action(
            Self.authorization(of: settings.authorizationStatus),
            alertsVisible: Self.alertsVisible(settings),
            signedIn: SupabaseManager.shared.isAuthenticated,
            registered: defaults.bool(forKey: Self.registeredKey)
        )
        switch action {
        case .register:
            UIApplication.shared.registerForRemoteNotifications()
        case .remove:
            await removeAsPerson()
        case .wait:
            break
        }
    }

    /// The first time team chat opens: ask, then register. Asked once; a "no" is the person's.
    func askIfUndecided() async {
        let settings = await center.notificationSettings()
        authorization = settings.authorizationStatus
        guard settings.authorizationStatus == .notDetermined else {
            await sync()
            return
        }
        let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        authorization = granted ? .authorized : .denied
        if granted { UIApplication.shared.registerForRemoteNotifications() }
    }

    private static func authorization(of status: UNAuthorizationStatus) -> PushAuthorization {
        switch status {
        case .authorized, .provisional, .ephemeral: return .allowed
        case .denied: return .denied
        default: return .notDetermined
        }
    }

    /// Whether a push would show anywhere: a banner, the lock screen or Notification Center.
    private static func alertsVisible(_ s: UNNotificationSettings) -> Bool {
        s.alertSetting == .enabled || s.lockScreenSetting == .enabled || s.notificationCenterSetting == .enabled
    }

    // MARK: - The token

    func didRegister(deviceToken: Data) {
        let hex = PushToken.hex(deviceToken)
        defaults.set(hex, forKey: Self.tokenKey)
        Task { await upload(hex) }
    }

    func didFailToRegister(_ error: Error) {
        print("⚠️ Push: registration failed: \(error.localizedDescription)")
    }

    private func upload(_ hex: String) async {
        // A removal still owed goes first; while it can't reach the server, nothing is registered.
        guard await flushPendingForget(), SupabaseManager.shared.isAuthenticated else { return }
        do {
            try await SupabaseManager.shared.client
                .rpc("push_token_register", params: [
                    "device_token": hex,
                    "token_environment": Self.environment,
                    "app_bundle_id": Bundle.main.bundleIdentifier ?? "",
                    "name_of_device": UIDevice.current.name,
                ])
                .execute()
            defaults.set(true, forKey: Self.registeredKey)
            print("🔔 Push: install registered (\(Self.environment))")
        } catch {
            print("❌ Push: register failed: \(error)")
        }
    }

    /// Notifications turned off: this install comes off the person (as the person).
    private func removeAsPerson() async {
        guard let hex = defaults.string(forKey: Self.tokenKey) else { return }
        do {
            try await SupabaseManager.shared.client.rpc("push_token_remove", params: ["device_token": hex]).execute()
            defaults.set(false, forKey: Self.registeredKey)
        } catch {
            print("⚠️ Push: remove failed: \(error)")
        }
    }

    /// Before an explicit sign-out (while the session still works): this install comes off the person.
    func unregister() async {
        await removeAsPerson()
        try? await center.setBadgeCount(0)
        center.removeAllDeliveredNotifications()
    }

    /// The session has ended (any way): the install is forgotten by its token alone. Offline, it is
    /// remembered and done on the next launch, before anything is registered.
    func forget() async {
        guard let hex = defaults.string(forKey: Self.tokenKey) else { return }
        defaults.set(hex, forKey: Self.pendingForgetKey)
        defaults.set(false, forKey: Self.registeredKey)
        try? await center.setBadgeCount(0)
        center.removeAllDeliveredNotifications()
        await flushPendingForget()
    }

    /// Do a removal still owed. True when nothing is owed any more.
    @discardableResult
    private func flushPendingForget() async -> Bool {
        guard let hex = defaults.string(forKey: Self.pendingForgetKey) else { return true }
        do {
            try await SupabaseManager.shared.client.rpc("push_token_forget", params: ["device_token": hex]).execute()
            defaults.removeObject(forKey: Self.pendingForgetKey)
            return true
        } catch {
            print("⚠️ Push: forget failed, kept for the next launch: \(error)")
            return false
        }
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
/// PushKit's registry and the call center start here too: a team call's ring can be what launched the app.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        #if DEBUG
        let previews = ["-previewEveChat", "-previewTeamChat", "-previewTeamCall"]
        if previews.contains(where: ProcessInfo.processInfo.arguments.contains) { return true }
        #endif
        MainActor.assumeIsolated {
            PushNotificationService.shared.start()
            TeamCallCenter.shared.start()
            VoIPPushService.shared.start()
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { PushNotificationService.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        MainActor.assumeIsolated { PushNotificationService.shared.didFailToRegister(error) }
    }
}
