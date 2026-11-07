//
//  AppleSpeechSTTProvider.swift
//  dial8
//
//  STT provider entry for Apple's on-device speech stack (iOS 26
//  SpeechAnalyzer + SpeechTranscriber) — the ONLY transcription backend on iOS.
//
//  Unlike the cloud provider this replaces, `transcribe(audioURL:)` is real:
//  `AppleSpeechFileTranscriber` handles finished files (the watch-ingest path),
//  while the live recording path drives `AppleSpeechLiveTranscriber` directly.
//
//  Readiness mirrors `SpeechModelManager`: the model assets have to be on disk
//  before anything can be transcribed, and on a device where
//  `SpeechTranscriber.isAvailable` is false there is no fallback at all.
//

import Foundation
import Speech

final class AppleSpeechSTTProvider: STTProvider {
    let providerID: STTProviderID = .appleSpeech

    /// The silicon gate. False on iPhone 11 / SE 2nd gen and in the Simulator.
    var isAvailable: Bool {
        SpeechTranscriber.isAvailable
    }

    /// Ready once the model for the selected language is installed and the
    /// analyzer format is cached — see `SpeechModelManager.prewarm()`.
    /// Read through the manager's nonisolated mirror. `STTProvider.isReady` is a
    /// nonisolated requirement, so hopping onto the main actor with
    /// `assumeIsolated` here would trap the first time anything read it off-main.
    var isReady: Bool {
        SpeechModelManager.isReadyNonisolated
    }

    /// File transcription, on device. Language follows the same preference the
    /// live path uses; "auto" resolves to the device locale.
    func transcribe(audioURL: URL, language: String) async throws -> STTResult {
        guard let locale = await SpeechModelManager.resolveLocale(for: language) else {
            throw STTError.notAvailable("On-device transcription isn't available for \(language).")
        }

        do {
            let results = try await AppleSpeechFileTranscriber.transcribe(fileURL: audioURL, locale: locale)
            let segments = results.map { STTSegment(text: $0.text, start: $0.start, end: $0.end) }
            return STTResult(
                text: results.map(\.text).joined(separator: " "),
                language: locale.language.languageCode?.identifier,
                duration: results.last?.end,
                segments: segments
            )
        } catch {
            throw STTError.transcriptionFailed(error.localizedDescription)
        }
    }
}
