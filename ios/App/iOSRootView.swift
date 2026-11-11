import SwiftUI

struct iOSRootView: View {
    @StateObject private var supabaseManager = SupabaseManager.shared
    @ObservedObject private var calls = TeamCallCenter.shared

    var body: some View {
        Group {
            if !supabaseManager.hasCheckedInitialSession {
                Color(.systemBackground)
            } else if supabaseManager.isAuthenticated {
                iOSMainTabView()
            } else {
                iOSSignInView()
            }
        }
        .teamCallChrome(calls)
    }
}

extension View {
    /// A team call over the app: the bar while it is minimised, the full screen (its own window, above
    /// any sheet) while it is open, a short line when one ended.
    func teamCallChrome(_ calls: TeamCallCenter) -> some View {
        modifier(TeamCallChrome(calls: calls))
    }
}

private struct TeamCallChrome: ViewModifier {
    @ObservedObject var calls: TeamCallCenter

    private var windowShowing: Bool { calls.inAppRing != nil || (calls.session != nil && calls.expanded) }

    func body(content: Content) -> some View {
        // Above the app, not over it: the app's own navigation bar sits under the call's.
        VStack(spacing: 0) {
            if let session = calls.session, !calls.expanded {
                iOSTeamCallBar(center: calls, session: session)
                    .padding(.bottom, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            content
        }
            .overlay(alignment: .top) {
                if let line = calls.endedLine {
                    Text(line)
                        .font(.system(size: 14, weight: .medium))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .glassEffect(.regular, in: .capsule)
                        .padding(.top, 8)
                        .transition(.opacity)
                        .task {
                            try? await Task.sleep(nanoseconds: 3_500_000_000)
                            calls.endedLine = nil
                        }
                }
            }
            .alert(calls.confirming?.line ?? "", isPresented: Binding(get: { calls.confirming != nil }, set: { if !$0 { calls.confirming = nil } })) {
                Button("Join") { Task { await calls.confirmJoin() } }
                Button("Cancel", role: .cancel) { calls.confirming = nil }
            } message: {
                Text("Everyone in the call is told before they talk.")
            }
            .animation(.easeOut(duration: 0.2), value: calls.expanded)
            .animation(.easeOut(duration: 0.2), value: calls.session?.uuid)
            .onChange(of: windowShowing, initial: true) { _, showing in
                TeamCallWindow.shared.update(showing: showing)
            }
    }
}
