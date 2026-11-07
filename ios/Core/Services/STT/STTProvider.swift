//
//  STTProvider.swift
//  dial8
//
//  Protocol and supporting types for Speech-to-Text providers.
//  Separate from AIProvider (which handles text-in/text-out LLMs).
//

import Foundation

// MARK: - Provider Identification

/// Identifies an STT processing backend
enum STTProviderID: String, CaseIterable, Codable, Identifiable {
    /// Apple's on-device speech stack (iOS 26 SpeechAnalyzer + SpeechTranscriber).
    /// The ONLY iOS backend: audio never leaves the device, live and file paths
    /// alike.
    case appleSpeech = "apple_speech"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .appleSpeech: return "On-device (Apple)"
        }
    }

    var description: String {
        switch self {
        case .appleSpeech: return "On-device transcription using Apple's speech models. Audio never leaves your iPhone."
        }
    }

    var icon: String {
        switch self {
        case .appleSpeech: return "waveform"
        }
    }

    /// Whether this provider is available on the current platform
    var isAvailableOnCurrentPlatform: Bool {
        switch self {
        case .appleSpeech:
            // iOS-only on-device path.
            return true
        }
    }
}

// MARK: - Transcription Results

/// Result of a transcription request
struct STTResult {
    let text: String
    let language: String?
    let duration: TimeInterval?
    let segments: [STTSegment]?
}

struct STTSegment {
    let text: String
    let start: TimeInterval
    let end: TimeInterval
}

// MARK: - Errors

enum STTError: LocalizedError {
    case notConfigured(String)
    case notAvailable(String)
    case transcriptionFailed(String)
    case audioTooLarge(actual: Int, maxBytes: Int)
    case networkError(Error)
    case rateLimited(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured(let info):
            return "STT not configured: \(info)"
        case .notAvailable(let reason):
            return "STT not available: \(reason)"
        case .transcriptionFailed(let detail):
            return "Transcription failed: \(detail)"
        case .audioTooLarge(let actual, let max):
            return "Audio file too large (\(actual / 1_000_000)MB). Maximum is \(max / 1_000_000)MB."
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .rateLimited(let info):
            return "Rate limited: \(info)"
        }
    }
}

// MARK: - Protocol

/// Protocol for speech-to-text providers
protocol STTProvider {
    var providerID: STTProviderID { get }

    /// Whether this provider can potentially be used (e.g. API key configured or platform supported)
    var isAvailable: Bool { get }

    /// Whether the provider is ready to transcribe right now (e.g. model downloaded, authenticated)
    var isReady: Bool { get }

    /// Transcribe an audio file to text
    /// - Parameters:
    ///   - audioURL: URL to the audio file (WAV 16kHz mono expected)
    ///   - language: Language code (e.g. "en", "auto")
    /// - Returns: Transcription result
    func transcribe(audioURL: URL, language: String) async throws -> STTResult
}
