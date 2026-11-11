'use client'

import { useJoinOurMeeting, useOurMeeting } from '@/components/meeting-links/join-meeting'
import { useCallback, useEffect, useState } from 'react'
import { endOfDay, format, isToday, isTomorrow, isValid, isYesterday, parseISO } from 'date-fns'
import {
  Calendar,
  Check,
  Clock,
  ExternalLink,
  Loader2,
  MapPin,
  Mic,
  Plus,
  Text,
  Trash2,
  Users,
  Video,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { DateTimePicker } from '@/components/ui/datetime-picker'
import { ListenBrief } from '@/components/read-aloud/listen-brief'
import { plainLine } from '@/lib/read-aloud/listen-briefs'
import { CaptureStatusIndicator } from '@/calendar/components/capture-status-indicator'
import { exclusiveEndDate } from '@/calendar/adapters'
import { patchCalendarEventsCache } from '@/calendar/hooks/use-calendar-events'
import { useStartMeetingFromEvent } from '@/calendar/hooks/use-start-meeting'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

import type { IEvent } from '@/calendar/interfaces'
import { SYSTEM_BROWSER_PROPS } from '@/lib/open-external'
import { Linkify } from '@/components/ui/linkify'
import { toast } from 'sonner'

interface CalendarEventDetailPanelProps {
  event: IEvent
  onClose: () => void
  onEventUpdate?: (updatedEvent: IEvent) => void
  onEventDelete?: (eventId: string) => void
  /** Open a capture's detail panel. The dashboard is a tab shell, not a route
   *  tree — there is no /account/captures/[id] page — so opening a capture has
   *  to go through the tab's history rather than the router. */
  onOpenCapture?: (captureId: string, title: string) => void
}

interface PreviousSession {
  id: string
  title: string
  is_own: boolean
  owner_name: string | null
  occurrence_start: string
}

/** What the Listen brief is told about this event, which lives in Google or
 *  Microsoft rather than our database (lib/listen-briefs/builders/event.ts):
 *  small and plain, the guests capped (the brief reads 30) and the
 *  description cut. */
function listenBriefInput(event: IEvent) {
  const guests: Array<{ email: string; name?: string; responseStatus?: string }> =
    event.attendeeDetails ?? (event.attendees ?? []).map((email) => ({ email }))
  return {
    title: event.title,
    start: event.startDate,
    end: event.endDate,
    isAllDay: event.isAllDay,
    location: event.location,
    hasVideoCall: !!event.conferenceUrl,
    description: event.description?.slice(0, 1500),
    attendees: guests.slice(0, 30).map(({ email, name, responseStatus }) => ({ email, name, responseStatus })),
    attendeeCount: guests.length > 30 ? guests.length : undefined,
    organizer: event.attendeeDetails?.find((a) => a.isOrganizer)?.email,
    icalUid: event.icalUid,
    seriesMasterId: event.seriesMasterId,
    linkedCaptureId: event.linkedCapture?.capture_id,
  }
}

/** "today at 3:25 PM", "tomorrow", "Tuesday, September 29 at 10 AM": when,
 *  for the brief's plain line if no brief comes. */
function spokenWhen(event: IEvent): string | null {
  // An all-day date as providers send it (a bare date, or UTC midnight) is
  // that day wherever the user is.
  const day = event.isAllDay && /^\d{4}-\d{2}-\d{2}(T00:00(:00(\.0+)?)?Z)?$/.test(event.startDate)
  const start = parseISO(day ? event.startDate.slice(0, 10) : event.startDate)
  if (!isValid(start)) return null
  const date = isToday(start)
    ? 'today'
    : isTomorrow(start)
      ? 'tomorrow'
      : isYesterday(start)
        ? 'yesterday'
        : format(start, 'EEEE, MMMM d')
  return event.isAllDay ? date : `${date} at ${format(start, start.getMinutes() ? 'h:mm a' : 'h a')}`
}

export function CalendarEventDetailPanel({ event, onClose, onEventUpdate, onEventDelete, onOpenCapture }: CalendarEventDetailPanelProps) {
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [previousSessions, setPreviousSessions] = useState<PreviousSession[]>([])

  // Editable fields
  const [title, setTitle] = useState(event.title)
  const [startDate, setStartDate] = useState<Date>(parseISO(event.startDate))
  const [endDate, setEndDate] = useState<Date>(parseISO(event.endDate))
  const [location, setLocation] = useState(event.location || '')
  // One of our meeting links (phase 7): Join opens the meeting in the app.
  const ourMeeting = useOurMeeting(event.conferenceUrl)
  const { join: joinOurMeeting, joining } = useJoinOurMeeting()
  const [description, setDescription] = useState(event.description || '')

  // Track if any field has been modified
  const isDirty =
    title !== event.title ||
    startDate.toISOString() !== parseISO(event.startDate).toISOString() ||
    endDate.toISOString() !== parseISO(event.endDate).toISOString() ||
    location !== (event.location || '') ||
    description !== (event.description || '')

  // Reset form when event changes
  useEffect(() => {
    setTitle(event.title)
    setStartDate(parseISO(event.startDate))
    setEndDate(parseISO(event.endDate))
    setLocation(event.location || '')
    setDescription(event.description || '')
  }, [event.id, event.title, event.startDate, event.endDate, event.location, event.description])

  const now = new Date()
  // An all-day endDate is the LAST day covered (date-only, see
  // calendarEventToIEvent), so it ends at that day's end, not its midnight.
  const endInstant =
    event.isAllDay && /^\d{4}-\d{2}-\d{2}$/.test(event.endDate)
      ? endOfDay(parseISO(event.endDate))
      : parseISO(event.endDate)
  const isHappeningNow = parseISO(event.startDate) <= now && endInstant >= now
  const isStartingSoon =
    parseISO(event.startDate).getTime() - now.getTime() < 15 * 60 * 1000 &&
    !isHappeningNow &&
    parseISO(event.startDate) > now
  const isPast = endInstant < now

  const capture = event.linkedCapture
  const showStartCapture =
    (isHappeningNow || isStartingSoon) &&
    (!capture || capture.auto_capture_status === 'pending')
  const showAddCapture = isPast && !capture

  // Recurring-meeting history: earlier captures of this series, visible to the
  // caller (both endpoints run under RLS — own + workspace-shared only).
  // Capture-anchored when the event has a linked capture; otherwise the
  // event-anchored lookup covers fresh Google/Microsoft occurrences whose
  // per-occurrence event id has no capture yet but whose series has history.
  // The CURRENT occurrence is excluded wholesale — a teammate's capture of
  // today's call is not a "previous session".
  const linkedCaptureId = capture?.capture_id
  useEffect(() => {
    setPreviousSessions([])
    let cancelled = false
    ;(async () => {
      try {
        interface OccurrenceGroup {
          occurrence_start: string
          captures: Array<Omit<PreviousSession, 'occurrence_start'>>
        }
        let occurrences: OccurrenceGroup[] = []
        let currentOccurrenceMs: number | null = new Date(event.startDate).getTime()

        if (linkedCaptureId) {
          const res = await fetch(`/api/account/captures/${linkedCaptureId}/series`)
          if (!res.ok || cancelled) return
          const data = await res.json()
          occurrences = data.occurrences || []
          // The occurrence holding the linked capture IS the current one —
          // prefer that over the event's start (reschedules drift).
          for (const o of occurrences) {
            if (o.captures.some((c) => c.id === linkedCaptureId)) {
              currentOccurrenceMs = new Date(o.occurrence_start).getTime()
            }
          }
        } else if (event.seriesMasterId || event.icalUid || event.hasRecurrence) {
          const seriesParams = new URLSearchParams({ calendar_event_id: event.id })
          if (event.seriesMasterId) seriesParams.set('series_master_id', event.seriesMasterId)
          if (event.icalUid) seriesParams.set('ical_uid', event.icalUid)
          const res = await fetch(`/api/account/calendar/event-series?${seriesParams}`)
          if (!res.ok || cancelled) return
          const data = await res.json()
          occurrences = data.occurrences || []
        } else {
          return
        }

        const sessions: PreviousSession[] = occurrences
          .filter((o) => new Date(o.occurrence_start).getTime() !== currentOccurrenceMs)
          .flatMap((o) => o.captures.map((c) => ({ ...c, occurrence_start: o.occurrence_start })))
        if (!cancelled) setPreviousSessions(sessions)
      } catch {
        // best-effort — the panel works without history
      }
    })()
    return () => { cancelled = true }
  }, [linkedCaptureId, event.id, event.startDate, event.seriesMasterId, event.icalUid, event.hasRecurrence])

  const isAction = event.isAction

  // Same find-or-create + navigate + record flow as the calendar Start button.
  // The old handlers here POSTed the generic /api/account/captures route, whose
  // insert allowlist silently drops calendar_event_id (orphan capture) and whose
  // response shape is {capture:{id}} — the panel then navigated to `undefined`.
  const { startMeeting } = useStartMeetingFromEvent()

  async function handleStartCapture() {
    setCreating(true)
    try {
      await startMeeting(event)
    } finally {
      setCreating(false)
    }
  }

  async function handleCreateCapture() {
    setCreating(true)
    try {
      const res = await fetch('/api/account/captures/from-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendar_event_id: event.id,
          calendar_provider: event.provider,
          title: event.title,
          start: event.startDate,
          // All-day: the exclusive end, not the last day's 00:00 (adapters.ts).
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
          // Past-meeting capture: create it already closed so it never
          // occupies the meeting's live slot (see from-event route).
          retro: true,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.capture_id) onOpenCapture?.(data.capture_id, event.title)
      } else {
        toast.error('Could not create the capture')
      }
    } catch {
      toast.error('Could not create the capture')
    } finally {
      setCreating(false)
    }
  }

  const handleSave = useCallback(async () => {
    if (!isDirty || saving || !title.trim()) return
    setSaving(true)

    // An all-day event's times are not editable here, and its endDate is the
    // LAST day it covers (the calendar adapter turns the provider's exclusive
    // end into an inclusive one). Writing it back would cut a day off, and as a
    // dateTime it would turn the event into a timed one, so leave both out.
    const timing = event.isAllDay ? {} : { start: startDate.toISOString(), end: endDate.toISOString() }

    const updatedEvent: IEvent = {
      ...event,
      title: title.trim(),
      startDate: event.isAllDay ? event.startDate : startDate.toISOString(),
      endDate: event.isAllDay ? event.endDate : endDate.toISOString(),
      location: location.trim() || undefined,
      description: description.trim(),
    }

    // Notify parent for optimistic update
    onEventUpdate?.(updatedEvent)

    try {
      if (event.source === 'local_exchange') {
        const { tauriBridge } = await import('@/lib/tauri-bridge')
        // The native write resolves { success: false } on a refused write.
        const result = await tauriBridge.updateLocalExchangeEvent({
          eventId: event.id,
          title: title.trim(),
          ...timing,
          location: location.trim() || undefined,
          notes: description.trim() || undefined,
        })
        if (!result?.success) throw new Error(result?.error ?? 'Event update failed')
      } else {
        // fetch resolves on 4xx/5xx (e.g. an expired provider token): throw so
        // the catch below reverts instead of caching an edit that never saved.
        const res = await fetch('/api/calendar/events', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventId: event.id,
            title: title.trim(),
            ...timing,
            description: description.trim(),
            location: location.trim(),
          }),
        })
        if (!res.ok) throw new Error(`Event update failed: ${res.status}`)
        // Saved, with a word to say (a meeting link that couldn't follow the new length exactly).
        const saved = (await res.json().catch(() => null)) as { notice?: string } | null
        if (saved?.notice) toast(saved.notice)
      }
      // Fold the confirmed edit into the shared events cache so the calendar
      // grid and widget show it without waiting for the next poll.
      patchCalendarEventsCache((prev) => {
        const index = prev.findIndex((e) => e.id === updatedEvent.id)
        if (index === -1) return prev
        return [...prev.slice(0, index), updatedEvent, ...prev.slice(index + 1)]
      })
    } catch {
      // Revert on failure — restore original event
      onEventUpdate?.(event)
      toast.error('Could not save the event')
    } finally {
      setSaving(false)
    }
  }, [isDirty, saving, title, startDate, endDate, location, description, event, onEventUpdate])

  const handleDelete = useCallback(async () => {
    setDeleting(true)

    // Notify parent for optimistic removal
    onEventDelete?.(event.id)

    try {
      if (event.source === 'local_exchange') {
        const { tauriBridge } = await import('@/lib/tauri-bridge')
        const result = await tauriBridge.deleteLocalExchangeEvent(event.id)
        if (!result?.success) throw new Error(result?.error ?? 'Event delete failed')
      } else {
        const res = await fetch(`/api/calendar/events?eventId=${encodeURIComponent(event.id)}`, {
          method: 'DELETE',
        })
        if (!res.ok) throw new Error(`Event delete failed: ${res.status}`)
      }
      patchCalendarEventsCache((prev) =>
        prev.some((e) => e.id === event.id) ? prev.filter((e) => e.id !== event.id) : prev,
      )
      onClose()
    } catch {
      // Revert on failure — re-add the event
      onEventUpdate?.(event)
      toast.error('Could not delete the event')
      setDeleting(false)
    }
  }, [event, onEventUpdate, onEventDelete, onClose])

  // Duration display
  const durationMs = endDate.getTime() - startDate.getTime()
  const durationMin = Math.round(durationMs / 60000)
  const durationLabel =
    durationMin >= 60
      ? `${Math.floor(durationMin / 60)}h ${durationMin % 60 > 0 ? `${durationMin % 60}m` : ''}`
      : `${durationMin}m`

  return (
    <div className="flex h-full flex-col">
      {/* Listen mode: a spoken prep for this meeting as it opens (or, once
          it's over and recorded, what came of it). An action on the calendar
          gets the action's own brief. */}
      {isAction && event.actionId ? (
        <ListenBrief kind="action" id={event.actionId} fallback={() => plainLine(event.title)} />
      ) : (
        <ListenBrief
          kind="event"
          id={event.id}
          input={listenBriefInput(event)}
          fallback={() => plainLine(event.title, spokenWhen(event))}
        />
      )}

      {/* Header toolbar */}
      <div className="flex h-10 shrink-0 items-center px-3">
        <div className="ml-auto flex items-center gap-1">
          {event.conferenceUrl && ourMeeting && (
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" disabled={joining} onClick={() => void joinOurMeeting(ourMeeting)} data-calendar-join-meeting="">
              <Video className="h-3.5 w-3.5" />
              Join
            </Button>
          )}
          {event.conferenceUrl && !ourMeeting && (
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" asChild>
              {/* Joining launches the meeting app (and needs a camera and
                  mic): the user's browser, never the in-app one. */}
              <a href={event.conferenceUrl} target="_blank" rel="noopener noreferrer" {...SYSTEM_BROWSER_PROPS}>
                <Video className="h-3.5 w-3.5" />
                Join
              </a>
            </Button>
          )}
          {event.htmlLink && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" asChild>
              <a href={event.htmlLink} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
          {!isAction && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  disabled={deleting}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete event</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete &ldquo;{event.title}&rdquo;? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDelete}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-5 space-y-5">
          {/* Title — editable */}
          {isAction ? (
            <div>
              <h2 className="text-lg font-semibold leading-tight">{event.title}</h2>
            </div>
          ) : (
            <div>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full border-0 border-b-2 border-transparent bg-transparent pb-1 text-lg font-semibold leading-tight text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-primary transition-colors"
                placeholder="Event title"
              />
            </div>
          )}

          {/* Status badges */}
          <div className="flex flex-wrap items-center gap-2">
            {capture && <CaptureStatusIndicator capture={capture} />}
            {isHappeningNow && (
              <Badge variant="default" className="text-xs">Happening now</Badge>
            )}
            {isStartingSoon && (
              <Badge variant="secondary" className="text-xs">Starting soon</Badge>
            )}
            {event.isAllDay && (
              <Badge variant="outline" className="text-xs">All day</Badge>
            )}
            {event.calendarName && (
              <Badge variant="outline" className="text-xs">{event.calendarName}</Badge>
            )}
          </div>

          {/* Date & time — editable */}
          <div className="space-y-3">
            {isAction ? (
              <div className="flex items-center gap-3">
                <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-sm">{format(startDate, 'EEEE, MMMM d, yyyy')}</p>
                  {!event.isAllDay && (
                    <p className="text-sm text-muted-foreground">
                      {format(startDate, 'h:mm a')} – {format(endDate, 'h:mm a')}
                      <span className="ml-1.5 text-xs">({durationLabel})</span>
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <Clock className="mt-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 space-y-2">
                  <p className="text-sm text-foreground">{format(startDate, 'EEEE, MMMM d, yyyy')}</p>
                  {!event.isAllDay && (
                    <div className="flex items-center gap-1.5 text-sm">
                      <DateTimePicker
                        value={startDate}
                        onChange={(d) => {
                          if (!d) return
                          setStartDate(d)
                          // If start is moved past end, adjust end to maintain duration
                          if (d >= endDate) {
                            setEndDate(new Date(d.getTime() + durationMs))
                          }
                        }}
                        granularity="minute"
                        hourCycle={12}
                        displayFormat={{ hour12: 'h:mm a' }}
                        placeholder="Start"
                        className="h-7 w-auto min-w-0 gap-1 border-none px-2 text-sm font-medium shadow-none hover:bg-muted"
                      />
                      <span className="text-muted-foreground">&ndash;</span>
                      <DateTimePicker
                        value={endDate}
                        onChange={(d) => d && setEndDate(d)}
                        granularity="minute"
                        hourCycle={12}
                        displayFormat={{ hour12: 'h:mm a' }}
                        placeholder="End"
                        className="h-7 w-auto min-w-0 gap-1 border-none px-2 text-sm font-medium shadow-none hover:bg-muted"
                      />
                      <span className="text-xs text-muted-foreground">({durationLabel})</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Location — editable */}
            {isAction ? (
              event.location && (
                <div className="flex items-center gap-3">
                  <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="text-sm">{event.location}</p>
                </div>
              )
            ) : (
              <div className="flex items-center gap-3">
                <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Input
                  placeholder="Add location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="h-7 border-none bg-transparent px-1 text-sm shadow-none focus-visible:ring-0 placeholder:text-muted-foreground/50"
                />
              </div>
            )}

            {/* Conference URL — read only */}
            {event.conferenceUrl && (
              <div className="flex items-center gap-3">
                <Video className="h-4 w-4 shrink-0 text-muted-foreground" />
                {ourMeeting ? (
                  <button type="button" disabled={joining} onClick={() => void joinOurMeeting(ourMeeting)} className="min-w-0 flex-1 truncate text-left text-sm text-primary hover:underline">
                    Join meeting
                  </button>
                ) : (
                <a
                  href={event.conferenceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  {...SYSTEM_BROWSER_PROPS}
                  className="min-w-0 flex-1 text-sm text-primary hover:underline truncate"
                >
                  Join meeting
                </a>
                )}
              </div>
            )}
          </div>

          {/* Attendees — read only */}
          {event.attendees && event.attendees.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Guests ({event.attendees.length})
                </span>
              </div>
              <div className="space-y-1 pl-6">
                {event.attendees.map((attendee, i) => (
                  <p key={i} className="text-sm">{attendee}</p>
                ))}
              </div>
            </div>
          )}

          {/* Description — editable */}
          {isAction ? (
            event.description && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Text className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Description
                  </span>
                </div>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap pl-6">
                  <Linkify text={event.description} />
                </p>
              </div>
            )
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Text className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Description
                </span>
              </div>
              <div className="pl-6">
                <Textarea
                  placeholder="Add description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  className="min-h-0 resize-none border-none bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 placeholder:text-muted-foreground/50"
                />
              </div>
            </div>
          )}

          {/* Save button — shown when dirty */}
          {isDirty && !isAction && (
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                className="h-8 text-sm"
                onClick={handleSave}
                disabled={saving || !title.trim()}
              >
                {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-sm"
                onClick={() => {
                  setTitle(event.title)
                  setStartDate(parseISO(event.startDate))
                  setEndDate(parseISO(event.endDate))
                  setLocation(event.location || '')
                  setDescription(event.description || '')
                }}
              >
                Discard
              </Button>
            </div>
          )}

          {/* Capture actions */}
          {(showStartCapture || showAddCapture || capture?.auto_capture_status === 'completed') && (
            <div className="border-t border-border pt-4 space-y-2">
              {capture?.auto_capture_status === 'completed' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start gap-2"
                  // The link carries no capture title — captures made from an
                  // event are named after it, so the event title is the label.
                  onClick={() => onOpenCapture?.(capture.capture_id, event.title)}
                >
                  <Check className="h-3.5 w-3.5" />
                  View Capture
                  {capture.source_action_count > 0 && ` (${capture.source_action_count} actions)`}
                </Button>
              )}

              {showStartCapture && (
                <Button
                  size="sm"
                  className="w-full justify-start gap-2"
                  onClick={handleStartCapture}
                  disabled={creating}
                >
                  <Mic className="h-3.5 w-3.5" />
                  Start Capture
                </Button>
              )}

              {showAddCapture && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2"
                  onClick={handleCreateCapture}
                  disabled={creating}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add capture for this meeting
                </Button>
              )}
            </div>
          )}

          {/* Previous sessions of this recurring meeting */}
          {previousSessions.length > 0 && (
            <div className="border-t border-border pt-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Previous sessions</p>
              <div className="space-y-0.5">
                {previousSessions.slice(0, 8).map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onOpenCapture?.(s.id, s.title)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground/80 transition-colors hover:bg-muted/50"
                  >
                    <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {new Date(s.occurrence_start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    {!s.is_own && s.owner_name && (
                      <span className="max-w-[80px] shrink-0 truncate text-[10px] text-muted-foreground" title={`Captured by ${s.owner_name}`}>
                        {s.owner_name}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
