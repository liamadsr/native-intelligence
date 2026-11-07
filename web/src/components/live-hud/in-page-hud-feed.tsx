'use client'

/**
 * The web HUD's feed (./web-hud.tsx): the in-page equivalent of what the
 * recording window sends the desktop's HUD window over Tauri
 * (components/capture/voice-id-hud-publisher.tsx). On web the HUD sits in the
 * same page as the recording, so it reads the recording context directly:
 *   - Voice ID's state, built exactly as the publisher builds it;
 *   - who spoke last (useLiveActiveSpeaker: renders only when that changes);
 *   - the call's conversation, as the recording context announced it
 *     (lib/live-agent/live-hud.ts);
 *   - the recording's state for the header's controls
 *     (lib/live-agent/hud-recording.ts): set when pause, finalizing or the
 *     transcription's health changes, with the elapsed reading then (never a
 *     tick: the HUD counts on from it);
 *   - the meeting's scheduled time, for the header's time fill
 *     (lib/live-agent/hud-schedule.ts): read once for the capture
 *     (useCaptureSchedule), again if its event is re-linked;
 *   - the person's pre-call brief, for the Briefing line
 *     (lib/live-agent/hud-brief.ts): read once for the capture
 *     (useCaptureBrief), again when the capture is edited;
 *   - the agent's broadcast nudges: none of its own yet. say_to_user lands in
 *     the conversation, which the chat shows; a host that also hears the
 *     broadcast can push them (inPageHudFeed.pushNudge).
 *
 * A leaf that renders nothing: it takes the full (volatile) recording context
 * so the HUD itself doesn't, and writes to the feed store only when a value
 * changes.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useDetectedSpeakers, useLiveActiveSpeaker, useRecordingContext } from '@/hooks/recording-context'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { voiceIdHudState, type VoiceIdHudHandlers } from '@/lib/live-agent/voice-id-hud'
import { announcedLiveConversation, subscribeLiveCaptureConversations } from '@/lib/live-agent/live-hud'
import { hudRecordingState } from '@/lib/live-agent/hud-recording'
import { createHudFeedStore, EMPTY_HUD_FEED, type HudFeedStore } from './hud-feed'
import { useCaptureSchedule } from './use-capture-schedule'
import { useCaptureBrief } from './use-capture-brief'

/** The web HUD's feed: one per page (one call records at a time). 3b's wiring may push to it. */
export const inPageHudFeed: HudFeedStore = createHudFeedStore()

/** The recording's Voice ID handlers, as the bridge last saw them (the HUD's clicks run through them). */
export const inPageHudHandlers: { current: VoiceIdHudHandlers | null } = { current: null }

export function InPageHudFeed({
  captureId,
  store = inPageHudFeed,
  onLiveChange,
}: {
  captureId: string
  store?: HudFeedStore
  /** Whether the recording is a live capture (the HUD shows only for one). */
  onLiveChange?: (live: boolean) => void
}) {
  const recording = useRecordingContext()
  const detectedSpeakers = useDetectedSpeakers()
  const activeSpeaker = useLiveActiveSpeaker()
  useEffect(() => {
    inPageHudHandlers.current = recording
  }, [recording])

  const live = recording.liveModeEnabled
  useEffect(() => onLiveChange?.(live), [live, onLiveChange])

  // A new call starts from nothing, and an ended one leaves nothing behind
  // (the store outlives the HUD: the next call's first render must never find
  // this call's conversation in it).
  useEffect(() => {
    store.set({ ...EMPTY_HUD_FEED })
    return () => store.set({ ...EMPTY_HUD_FEED })
  }, [store, captureId])

  const voiceId = useMemo(
    () =>
      voiceIdHudState({
        captureId,
        workspaceId: getClientWorkspaceId(),
        detectedSpeakers,
        // Who's talking rides `lastSpeaker` alone, so a change of speaker
        // never replaces Voice ID's state (and every chip with it).
        activeSpeaker: null,
        speakerNames: recording.speakerNames,
        demotedSelfLabels: recording.selfDemotedLabels,
        speakerContacts: recording.speakerContacts,
        postSessionReview: recording.postSessionReview ?? null,
        selfSuggestion: recording.selfSuggestion ?? null,
      }),
    [
      captureId,
      detectedSpeakers,
      recording.speakerNames,
      recording.selfDemotedLabels,
      recording.speakerContacts,
      recording.postSessionReview,
      recording.selfSuggestion,
    ],
  )
  useEffect(() => store.set({ voiceId }), [store, voiceId])
  useEffect(() => store.set({ lastSpeaker: activeSpeaker }), [store, activeSpeaker])

  const announced = useSyncExternalStore(
    subscribeLiveCaptureConversations,
    () => announcedLiveConversation(captureId),
    () => null,
  )
  useEffect(() => {
    store.set({ conversation: announced ? { ...announced, workspaceId: getClientWorkspaceId() } : null })
  }, [store, announced])

  // The recording's controls: on a change of state only, with the elapsed
  // reading at that moment (getElapsed is the recording's own count).
  const { isRecording, isPaused, isAgentFinalizing, transcriptionStatus, getElapsed } = recording
  useEffect(() => {
    store.set({
      recording: isRecording
        ? hudRecordingState({ captureId, isPaused, isAgentFinalizing, transcriptionStatus, elapsedSec: getElapsed(), at: Date.now() })
        : null,
    })
  }, [store, captureId, isRecording, isPaused, isAgentFinalizing, transcriptionStatus, getElapsed])

  const schedule = useCaptureSchedule(captureId)
  useEffect(() => store.set({ schedule }), [store, schedule])

  const brief = useCaptureBrief(captureId)
  useEffect(() => store.set({ brief }), [store, brief])

  return null
}
