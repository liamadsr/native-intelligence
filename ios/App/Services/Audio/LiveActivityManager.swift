//
//  LiveActivityManager.swift
//  dial8
//
//  Manages the recording Live Activity lifecycle.
//  Starts the activity when recording begins, updates it every second,
//  and ends it when recording stops or is cancelled.
//

import ActivityKit
import Foundation

class LiveActivityManager {
    static let shared = LiveActivityManager()

    private var currentActivity: Activity<RecordingActivityAttributes>?

    private init() {}

    // MARK: - Lifecycle

    func startActivity() {
        let authInfo = ActivityAuthorizationInfo()
        print("[LiveActivityManager] areActivitiesEnabled: \(authInfo.areActivitiesEnabled)")
        guard authInfo.areActivitiesEnabled else {
            print("[LiveActivityManager] Live Activities not enabled — check Settings → NI → Live Activities")
            return
        }

        // End any stale activity first
        endActivity()

        let attributes = RecordingActivityAttributes()
        let state = RecordingActivityAttributes.ContentState(
            elapsedSeconds: 0,
            isRecording: true,
            isPaused: false,
            segmentCount: 0
        )

        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: .init(state: state, staleDate: nil),
                pushType: nil
            )
            currentActivity = activity
            print("[LiveActivityManager] Started activity: \(activity.id)")
        } catch {
            print("[LiveActivityManager] Failed to start activity: \(error)")
        }
    }

    func updateActivity(elapsedSeconds: Int, isRecording: Bool, isPaused: Bool, segmentCount: Int) {
        guard let activity = currentActivity else { return }

        let state = RecordingActivityAttributes.ContentState(
            elapsedSeconds: elapsedSeconds,
            isRecording: isRecording,
            isPaused: isPaused,
            segmentCount: segmentCount
        )

        Task {
            await activity.update(.init(state: state, staleDate: nil))
        }
    }

    func endActivity() {
        guard let activity = currentActivity else { return }

        let finalState = RecordingActivityAttributes.ContentState(
            elapsedSeconds: 0,
            isRecording: false,
            isPaused: false,
            segmentCount: 0
        )

        Task {
            await activity.end(.init(state: finalState, staleDate: nil), dismissalPolicy: .immediate)
        }
        currentActivity = nil
    }
}
