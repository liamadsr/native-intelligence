'use client'

import { useCallback, useState } from 'react'
import { parseISO } from 'date-fns'
import { toast } from 'sonner'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { exclusiveEndDate } from '@/calendar/adapters'
import type { IEvent } from '@/calendar/interfaces'

/**
 * The canonical "start a meeting capture linked to a calendar event" flow,
 * shared by the calendar EventBlock (day/week views + the Capture button's calendar) so
 * the button behaves identically everywhere. Reproduces the macOS tray flow:
 *
 *   1. POST /api/account/captures/from-event — create OR find the capture linked
 *      to this event (idempotent; returns the existing one if already linked).
 *   2. Start recording (system audio on desktop, mic-only on web), live like
 *      every capture: the recording opens the capture as a card in a tab of
 *      its own and brings that tab to the front, as the Capture button does.
 *      When the route says `resume` (this meeting's capture was closed moments
 *      ago, e.g. by a mid-call restart), it is resumed instead of restarted.
 *
 * `startMeeting` is a no-op with a toast if a capture is already in progress.
 * `starting` reflects the in-flight state for the triggering event id.
 */
export function useStartMeetingFromEvent() {
  const recording = useOptionalRecordingStable()
  const [startingId, setStartingId] = useState<string | null>(null)

  const isRecording = !!recording?.isRecording

  const startMeeting = useCallback(
    async (event: IEvent) => {
      if (recording?.isRecording) {
        toast.info('A capture is already in progress')
        return
      }
      setStartingId(event.id)
      const toastId = toast.loading(`Starting capture for "${event.title}"…`)
      try {
        const res = await fetch('/api/account/captures/from-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            calendar_event_id: event.id,
            calendar_provider: event.provider,
            title: event.title,
            start: event.startDate,
            // An all-day endDate is the last day covered (adapters.ts); the
            // capture's scheduled_end is the instant it is over.
            end: exclusiveEndDate(event),
            // Prefer the name-carrying form so seedCaptureParticipants can
            // create a CRM contact with a real name, not the address.
            attendees: event.attendeeDetails ?? event.attendees,
            conference_url: event.conferenceUrl,
            location: event.location,
            series_master_id: event.seriesMasterId,
            ical_uid: event.icalUid,
            has_recurrence: event.hasRecurrence,
            source: event.source,
          }),
        })
        const data = await res.json()
        if (!res.ok || !data.capture_id) {
          throw new Error(data.error || 'Failed to create capture')
        }
        toast.dismiss(toastId)

        if (data.resume) {
          await recording?.resumeCapture(data.capture_id, { title: event.title })
        } else {
          await recording?.startRecordingForCapture(data.capture_id, { title: event.title })
        }
      } catch (err) {
        toast.dismiss(toastId)
        toast.error('Could not start capture', {
          description: err instanceof Error ? err.message : 'Unknown error',
        })
      } finally {
        setStartingId(null)
      }
    },
    [recording],
  )

  /** True while a meeting is happening now — used to reveal the button eagerly. */
  const isLive = useCallback((event: IEvent) => {
    const now = new Date()
    return parseISO(event.startDate) <= now && parseISO(exclusiveEndDate(event)) >= now
  }, [])

  return { startMeeting, startingId, isRecording, isLive }
}
