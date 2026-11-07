//
//  RecordingModels.swift
//  dial8
//
//  Models for recording and transcription.
//

import Foundation

// MARK: - Recording State

enum RecordingState: Equatable {
    case idle
    case recording
    case paused
    case stopping
}

// MARK: - Audio Source (Speaker Identification)

/// Identifies the source of audio for speaker-separated transcripts
enum AudioSource: String, Codable, Equatable {
    case microphone = "me"      // User's microphone input
    case systemAudio = "them"   // System audio (other meeting participants)

    /// Display label for the speaker
    var displayLabel: String {
        switch self {
        case .microphone: return "Me"
        case .systemAudio: return "Them"
        }
    }

    /// SF Symbol icon for the speaker
    var iconName: String {
        switch self {
        case .microphone: return "mic.fill"
        case .systemAudio: return "speaker.wave.2.fill"
        }
    }
}

// MARK: - Transcript Segment Model

struct TranscriptSegment: Identifiable, Equatable {
    let id: UUID
    let text: String
    let timestamp: Date
    let segmentIndex: Int
    let source: AudioSource
    let recordingOffsetSeconds: TimeInterval

    init(id: UUID = UUID(), text: String, timestamp: Date = Date(), segmentIndex: Int, source: AudioSource = .microphone, recordingOffsetSeconds: TimeInterval = 0) {
        self.id = id
        self.text = text
        self.timestamp = timestamp
        self.segmentIndex = segmentIndex
        self.source = source
        self.recordingOffsetSeconds = recordingOffsetSeconds
    }

    var formattedTime: String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: timestamp)
    }

    /// Formatted offset from recording start (e.g., "1:23")
    var formattedOffset: String {
        let totalSeconds = Int(recordingOffsetSeconds)
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}
