'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { tauriBridge, getThisWebviewLabel, type TrayCalendarEvent } from '@/lib/tauri-bridge'
import { listenScoped } from '@/lib/tauri-unlisten'
import { isDesktopApp } from '@/lib/platform'
import { useRecordingStable } from '@/hooks/recording-context'
import { openTarget } from '@/lib/chat-cards/open-card'

/**
 * Listens for "Start Capture" clicks from the macOS status bar tray
 * AND capture requests from the meeting detection HUD window.
 * Also auto-stops an active recording when the meeting detection
 * engine fires a "meeting-ended" event.
 *
 * Tray flow:
 *   1. Calls POST /api/account/captures/from-event to create (or find) the capture
 *   2. Starts live recording linked to the capture, which opens it as a card in
 *      a tab of its own (brought to the front)
 *
 * HUD flow:
 *   1. Triggers the same startRecording flow as the chat composer's Capture button
 *
 * Meeting-ended flow:
 *   1. If a recording is in progress, calls stopRecording() automatically
 *   2. Toasts the user to confirm the capture was stopped
 *
 * Mount this once inside DashboardShell (desktop only, no-op on web).
 *
 * MAIN-WINDOW ELECTION: every one-shot below arrives as a Rust BROADCAST, and
 * every dashboard window mounts this component — so with a workspace pop-out
 * open each intent would run once per window (double capture create, double
 * auto-stop). Exactly one window acts: the webview labelled 'main'. Rust keeps
 * broadcasting for old-bundle compatibility, so the filter has to live here.
 * The main window always exists even when hidden to the tray (close-to-tray
 * hides, never destroys), so electing 'main' can never drop an intent. Outside
 * the desktop shell the label is null and behaviour is unchanged.
 */
export function TrayStartCaptureHandler() {
  const { startRecordingForCapture, resumeCapture, startRecording, stopRecording, isRecording, captureId } = useRecordingStable()
  const startRecordingRef = useRef(startRecordingForCapture)
  const resumeCaptureRef = useRef(resumeCapture)
  const startRecordingNewRef = useRef(startRecording)
  const stopRecordingRef = useRef(stopRecording)
  const isRecordingRef = useRef(isRecording)
  const captureIdRef = useRef(captureId)
  useEffect(() => { startRecordingRef.current = startRecordingForCapture }, [startRecordingForCapture])
  useEffect(() => { resumeCaptureRef.current = resumeCapture }, [resumeCapture])
  useEffect(() => { startRecordingNewRef.current = startRecording }, [startRecording])
  useEffect(() => { stopRecordingRef.current = stopRecording }, [stopRecording])
  useEffect(() => { isRecordingRef.current = isRecording }, [isRecording])
  useEffect(() => { captureIdRef.current = captureId }, [captureId])

  useEffect(() => {
    if (!isDesktopApp()) return

    // Use a local ref so we can guard against the listener firing after cleanup
    let active = true

    // Listeners are registered IMMEDIATELY (label resolution is a second async
    // hop — deferring registration behind it would widen the startup window in
    // which a broadcast lands with nobody listening, and Tauri does not replay
    // these one-shots). Instead each handler runs through `runElected`, which
    // holds the work until the label promise settles, so an event delivered
    // before the election resolves is queued rather than lost or double-run.
    let thisLabel: string | null | undefined // undefined = not resolved yet
    let pending: Array<() => unknown> = []

    const labelReady = getThisWebviewLabel()
      .catch(() => null)
      .then((label) => {
        thisLabel = label
        const queued = pending
        pending = []
        // Only the elected window replays; a pop-out drops its queue.
        if (active && (label === null || label === 'main')) {
          for (const run of queued) void run()
        }
      })

    /** Run `fn` only in the elected window: web/single-context (null label) or
     *  the main dashboard. Pop-outs ignore the broadcast entirely. */
    const runElected = (fn: () => unknown) => {
      if (!active) return
      if (thisLabel === undefined) {
        pending.push(fn)
        void labelReady
        return
      }
      if (thisLabel !== null && thisLabel !== 'main') return
      void fn()
    }

    // Auto-stop recording when the meeting detection engine signals that the
    // video call has ended. Mirrors the auto-start behaviour on
    // meeting-detected-auto-start: when the OS detects Zoom/Meet/Teams has
    // exited, fire this and let the web side do the clean stop (saves
    // transcript, sets ended_at, generates title, etc.).
    const stopMeetingEnded = listenScoped((gate) => tauriBridge.onMeetingEnded(gate(() => runElected(async () => {
      if (!active) return
      if (!isRecordingRef.current) return // No active capture — nothing to stop

      try {
        await stopRecordingRef.current()
        toast.info('Capture stopped — meeting ended')
      } catch (err) {
        console.warn('[TrayStartCaptureHandler] Failed to auto-stop recording on meeting end:', err)
      }
    }))))

    // Listen for plain capture requests from the meeting detection HUD window.
    // When the HUD has an event linked, it emits `start-capture-from-event` instead
    // (handled by the tray listener below), so this only handles no-event captures.
    const stopHud = listenScoped((gate) => tauriBridge.onStartCaptureFromHud(gate(() => runElected(async () => {
      if (!active) return
      if (isRecordingRef.current) {
        toast.info('A capture is already in progress')
        return
      }
      try {
        await startRecordingNewRef.current()
      } catch (err) {
        toast.error('Could not start capture', {
          description: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }))))

    // Listen for event re-linking from the HUD dropdown while a capture is running
    const stopLinkEvent = listenScoped((gate) => tauriBridge.onHudLinkEvent(gate((event: TrayCalendarEvent | null) => runElected(async () => {
      if (!active) return
      const cid = captureIdRef.current
      if (!cid) return

      try {
        // link-event (not a raw capture PATCH): it carries the conflict guard,
        // re-seeds participants from the new event, and stamps the
        // series_key/ical_uid/occurrence_start thread fields.
        if (event?.title) {
          await fetch(`/api/account/captures/${cid}/link-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              calendar_event_id: event.id,
              title: event.title,
              start: event.start,
              end: event.end,
              attendees: event.attendees,
              organizer: event.organizer,
              conference_url: event.conferenceUrl,
              location: event.location,
              has_recurrence: event.hasRecurrence,
              source: event.source,
            }),
          })
        } else {
          await fetch(`/api/account/captures/${cid}/link-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calendar_event_id: null }),
          })
        }
        // Tell the capture detail panel to refetch so it shows the updated event
        window.dispatchEvent(new CustomEvent('ni:content-edited', { detail: { entityId: cid } }))
      } catch {
        // Silent — best-effort link update
      }
    }))))

    const stopFromEvent = listenScoped((gate) => tauriBridge.onStartCaptureFromEvent(gate((event: TrayCalendarEvent) => runElected(async () => {
      if (!active) return
      // If we only got an id (fallback), the captures list
      if (!event.title) {
        openTarget({ type: 'page', slug: 'captures' }, { from: 'desktop' })
        return
      }

      // Already recording — don't start a second session
      if (isRecordingRef.current) {
        toast.info('A capture is already in progress')
        return
      }

      const toastId = toast.loading(`Starting capture for "${event.title}"…`)

      try {
        const res = await fetch('/api/account/captures/from-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            calendar_event_id: event.id,
            title: event.title,
            start: event.start,
            end: event.end,
            attendees: event.attendees,
            organizer: event.organizer,
            conference_url: event.conferenceUrl,
            location: event.location,
            has_recurrence: event.hasRecurrence,
            source: event.source,
          }),
        })

        const data = await res.json()

        if (!res.ok || !data.capture_id) {
          throw new Error(data.error || 'Failed to create capture')
        }

        toast.dismiss(toastId)

        // Start recording linked to this capture (new or existing). Like every
        // capture it runs live: the recording opens it as a card in a tab of
        // its own and brings that tab to the front. This meeting's capture
        // closed moments ago (a mid-call restart) comes back as `resume`.
        if (data.resume) {
          await resumeCaptureRef.current(data.capture_id, { title: event.title })
        } else {
          await startRecordingRef.current(data.capture_id, { title: event.title })
        }
      } catch (err) {
        toast.dismiss(toastId)
        toast.error('Could not start capture', {
          description: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }))))

    return () => {
      active = false
      pending = []
      stopMeetingEnded()
      stopFromEvent()
      stopHud()
      stopLinkEvent()
    }
  }, [])

  return null
}
