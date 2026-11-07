import SwiftUI
import Auth
import AuthenticationServices

struct iOSSignInView: View {
    @StateObject private var supabaseManager = SupabaseManager.shared
    @State private var email = ""
    @State private var password = ""
    @State private var isSignUp = false
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showingEnvironmentPicker = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 32) {
                Spacer()

                // Logo & title
                VStack(spacing: 12) {
                    Image(systemName: "waveform.circle.fill")
                        .font(.system(size: 64))
                        .foregroundStyle(.tint)

                    Text("Dial8")
                        .font(.largeTitle.bold())

                    Text("Sign in to access your data")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                // Email/password form
                VStack(spacing: 16) {
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .textFieldStyle(.roundedBorder)

                    SecureField("Password", text: $password)
                        .textContentType(isSignUp ? .newPassword : .password)
                        .textFieldStyle(.roundedBorder)

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }

                    Button {
                        Task { await handleEmailAuth() }
                    } label: {
                        if isLoading {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else {
                            Text(isSignUp ? "Create Account" : "Sign In")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(email.isEmpty || password.isEmpty || isLoading)

                    Button(isSignUp ? "Already have an account? Sign In" : "Don't have an account? Sign Up") {
                        isSignUp.toggle()
                        errorMessage = nil
                    }
                    .font(.footnote)
                }
                .padding(.horizontal, 24)

                // Divider
                HStack {
                    Rectangle().fill(.secondary.opacity(0.3)).frame(height: 1)
                    Text("or").font(.caption).foregroundStyle(.secondary)
                    Rectangle().fill(.secondary.opacity(0.3)).frame(height: 1)
                }
                .padding(.horizontal, 24)

                // OAuth buttons
                VStack(spacing: 12) {
                    Button {
                        Task {
                            try? await supabaseManager.signInWithProvider(.google)
                        }
                    } label: {
                        Label("Continue with Google", systemImage: "globe")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)

                    Button {
                        Task {
                            try? await supabaseManager.signInWithProvider(.apple)
                        }
                    } label: {
                        Label("Continue with Apple", systemImage: "apple.logo")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                }
                .padding(.horizontal, 24)

                Spacer()

                #if DEVELOPMENT
                // Environment switcher — tap to toggle
                Button {
                    showingEnvironmentPicker = true
                } label: {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(supabaseManager.activeEnvironment == .production ? .orange : .green)
                            .frame(width: 8, height: 8)
                        Text(supabaseManager.activeEnvironment.description)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.bottom, 8)
                }
                .confirmationDialog("Switch Environment", isPresented: $showingEnvironmentPicker) {
                    Button("Development") {
                        if supabaseManager.activeEnvironment != .development {
                            Task { await supabaseManager.switchEnvironment(.development) }
                        }
                    }
                    Button("Production") {
                        if supabaseManager.activeEnvironment != .production {
                            Task { await supabaseManager.switchEnvironment(.production) }
                        }
                    }
                } message: {
                    Text("Currently: \(supabaseManager.activeEnvironment.description)")
                }
                #endif
            }
        }
    }

    private func handleEmailAuth() async {
        isLoading = true
        errorMessage = nil
        do {
            if isSignUp {
                try await supabaseManager.signUpWithEmail(email: email, password: password)
            } else {
                try await supabaseManager.signInWithEmail(email: email, password: password)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
