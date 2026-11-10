//
//  ChatSessionStore.swift
//  Native Intelligence
//
//  Owns the ONE general-chat view model for the whole iOS app, and remembers
//  which conversation is active across launches.
//
//  Why this exists: the chat is presented as a sheet from iOSMainTabView. A
//  `@StateObject` inside the presented view is rebuilt every time the sheet is
//  presented, so every open produced a brand-new iOSEveChatViewModel — and thus
//  a brand-new conversation. Hoisting the view model into a singleton makes
//  the sheet a *window onto* the active chat rather than the owner of it.
//
//  Persistence is just the thread id: messages themselves live server-side in
//  chat_conversations / chat_messages, so restoring is `loadSession(id)`.
//  Legacy agent_threads / agent_messages remain readable during migration.
//

import Foundation
import Combine

@MainActor
final class ChatSessionStore {

    // MARK: - Singleton

    static let shared = ChatSessionStore()

    // MARK: - Storage Keys

    /// The legacy, un-keyed slot. A thread belongs to exactly ONE workspace, so
    /// a single global key meant switching workspaces restored a conversation the
    /// new workspace can't even read. Migrated into the per-workspace key on
    /// first read, then removed.
    private static let legacySessionKey = "dial8.chat.activeGeneralSessionId"

    /// The active general-chat thread id FOR A WORKSPACE, so relaunching (or
    /// switching back) lands in that workspace's conversation rather than an
    /// empty one — or, worse, another workspace's thread.
    private static func sessionKey(for workspaceId: UUID) -> String {
        "\(legacySessionKey).\(workspaceId.uuidString)"
    }

    // MARK: - State

    /// The single general-mode chat view model. Constructed once, lives for the
    /// process lifetime, and is handed to every presentation of iOSAIChatView.
    let general: iOSEveChatViewModel

    private var cancellables = Set<AnyCancellable>()

    /// The spent-after-one-value "workspace resolved" subscription, kept apart
    /// from `cancellables` so sign-out can re-arm it.
    private var workspaceReadyCancellable: AnyCancellable?

    /// Guards ONE restore per workspace *per switch*: a second call while the
    /// first `loadSession` is still in flight would clear and refetch mid-load.
    ///
    /// Membership is deliberately temporary. Every legitimate reason to restore
    /// again — switching into a workspace, signing out and back in — REMOVES the
    /// id first, so the guard only ever collapses duplicate calls for the same
    /// restore attempt. Leaving ids in here permanently was the bug: switching
    /// A → B → A skipped A's restore entirely and orphaned its thread.
    private var restoredWorkspaceIds: Set<UUID> = []

    /// The workspace whose session id `observeSessionId` should persist under.
    /// Tracked separately from `WorkspaceService.workspaceId` so a session id
    /// that arrives mid-switch can never be written under the new workspace's
    /// key — the sink only ever writes the workspace it was told about.
    private var persistenceWorkspaceId: UUID?

    private let defaults = UserDefaults.standard

    /// Set by Home when the chat is opened from the bottom bar's mic: the sheet's
    /// content may not exist yet when `.startChatDictation` is posted, so the
    /// intent is ALSO parked here and consumed by the chat surface's `.onAppear`.
    /// Whichever path runs first clears it; the other then finds it false.
    var pendingDictationStart = false

    // MARK: - Init

    private init() {
        self.general = iOSEveChatViewModel()
        print("🏗️ ChatSessionStore: created the shared general chat view model")

        observeWorkspaceChanges()
        observeSignOut()

        // Read the stored id BEFORE subscribing: `@Published` replays its current
        // value (nil) to a new subscriber, and that replay would remove the key
        // we are about to restore from.
        let workspaceId = WorkspaceService.shared.workspaceId
        let storedId = workspaceId.flatMap { storedSessionId(for: $0) }

        persistenceWorkspaceId = workspaceId
        observeSessionId()

        if let workspaceId {
            restoreActiveSession(storedId, for: workspaceId)
        } else {
            // Bootstrap hasn't resolved yet (cold launch races the auth
            // listener). `observeWorkspaceReady` picks it up the moment it does,
            // so the restore still happens — just a beat later.
            print("📭 ChatSessionStore: no workspace yet — restore deferred")
            observeWorkspaceReady()
        }
    }

    // MARK: - Persistence

    /// The stored thread id for a workspace, migrating the pre-workspace key on
    /// first read. The legacy value can only have belonged to whatever workspace
    /// was active back then — which is the one bootstrapping now — so adopting
    /// it here preserves the conversation across the upgrade instead of
    /// stranding it.
    private func storedSessionId(for workspaceId: UUID) -> UUID? {
        let key = Self.sessionKey(for: workspaceId)

        if let existing = defaults.string(forKey: key).flatMap({ UUID(uuidString: $0) }) {
            return existing
        }

        if let legacy = defaults.string(forKey: Self.legacySessionKey) {
            defaults.set(legacy, forKey: key)
            defaults.removeObject(forKey: Self.legacySessionKey)
            print("🔀 ChatSessionStore: migrated the legacy chat key into workspace \(workspaceId.uuidString.prefix(8))")
            return UUID(uuidString: legacy)
        }

        return nil
    }

    /// Mirror `currentSessionId` into UserDefaults under the ACTIVE workspace's
    /// key. It becomes non-nil when the first message of a conversation creates
    /// the thread, and nil again on `startNewConversation()` — which is exactly
    /// the "forget the active chat" signal we want.
    private func observeSessionId() {
        general.$currentSessionId
            // `@Published` replays its current value (nil) on subscribe. Acting
            // on that replay would delete the very key the restore is about to
            // use, so only real *changes* are persisted.
            .dropFirst()
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] sessionId in
                guard let self else { return }
                // `persistenceWorkspaceId`, not the live service value: during a
                // switch the view model briefly reports the OLD thread, and
                // writing that under the NEW workspace's key is precisely the
                // cross-workspace leak this whole change exists to stop.
                guard let workspaceId = self.persistenceWorkspaceId else { return }
                let key = Self.sessionKey(for: workspaceId)

                if let sessionId {
                    self.defaults.set(sessionId.uuidString, forKey: key)
                    print("💾 ChatSessionStore: active chat = \(sessionId.uuidString.prefix(8))")
                } else {
                    self.defaults.removeObject(forKey: key)
                    print("💾 ChatSessionStore: cleared the active chat")
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - Workspace

    /// One-shot: wait for the first non-nil workspace id, then run the restore
    /// that `init` couldn't.
    ///
    /// Held in its own slot rather than the shared bag so re-arming it after a
    /// sign-out replaces the spent subscription instead of stacking a new one on
    /// top of it.
    private func observeWorkspaceReady() {
        workspaceReadyCancellable = WorkspaceService.shared.$workspaceId
            .compactMap { $0 }
            .first()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] workspaceId in
                guard let self else { return }
                self.persistenceWorkspaceId = workspaceId
                self.restoreActiveSession(self.storedSessionId(for: workspaceId), for: workspaceId)
            }
    }

    /// A workspace switch means the on-screen conversation belongs to a workspace
    /// the user has left. We do NOT delete it server-side — it is still that
    /// workspace's chat, and switching back restores it. Instead: cut over the
    /// persistence key, start a fresh conversation, then restore the NEW
    /// workspace's stored thread if it has one.
    private func observeWorkspaceChanges() {
        NotificationCenter.default.publisher(for: .workspaceDidChange)
            .compactMap { $0.userInfo?["workspaceId"] as? UUID }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] workspaceId in
                guard let self else { return }

                // Read the new workspace's stored thread FIRST. Clearing the
                // view model publishes `currentSessionId = nil`, and the
                // persistence sink turns that into a key removal — so reading
                // after the clear would race away the very id we want.
                let storedId = self.storedSessionId(for: workspaceId)

                // Suspend persistence across the clear: the nil belongs to
                // neither workspace. Writing it under the old key would erase
                // that workspace's thread; under the new key, this one's.
                self.persistenceWorkspaceId = nil

                // Fresh conversation: the executor and server-side session are
                // tied to the old workspace's context.
                self.general.resetForAccountChange()

                // Resume persistence pointed at the new workspace, after the
                // clear's nil has been delivered on this same main queue.
                DispatchQueue.main.async {
                    self.persistenceWorkspaceId = workspaceId
                    // This workspace may well have been restored before (cold
                    // launch, or an earlier visit in this session). The guard is
                    // only meant to collapse concurrent calls for ONE restore, so
                    // drop the stamp and let the switch restore again — otherwise
                    // hopping back to a workspace strands its conversation.
                    self.restoredWorkspaceIds.remove(workspaceId)
                    self.restoreActiveSession(storedId, for: workspaceId)
                }
            }
            .store(in: &cancellables)
    }

    /// Signing out ends every restore this process has done. Without clearing
    /// the stamps, signing back in as the same account lands on a workspace the
    /// Set still claims is restored, and the guard skips the restore — the same
    /// orphaned-thread failure as switching back.
    ///
    /// The stored session KEYS are left alone on purpose: they are per workspace
    /// and the threads still exist server-side, so signing back in should return
    /// you to the conversation you left.
    private func observeSignOut() {
        NotificationCenter.default.publisher(for: .userSignedOut)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self else { return }
                self.restoredWorkspaceIds.removeAll()
                self.persistenceWorkspaceId = nil
                self.general.resetForAccountChange()
                // Re-arm the deferred-restore one-shot: it was consumed by this
                // session's bootstrap, and signing back in resolves a workspace
                // through the same `$workspaceId` publisher rather than posting
                // `.workspaceDidChange`.
                self.observeWorkspaceReady()
                print("🚪 ChatSessionStore: cleared restore stamps on sign-out")
            }
            .store(in: &cancellables)
    }

    /// Called lazily on first access of `shared` (i.e. the first time anything
    /// touches the chat), so the restore is already in flight — or finished —
    /// by the time the sheet is presented. If the user opens the sheet during
    /// the fetch, `viewModel.isLoadingThread` drives a spinner.
    ///
    /// Also called on every workspace switch, which is why the once-only guard
    /// is per workspace rather than per process.
    private func restoreActiveSession(_ storedId: UUID?, for workspaceId: UUID) {
        guard !restoredWorkspaceIds.contains(workspaceId) else { return }
        restoredWorkspaceIds.insert(workspaceId)

        guard let sessionId = storedId else {
            print("📭 ChatSessionStore: no stored chat to restore for this workspace")
            return
        }

        // A conversation already underway in this process wins over the stored
        // id. (After a switch this is always clear — startNewConversation just
        // ran — so this only guards the launch path.)
        guard general.currentSessionId == nil, general.messages.isEmpty else {
            print("📭 ChatSessionStore: chat already in progress — skipping restore")
            return
        }

        print("📂 ChatSessionStore: restoring chat \(sessionId.uuidString.prefix(8))...")

        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.general.loadSession(sessionId)

            // loadSession leaves currentSessionId nil when the thread is gone
            // (deleted elsewhere, or a different account). Drop the dead key so
            // the next launch starts clean instead of retrying forever.
            if self.general.currentSessionId == nil {
                self.defaults.removeObject(forKey: Self.sessionKey(for: workspaceId))
                print("⚠️ ChatSessionStore: stored chat no longer exists — key removed")
            } else {
                print("✅ ChatSessionStore: restored chat with \(self.general.messages.count) messages")
            }
        }
    }

    // MARK: - Warm-up

    /// Touching `shared` is enough to construct the view model and kick off the
    /// restore. This exists so a caller can express that intent explicitly
    /// (e.g. from app launch) without a `_ = ChatSessionStore.shared` line.
    func prewarm() {
        // Intentionally empty — the work happens in `init`.
    }
}
