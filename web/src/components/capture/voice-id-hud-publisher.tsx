'use client'

/**
 * The recording window's half of the live agent's HUD: Voice ID and the live
 * transcript (protocols: lib/live-agent/voice-id-hud.ts and transcript-hud.ts;
 * the HUD's half: app/hud/agent).
 *
 * While a live capture records on desktop the HUD is up for the whole call
 * (use-agent-nudge-relay), and Voice ID shows there instead of on the
 * capture card. This leaf sends the HUD what Voice ID draws
 * whenever any of it changes (and on every auto-accept tick), the transcript's
 * tail as it streams (straight from the transcript store — no render here per
 * flush — at most every TRANSCRIPT_HUD_EMIT_MS), both again when the HUD says
 * it is listening, and runs the HUD's clicks through the recording's own Voice
 * ID handlers — the same ones the capture card's row calls. It tells the HUD
 * the call's conversation and live agent, which the HUD's own chat talks in
 * (components/live-chat: its own eve session, from that window), and pushes
 * the transcript to the server when that chat is about to send
 * (lib/live-agent/live-hud.ts). It sends the recording's state for the HUD
 * header's controls on each change (never a tick) and runs their clicks —
 * pause / resume, stop, back to the capture — through the recording's own
 * handlers (lib/live-agent/hud-recording.ts). Once the HUD has said it's
 * listening, it claims the controls, so the top bar's pill steps aside. It
 * reads the meeting's scheduled time once for the capture (again if its event
 * is re-linked) and sends it for the HUD header's time fill
 * (lib/live-agent/hud-schedule.ts), and the person's pre-call brief the same
 * way for its Briefing line (lib/live-agent/hud-brief.ts). A goal set or
 * edited on the HUD's goal line is written here (save-hud-goal.ts: source
 * 'hud', linked to the capture) and answered (lib/live-agent/hud-goal.ts);
 * the write says so on this window, so the brief is read again and re-sent.
 *
 * Mounted once in the dashboard shell. A window that isn't recording a live
 * capture renders nothing, so with several windows open only the recording one
 * talks to the HUD.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { isDesktopApp } from '@/lib/platform'
import { listenScoped, unlistenEach } from '@/lib/tauri-unlisten'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import {
  useDetectedSpeakers,
  useOptionalRecordingContext,
  useRecordingContext,
  useRecordingStable,
} from '@/hooks/recording-context'
import {
  AGENT_HUD_WINDOW,
  VOICE_ID_HUD_ACTION_EVENT,
  VOICE_ID_HUD_READY_EVENT,
  VOICE_ID_HUD_STATE_EVENT,
  runVoiceIdHudAction,
  voiceIdHudState,
  type VoiceIdHudHandlers,
} from '@/lib/live-agent/voice-id-hud'
import { TRANSCRIPT_HUD_EMIT_MS, TRANSCRIPT_HUD_EVENT, transcriptHudTail } from '@/lib/live-agent/transcript-hud'
import {
  LIVE_HUD_CONVERSATION_EVENT,
  LIVE_HUD_FLUSHED_EVENT,
  LIVE_HUD_FLUSH_EVENT,
  announcedLiveConversation,
  readLiveHudFlush,
  subscribeLiveCaptureConversations,
  type LiveHudConversation,
} from '@/lib/live-agent/live-hud'
import {
  HUD_RECORDING_ACTION_EVENT,
  HUD_RECORDING_STATE_EVENT,
  claimHudRecordingControls,
  hudRecordingState,
  runHudRecordingAction,
  type HudRecordingHandlers,
} from '@/lib/live-agent/hud-recording'
import { HUD_SCHEDULE_EVENT } from '@/lib/live-agent/hud-schedule'
import { HUD_BRIEF_EVENT } from '@/lib/live-agent/hud-brief'
import { HUD_GOAL_ACTION_EVENT, HUD_GOAL_RESULT_EVENT, runHudGoalAction } from '@/lib/live-agent/hud-goal'
import { openActiveCapture } from '@/components/capture/recording-status'
import { useCaptureSchedule } from '@/components/live-hud/use-capture-schedule'
import { useCaptureBrief } from '@/components/live-hud/use-capture-brief'
import { saveHudGoal } from '@/components/live-hud/save-hud-goal'

// The Tauri event API, loaded once (lazily: desktop only, never on the server).
let eventApi: Promise<typeof import('@tauri-apps/api/event')> | null = null
const tauriEvent = () => (eventApi ??= import('@tauri-apps/api/event'))

/** Is the desktop's HUD window up right now? Desktop, with a live capture
 *  recording — the same condition the HUD is up for (use-agent-nudge-relay):
 *  this window then publishes to it. */
export function useVoiceIdInHud(): boolean {
  const recording = useOptionalRecordingContext()
  return !!recording && isDesktopApp() && recording.isRecording && recording.liveModeEnabled && !!recording.captureId
}

/** Is a live agent's HUD up right now, on either platform? A live capture
 *  recording: the desktop's HUD window, or the web's floating HUD
 *  (components/live-hud/web-hud.tsx LiveHudMount). Voice ID shows there, so
 *  the capture card leaves its own row out meanwhile. */
export function useLiveHudUp(): boolean {
  const recording = useOptionalRecordingContext()
  return !!recording && recording.isRecording && recording.liveModeEnabled && !!recording.captureId
}

export function VoiceIdHudPublisher() {
  const recording = useOptionalRecordingContext()
  const inHud = useVoiceIdInHud()
  if (!inHud || !recording?.captureId) return null
  return <Publisher captureId={recording.captureId} />
}

function Publisher({ captureId }: { captureId: string }) {
  const recording = useRecordingContext()
  const { getAutoAcceptTick, getTranscriptSegmentsSnapshot, subscribeTranscriptSegments } = useRecordingStable()
  const detectedSpeakers = useDetectedSpeakers()

  // What publish() sends, read when it runs (the HUD's ready fires between
  // renders). Who's talking isn't in it: the HUD reads who spoke last off the
  // transcript's tail, so a change of speaker sends nothing here.
  const state = {
    captureId,
    detectedSpeakers,
    activeSpeaker: null,
    speakerNames: recording.speakerNames,
    demotedSelfLabels: recording.selfDemotedLabels,
    speakerContacts: recording.speakerContacts,
    postSessionReview: recording.postSessionReview ?? null,
    selfSuggestion: recording.selfSuggestion ?? null,
  }
  const latest = useRef({ state, getTick: getAutoAcceptTick })
  latest.current = { state, getTick: getAutoAcceptTick }
  const handlers = useRef<VoiceIdHudHandlers>(recording)
  handlers.current = recording

  const publish = useCallback(() => {
    const { state, getTick } = latest.current
    const payload = voiceIdHudState({ ...state, workspaceId: getClientWorkspaceId() }, getTick)
    void tauriEvent()
      .then(({ emitTo }) => emitTo(AGENT_HUD_WINDOW, VOICE_ID_HUD_STATE_EVENT, payload))
      .catch(() => {})
  }, [])

  // Whenever anything the row draws changes…
  useEffect(publish, [
    publish,
    captureId,
    detectedSpeakers,
    recording.speakerNames,
    recording.selfDemotedLabels,
    recording.speakerContacts,
    recording.postSessionReview,
    recording.selfSuggestion,
  ])
  // Not on the auto-accept ticks: a suggestion carries when its countdown
  // runs out (autoAcceptAt), and the HUD's chip counts down to it itself.

  // The transcript's tail, as it streams: read from the store when sent, so a
  // flush never renders anything here; at most one message per
  // TRANSCRIPT_HUD_EMIT_MS, the latest flush always sent.
  const publishTranscript = useCallback(() => {
    const payload = transcriptHudTail(captureId, getTranscriptSegmentsSnapshot())
    void tauriEvent()
      .then(({ emitTo }) => emitTo(AGENT_HUD_WINDOW, TRANSCRIPT_HUD_EVENT, payload))
      .catch(() => {})
  }, [captureId, getTranscriptSegmentsSnapshot])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let sentAt = 0
    const send = () => {
      timer = null
      sentAt = Date.now()
      publishTranscript()
    }
    const off = subscribeTranscriptSegments(() => {
      if (timer) return
      timer = setTimeout(send, Math.max(0, TRANSCRIPT_HUD_EMIT_MS - (Date.now() - sentAt)))
    })
    send()
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [subscribeTranscriptSegments, publishTranscript])

  // The call's conversation (as the recording context announced it): to the
  // HUD whenever it changes, with this window's workspace.
  const announced = useSyncExternalStore(
    subscribeLiveCaptureConversations,
    () => announcedLiveConversation(captureId),
    () => null,
  )
  const latestConversation = useRef(announced)
  latestConversation.current = announced
  const publishConversation = useCallback(() => {
    const c = latestConversation.current
    if (!c) return
    const payload: LiveHudConversation = { ...c, workspaceId: getClientWorkspaceId() }
    void tauriEvent()
      .then(({ emitTo }) => emitTo(AGENT_HUD_WINDOW, LIVE_HUD_CONVERSATION_EVENT, payload))
      .catch(() => {})
  }, [])
  useEffect(publishConversation, [publishConversation, announced])

  // The HUD's chat is about to send: push the transcript, then say so (the
  // chat stops waiting after its cap either way).
  const flushRef = useRef(recording.flushTranscriptForAgent)
  flushRef.current = recording.flushTranscriptForAgent

  // The recording's state, for the HUD header's controls: on each change, with
  // the elapsed reading then (the HUD counts on from it; never a tick).
  const recordingNow = useRef(recording)
  recordingNow.current = recording
  const publishRecording = useCallback(() => {
    const r = recordingNow.current
    const payload = hudRecordingState({
      captureId,
      isPaused: r.isPaused,
      isAgentFinalizing: r.isAgentFinalizing,
      transcriptionStatus: r.transcriptionStatus,
      elapsedSec: r.getElapsed(),
      at: Date.now(),
    })
    void tauriEvent()
      .then(({ emitTo }) => emitTo(AGENT_HUD_WINDOW, HUD_RECORDING_STATE_EVENT, payload))
      .catch(() => {})
  }, [captureId])
  useEffect(publishRecording, [publishRecording, recording.isPaused, recording.isAgentFinalizing, recording.transcriptionStatus])
  // Gone (the recording stopped, or another capture): the HUD drops its controls.
  useEffect(
    () => () => {
      void tauriEvent()
        .then(({ emitTo }) => emitTo(AGENT_HUD_WINDOW, HUD_RECORDING_STATE_EVENT, { captureId: null }))
        .catch(() => {})
    },
    [captureId],
  )
  // The meeting's scheduled time, for the HUD header's time fill: on each change
  // (a capture with none sends `{ captureId: null }`, and the bar goes).
  const schedule = useCaptureSchedule(captureId)
  const latestSchedule = useRef(schedule)
  latestSchedule.current = schedule
  const publishSchedule = useCallback(() => {
    const payload = latestSchedule.current ?? { captureId: null }
    void tauriEvent()
      .then(({ emitTo }) => emitTo(AGENT_HUD_WINDOW, HUD_SCHEDULE_EVENT, payload))
      .catch(() => {})
  }, [])
  useEffect(publishSchedule, [publishSchedule, schedule])
  // The person's pre-call brief, for the HUD's Briefing line: on each change
  // (none sends `{ captureId: null }`, and the line goes).
  const brief = useCaptureBrief(captureId)
  const latestBrief = useRef(brief)
  latestBrief.current = brief
  const publishBrief = useCallback(() => {
    const payload = latestBrief.current ?? { captureId: null }
    void tauriEvent()
      .then(({ emitTo }) => emitTo(AGENT_HUD_WINDOW, HUD_BRIEF_EVENT, payload))
      .catch(() => {})
  }, [])
  useEffect(publishBrief, [publishBrief, brief])

  const recordingHandlers = useRef<HudRecordingHandlers>({
    pauseRecording: () => recordingNow.current.pauseRecording(),
    resumeRecording: () => recordingNow.current.resumeRecording(),
    stopRecording: () => recordingNow.current.stopRecording(),
    openCapture: (id) => {
      openActiveCapture(id)
      void bringThisWindowForward()
    },
  })
  // The HUD listens, so it shows the controls: the top bar's pill steps aside.
  const releaseClaim = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      releaseClaim.current?.()
      releaseClaim.current = null
    },
    [captureId],
  )

  // The HUD is listening: send it everything. A click there: run it here.
  useEffect(
    () =>
      listenScoped(async (gate) => {
        const { listen } = await tauriEvent()
        const offs = await Promise.allSettled([
          listen(VOICE_ID_HUD_READY_EVENT, gate(() => {
            publish()
            publishTranscript()
            publishConversation()
            publishRecording()
            publishSchedule()
            publishBrief()
            releaseClaim.current ??= claimHudRecordingControls(captureId)
          })),
          listen(HUD_RECORDING_ACTION_EVENT, gate((e: { payload: unknown }) => {
            runHudRecordingAction(e.payload, captureId, recordingHandlers.current)
          })),
          listen(LIVE_HUD_FLUSH_EVENT, gate((e: { payload: unknown }) => {
            const flush = readLiveHudFlush(e.payload)
            if (flush?.captureId !== captureId) return
            void Promise.resolve()
              .then(() => flushRef.current(captureId))
              .catch(() => {})
              .then(() => tauriEvent())
              .then(({ emitTo }) => emitTo(AGENT_HUD_WINDOW, LIVE_HUD_FLUSHED_EVENT, { id: flush.id }))
              .catch(() => {})
          })),
          listen(VOICE_ID_HUD_ACTION_EVENT, gate((e: { payload: unknown }) => {
            runVoiceIdHudAction(e.payload, captureId, handlers.current)
          })),
          // The HUD's goal line: write it here, then tell the HUD how it went.
          listen(HUD_GOAL_ACTION_EVENT, gate((e: { payload: unknown }) => {
            void runHudGoalAction(e.payload, captureId, (goal) => saveHudGoal(captureId, goal))
              .then(async (result) => {
                if (!result) return
                const { emitTo } = await tauriEvent()
                await emitTo(AGENT_HUD_WINDOW, HUD_GOAL_RESULT_EVENT, result)
              })
              .catch(() => {})
          })),
        ])
        return unlistenEach(offs)
      }),
    [captureId, publish, publishTranscript, publishConversation, publishRecording, publishSchedule, publishBrief],
  )

  return null
}

/**
 * Back to the capture from the HUD: bring this (the recording) window
 * forward through the desktop's `focus_own_window` command, which raises the
 * calling window (never an overlay). Best effort: a desktop build without the
 * command refuses it and only the capture's card opens, behind.
 */
async function bringThisWindowForward(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('focus_own_window').catch(() => {})
  } catch {
    /* not in the desktop app */
  }
}
