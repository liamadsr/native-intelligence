import SwiftUI
import Auth

struct iOSSettingsTab: View {
    @StateObject private var supabaseManager = SupabaseManager.shared
    @StateObject private var workspaceService = WorkspaceService.shared
    @StateObject private var recordingService = iOSRecordingService.shared
    @State private var showingSignOutConfirmation = false
    @State private var showingEnvironmentConfirmation = false
    @State private var pendingEnvironment: SupabaseConfig.Environment?

    /// The workspace a tap is currently switching to — drives the row spinner.
    @State private var switchingTo: UUID?
    /// A failed switch, surfaced as the section footer.
    @State private var switchError: String?

    var body: some View {
        List {
                // Workspace switcher. Hidden for the single-workspace case: a
                // list of one with a permanent checkmark is noise.
                if workspaceService.workspaces.count > 1 {
                    workspaceSection
                }

                // Profile section
                Section {
                    if let user = supabaseManager.currentUser {
                        HStack(spacing: 12) {
                            ZStack {
                                Circle()
                                    .fill(.blue.opacity(0.15))
                                Image(systemName: "person.fill")
                                    .foregroundStyle(.blue)
                            }
                            .frame(width: 50, height: 50)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.email ?? "User")
                                    .font(.body.weight(.medium))

                                Text(workspaceService.activeWorkspace?.name ?? "Signed in")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                // Speech-to-Text
                Section("Speech-to-Text") {
                    NavigationLink {
                        iOSSTTSettingsView()
                    } label: {
                        Label("STT Settings", systemImage: "waveform")
                    }
                }

                #if DEVELOPMENT
                // Environment switcher
                Section("Environment") {
                    ForEach([SupabaseConfig.Environment.development, .production], id: \.rawValue) { env in
                        Button {
                            if env != supabaseManager.activeEnvironment {
                                pendingEnvironment = env
                                showingEnvironmentConfirmation = true
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(env.description)
                                        .foregroundStyle(.primary)
                                    Text(env.projectURL)
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                if env == supabaseManager.activeEnvironment {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(env == .production ? .orange : .green)
                                }
                            }
                        }
                    }
                }
                #endif

                // App info
                Section("About") {
                    LabeledContent("Version", value: appVersion)
                    LabeledContent("Build", value: buildNumber)
                    LabeledContent("Platform", value: "iOS")
                    #if DEVELOPMENT
                    LabeledContent("Environment") {
                        Text(supabaseManager.activeEnvironment.description)
                            .foregroundStyle(supabaseManager.activeEnvironment == .production ? .orange : .green)
                    }
                    #endif
                }

                // Sign out
                Section {
                    Button(role: .destructive) {
                        showingSignOutConfirmation = true
                    } label: {
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .confirmationDialog("Sign Out", isPresented: $showingSignOutConfirmation) {
                Button("Sign Out", role: .destructive) {
                    Task {
                        try? await supabaseManager.signOut()
                    }
                }
            } message: {
                Text("Are you sure you want to sign out?")
            }
            .confirmationDialog(
                "Switch Environment",
                isPresented: $showingEnvironmentConfirmation
            ) {
                Button("Switch & Sign Out", role: .destructive) {
                    if let env = pendingEnvironment {
                        Task {
                            await supabaseManager.switchEnvironment(env)
                        }
                    }
                }
            } message: {
                if let env = pendingEnvironment {
                    Text("Switch to \(env.description)? This will sign you out.")
                }
            }
    }

    // MARK: - Workspace

    /// A capture writes into the ACTIVE workspace, so switching mid-recording
    /// would split one meeting across two workspaces. Rows are disabled rather
    /// than failing on tap, with the reason shown in the footer.
    private var isCaptureBlocking: Bool {
        recordingService.hasActiveSession
    }

    private var workspaceSection: some View {
        Section {
            ForEach(workspaceService.workspaces) { workspace in
                let isActive = workspace.id == workspaceService.workspaceId

                Button {
                    switchTo(workspace)
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(workspace.name)
                                .foregroundStyle(.primary)

                            // Two workspaces can legitimately share a name (the
                            // signup trigger names them after the owner), and a
                            // list of identical rows is unusable. The slug is
                            // unique, so show it whenever it disambiguates.
                            if needsSlugToDisambiguate(workspace) {
                                Text(workspace.slug)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        Spacer()

                        if switchingTo == workspace.id {
                            ProgressView()
                                .controlSize(.small)
                        } else if isActive {
                            Image(systemName: "checkmark")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .contentShape(.rect)
                }
                // `.plain` keeps the row's text at its own foreground style —
                // the default button tint would paint every name accent-blue.
                .buttonStyle(.plain)
                .disabled(isActive || workspaceService.isSwitching || isCaptureBlocking)
            }
        } header: {
            Text("Workspace")
        } footer: {
            if let switchError {
                Text(switchError)
                    .foregroundStyle(.red)
            } else if isCaptureBlocking {
                Text("Finish the current capture before switching workspaces.")
            }
        }
    }

    /// True when another workspace shares this one's name.
    private func needsSlugToDisambiguate(_ workspace: Workspace) -> Bool {
        workspaceService.workspaces.contains {
            $0.id != workspace.id && $0.name == workspace.name
        }
    }

    private func switchTo(_ workspace: Workspace) {
        guard workspace.id != workspaceService.workspaceId else { return }

        switchError = nil
        switchingTo = workspace.id

        Task {
            defer { switchingTo = nil }
            do {
                try await workspaceService.switchWorkspace(to: workspace.id)
            } catch {
                switchError = error.localizedDescription
            }
        }
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "Unknown"
    }

    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "Unknown"
    }
}
