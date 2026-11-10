//
//  STTProviderManager.swift
//  Native Intelligence
//
//  Singleton coordinator for STT providers. Manages provider registration
//  and the user's selected STT backend.
//

import Foundation
import Combine

class STTProviderManager: ObservableObject {
    static let shared = STTProviderManager()

    @Published var selectedProviderID: STTProviderID {
        didSet {
            UserDefaults.standard.set(selectedProviderID.rawValue, forKey: "stt_provider")
        }
    }

    @Published private(set) var providers: [STTProviderID: STTProvider] = [:]

    private init() {
        // Resolve the saved provider, but never honor a saved id that isn't valid
        // on this platform (e.g. a device that used to default to Groq, or to
        // Deepgram before iOS moved to Apple's on-device stack). Fall back to the
        // platform default instead.
        let platformDefault: STTProviderID = .appleSpeech

        let saved = UserDefaults.standard.string(forKey: "stt_provider")

        // Migration: iOS used to store "deepgram" here. Deepgram is gone — every
        // such install moves to the on-device provider (and the new value is
        // written back below, so this only ever runs once).
        if saved == "deepgram" {
            self.selectedProviderID = platformDefault
            UserDefaults.standard.set(platformDefault.rawValue, forKey: "stt_provider")
        } else if let saved,
                  let provider = STTProviderID(rawValue: saved),
                  provider.isAvailableOnCurrentPlatform {
            self.selectedProviderID = provider
        } else {
            self.selectedProviderID = platformDefault
        }

        registerBuiltInProviders()
    }

    // MARK: - Registration

    private func registerBuiltInProviders() {
        // iOS: Apple's on-device speech stack only. No cloud fallback.
        registerProvider(AppleSpeechSTTProvider())
    }

    func registerProvider(_ provider: STTProvider) {
        providers[provider.providerID] = provider
    }

    // MARK: - Access

    /// The currently selected and active provider
    var activeProvider: STTProvider? {
        providers[selectedProviderID]
    }

    /// Provider IDs available on the current platform
    var availableProviderIDs: [STTProviderID] {
        STTProviderID.allCases.filter { $0.isAvailableOnCurrentPlatform }
    }

    /// Whether the active provider is ready to transcribe
    var isReady: Bool {
        activeProvider?.isReady ?? false
    }
}
