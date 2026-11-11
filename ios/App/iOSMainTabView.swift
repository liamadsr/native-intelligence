import Combine
import SwiftUI

// `.openRecordingSheet` is declared in Shared/StartCaptureIntent.swift.
// It moved there when StartCaptureIntent started posting it: that file compiles
// into the widget extension as well as the app, so the name has to live
// somewhere both targets can see, and two declarations of it would collide.

struct iOSMainTabView: View {
    /// The one modal this screen can have up at a time.
    ///
    /// These were two independent `@State` Bools driving two `.sheet` modifiers
    /// on the same view. SwiftUI presents only one sheet per view, so asking for
    /// the recorder while the chat was already up presented nothing — and worse,
    /// the Bool stayed `true`, so every later request (Action Button, control,
    /// widget deep link, the Home record button, all of which set the same flag)
    /// was a silent no-op for the rest of the process. The Action Button fires
    /// from anywhere, which turned a rare collision into a routine one. One
    /// piece of state behind one `.sheet(item:)` means a new request REPLACES
    /// whatever is up instead of being dropped on the floor.
    private enum Presentation: String, Identifiable {
        case recording
        case chat

        var id: String { rawValue }
    }

    @State private var presented: Presentation?

    var body: some View {
        iOSNotesHomeView(
            showingRecordingSheet: binding(for: .recording),
            showingChat: binding(for: .chat)
        )
        .sheet(item: $presented) { which in
            switch which {
            case .recording: recordingSheet
            case .chat: chatSheet
            }
        }
        .onChange(of: presented) { previous, _ in
            // A capture saved through the API pipeline is inserted into
            // NotesService's cache by finalizeCaptureOnServer, but the recorder can
            // also be closed by the offline fallback path or a swipe-down mid-save.
            // One lightweight refresh when it closes makes Home correct either way.
            //
            // Except when the recording is still running: the chevron (and a
            // swipe-down) deliberately only COLLAPSE the sheet, and refreshing
            // there pulled the half-written capture row onto Home as a real note,
            // stuck on "Processing…" while the user was still recording it.
            // Discard is handled inside the sheet, which awaits its DELETE before
            // dismissing — so by the time we get here the row is already gone.
            guard previous == .recording else { return }
            guard !iOSRecordingService.shared.hasActiveSession else { return }
            Task { await NotesService.shared.refreshNotesLightweight() }
        }
        // A tapped push from the agent opens the chat; a team chat one has already set Home's path,
        // and anything up over Home goes so it shows.
        .onReceive(TeamChatRouter.shared.$chatRequest.dropFirst()) { _ in
            presented = .chat
        }
        .onReceive(TeamChatRouter.shared.$path.dropFirst()) { path in
            if !path.isEmpty, presented == .chat { presented = nil }
        }
        .onChange(of: presented) { _, now in
            TeamChatRouter.shared.chatOpen = now == .chat
        }
        .onReceive(NotificationCenter.default.publisher(for: .openRecordingSheet)) { _ in
            // Whichever of this and the `.task` handoff below runs first wins;
            // clearing the parked request makes the other a no-op instead of a
            // second presentation. Safe to clear unconditionally now that the
            // request always presents: with one `.sheet(item:)` there is no
            // "another sheet is up" case that silently swallows it.
            PendingCaptureStart.clear()
            presented = .recording
        }
        .task {
            // Build the shared chat view model and kick off the restore of the
            // last active conversation now, so the transcript is already there
            // the first time the sheet opens (and `isLoadingThread` covers the
            // case where the user is faster than the fetch).
            ChatSessionStore.shared.prewarm()

            // Action Button / control on a COLD launch: StartCaptureIntent
            // posted `.openRecordingSheet` while this view did not exist yet
            // (the app was still booting, and on a fresh process the auth
            // bootstrap runs before Home is ever built), so the notification
            // landed in an empty room. The request is parked instead, and this
            // is where it gets picked up. `consume()` returns true at most once
            // and refuses a request older than its staleness window, so an old
            // press can never open the recorder on some unrelated later launch.
            if PendingCaptureStart.consume() {
                presented = .recording
            }
        }
    }

    // MARK: - Sheets

    @ViewBuilder
    private var recordingSheet: some View {
        iOSActiveRecordingView()
            // Full height only: the sheet is a page, and the half-height
            // detent left the floating control bar sitting mid-screen.
            .presentationDetents([.large])
            // The chevron in the top-left is the collapse affordance; a grabber
            // above the serif title read as a second, competing one. Swipe-down
            // still works.
            .presentationDragIndicator(.hidden)
            .presentationBackground(iOSActiveRecordingView.sheetBackground)
    }

    // A sheet, not a fullScreenCover: the translucent background lets Home
    // blur through behind the chat, which is the whole look. Keyboard
    // avoidance still works — a .large-detent sheet resizes for the keyboard
    // exactly like a full-screen presentation does.
    // The view model comes from ChatSessionStore, NOT from a @StateObject
    // inside the presented view: SwiftUI rebuilds the sheet's content on
    // every presentation, so an owned view model meant a brand-new
    // conversation each time the chat was opened.
    @ViewBuilder
    private var chatSheet: some View {
        iOSAIChatView(viewModel: ChatSessionStore.shared.general)
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            // Liquid Glass rather than a flat material, and with the sheet's
            // dimming layer switched off — a full-height sheet over a dimmed,
            // near-black Home read as an opaque charcoal panel; with the
            // dimming gone, Home actually refracts through the glass.
            .presentationBackground {
                // `.clear` glass, not `.regular`: regular glass in dark mode
                // adds a heavy blur plus a dark tint that flattened the sheet
                // into a near-black panel with nothing of Home visible
                // through it. Clear glass keeps the lensing and lets Home's
                // shapes read through, which is the whole point.
                Rectangle()
                    .fill(.clear)
                    .glassEffect(.clear, in: .rect)
            }
            .presentationBackgroundInteraction(.enabled(upThrough: .large))
    }

    // MARK: - Bool projections

    /// iOSNotesHomeView still takes two `Binding<Bool>`s; these project the
    /// single source of truth into that shape. Setting one `true` takes over the
    /// slot; setting it `false` closes it only if it is the thing currently up.
    private func binding(for target: Presentation) -> Binding<Bool> {
        Binding(
            get: { presented == target },
            set: { isPresented in
                if isPresented {
                    presented = target
                } else if presented == target {
                    presented = nil
                }
            }
        )
    }
}
