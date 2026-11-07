import SwiftUI

struct iOSRootView: View {
    @StateObject private var supabaseManager = SupabaseManager.shared

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
    }
}
