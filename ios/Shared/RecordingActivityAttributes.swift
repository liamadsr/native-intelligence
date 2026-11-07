//
//  RecordingActivityAttributes.swift
//  dial8
//
//  ActivityKit attributes for the recording Live Activity / Dynamic Island.
//  Shared between the main app and the dial8Widgets extension.
//

import ActivityKit
import Foundation

struct RecordingActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var elapsedSeconds: Int
        var isRecording: Bool
        var isPaused: Bool
        var segmentCount: Int
    }
}
