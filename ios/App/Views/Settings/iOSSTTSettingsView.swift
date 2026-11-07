//
//  iOSSTTSettingsView.swift
//  dial8
//
//  Speech-to-Text settings for iOS. Transcription runs ENTIRELY on the device
//  with Apple's iOS 26 speech models (SpeechAnalyzer + SpeechTranscriber): no
//  streaming socket, no cloud fallback, no per-minute cost. So this screen has
//  no provider picker — it reports the on-device model's state (ready /
//  downloading / unsupported) and lets the user pick the language whose model
//  gets installed.
//

import SwiftUI
import Speech

struct iOSSTTSettingsView: View {
    @StateObject private var speechModel = SpeechModelManager.shared
    @AppStorage("selectedLanguage") private var selectedLanguage: String = "en"

    /// Languages Apple actually ships a model for, derived from
    /// `SpeechTranscriber.supportedLocales` and collapsed to one entry per
    /// language code (the region is resolved for the user in
    /// `SpeechModelManager.resolveLocale`). Empty until the async load lands —
    /// and on a device with no on-device speech at all it stays empty, which is
    /// exactly what the status section is there to explain.
    @State private var supportedLanguages: [(name: String, code: String)] = []

    var body: some View {
        List {
            statusSection
            languageSection
        }
        .navigationTitle("Speech-to-Text")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await loadSupportedLanguages()
            await speechModel.prewarm()
        }
        .onChange(of: selectedLanguage) { _, newValue in
            UserDefaults.standard.set(newValue, forKey: "selectedLanguage")
            // SpeechModelManager listens for this and re-resolves + re-downloads.
            NotificationCenter.default.post(
                name: NSNotification.Name("SelectedLanguageChanged"),
                object: nil,
                userInfo: ["language": newValue]
            )
        }
    }

    // MARK: - Status

    @ViewBuilder
    private var statusSection: some View {
        Section {
            HStack(spacing: 10) {
                Image(systemName: statusIcon)
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(statusTitle)
                        .font(.body.weight(.medium))
                    if let detail = statusDetail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                if case .downloading(let progress) = speechModel.state {
                    ProgressView(value: progress.fractionCompleted)
                        .progressViewStyle(.circular)
                }
            }
        } header: {
            Text("Status")
        } footer: {
            Text("Transcription runs on your iPhone. Audio never leaves the device.")
        }
    }

    private var statusIcon: String {
        switch speechModel.state {
        case .ready: return "checkmark.circle"
        case .downloading: return "arrow.down.circle"
        case .checking: return "clock"
        case .unsupportedDevice, .unsupportedLanguage: return "exclamationmark.triangle"
        case .failed: return "exclamationmark.triangle"
        }
    }

    private var statusTitle: String {
        switch speechModel.state {
        case .ready: return "On-Device Transcription Ready"
        case .downloading: return "Downloading Speech Model"
        case .checking: return "Checking…"
        case .unsupportedDevice: return "Not Supported on This iPhone"
        case .unsupportedLanguage: return "Language Not Supported"
        case .failed: return "Model Unavailable"
        }
    }

    /// For `.ready` the message is nil by design, so name the active locale
    /// instead — that is the one thing a ready state still has to tell the user.
    private var statusDetail: String? {
        if case .ready = speechModel.state {
            guard let locale = speechModel.locale else { return "Apple on-device speech" }
            let name = Locale.current.localizedString(forIdentifier: locale.identifier) ?? locale.identifier(.bcp47)
            return "Apple on-device speech · \(name)"
        }
        return speechModel.userFacingMessage
    }

    // MARK: - Language

    @ViewBuilder
    private var languageSection: some View {
        Section {
            if supportedLanguages.isEmpty {
                Text("No on-device languages available.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Picker("Language", selection: $selectedLanguage) {
                    Text("Auto Detect").tag("auto")
                    ForEach(supportedLanguages, id: \.code) { language in
                        Text(language.name).tag(language.code)
                    }
                }
            }
        } header: {
            Text("Language")
        } footer: {
            Text("The primary language you'll be speaking during recordings. Changing it downloads that language's on-device model.")
        }
    }

    /// One entry per language code that `SpeechTranscriber` supports, sorted by
    /// localized name.
    private func loadSupportedLanguages() async {
        let locales = await SpeechTranscriber.supportedLocales
        var seen = Set<String>()
        var entries: [(name: String, code: String)] = []

        for locale in locales {
            guard let code = locale.language.languageCode?.identifier, !seen.contains(code) else { continue }
            seen.insert(code)
            let name = Locale.current.localizedString(forLanguageCode: code) ?? code
            entries.append((name: name.capitalized, code: code))
        }

        entries.sort { $0.name < $1.name }
        supportedLanguages = entries

        // A stored language the device no longer supports would silently block
        // recording. Fall back to Auto Detect, which always resolves to
        // something installable.
        if selectedLanguage != "auto", !seen.contains(selectedLanguage), !entries.isEmpty {
            selectedLanguage = "auto"
        }
    }
}
