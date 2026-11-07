/**
 * Client-side utility for merging local Exchange calendar events (from macOS Calendar.app
 * via EventKit) with server-fetched events. Only active in the Tauri desktop app.
 */

import { isDesktopApp } from '@/lib/platform'
import type { CalendarEvent } from './calendar'

const STORAGE_KEY_DISABLED_CALENDARS = 'dial8:local-exchange:disabled-calendars'
const STORAGE_KEY_ENABLED_WORKSPACES = 'dial8:local-exchange:enabled-workspaces'

/**
 * Get the set of calendar IDs disabled by the user in the detail page.
 */
function getDisabledCalendarIds(): Set<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_DISABLED_CALENDARS)
    return stored ? new Set(JSON.parse(stored)) : new Set()
  } catch {
    return new Set()
  }
}

/**
 * Get the set of workspace IDs where local Exchange is enabled.
 * If not set, returns null (allow all — backward compat).
 */
function getEnabledWorkspaceIds(): Set<string> | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_ENABLED_WORKSPACES)
    if (!stored) return null // not configured yet — allow all for backward compat
    return new Set(JSON.parse(stored))
  } catch {
    return null
  }
}

/** Save the set of workspace IDs where local Exchange is enabled. */
export function setEnabledWorkspaceIds(ids: Set<string>) {
  localStorage.setItem(STORAGE_KEY_ENABLED_WORKSPACES, JSON.stringify([...ids]))
}

/** Check if local Exchange is enabled for a specific workspace. */
export function isLocalExchangeEnabledForWorkspace(workspaceId: string | null): boolean {
  if (!workspaceId) return true
  const enabled = getEnabledWorkspaceIds()
  if (!enabled) return true // not configured — allow all
  return enabled.has(workspaceId)
}

/**
 * Fetch local Exchange events from macOS Calendar.app and merge with server events.
 * On web, returns serverEvents unchanged. On desktop, merges + deduplicates.
 *
 * Respects three layers of filtering:
 * 1. Workspace scoping — skip if local Exchange not enabled for this workspace
 * 2. Disabled calendars from the detail page (localStorage)
 * 3. Dropdown filter (`filterAccountIds`) — `local:<calendarId>` entries
 */
export async function mergeWithLocalExchangeEvents(
  serverEvents: CalendarEvent[],
  timeMin: string,
  timeMax: string,
  filterAccountIds?: string[] | null,
  workspaceId?: string | null,
): Promise<CalendarEvent[]> {
  if (!isDesktopApp()) return serverEvents

  // If local Exchange is not enabled for this workspace, skip
  if (workspaceId && !isLocalExchangeEnabledForWorkspace(workspaceId)) {
    return serverEvents
  }

  // If a filter is active and doesn't include any local calendars, skip
  if (filterAccountIds && !filterAccountIds.some((id) => id.startsWith('local:'))) {
    return serverEvents
  }

  try {
    const { tauriBridge } = await import('@/lib/tauri-bridge')
    const localEvents = await tauriBridge.getLocalExchangeEvents({ timeMin, timeMax })

    // Layer 1: calendars disabled in detail page settings
    const disabledIds = getDisabledCalendarIds()

    // Layer 2: dropdown filter — which local calendar IDs are selected
    const selectedLocalIds = filterAccountIds
      ?.filter((id) => id.startsWith('local:'))
      .map((id) => id.replace('local:', ''))

    // Map + filter local events to CalendarEvent shape. Only calendars
    // disabled in settings are dropped here: the dropdown filter is a view
    // filter, applied below to what is returned, not to what is pushed.
    const mapped: CalendarEvent[] = localEvents
      // Skip if calendar is disabled in settings
      .filter((e) => !disabledIds.has(e.calendarId))
      .map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        isAllDay: e.isAllDay,
        calendarName: e.calendarName ?? 'Exchange (Local)',
        location: e.location ?? undefined,
        attendees: e.attendees,
        organizer: e.organizer ?? undefined,
        conferenceUrl: e.conferenceUrl ?? undefined,
        hasRecurrence: e.hasRecurrence,
        calendarId: e.calendarId,
        source: 'local_exchange',
      }))

    // Fire-and-forget: push exchange events to server so AI can access them.
    // The server deletes-and-replaces the whole range, so this must be every
    // enabled calendar's events, not just the ones the dropdown shows.
    if (mapped.length > 0) {
      pushLocalEventsToServer(mapped, timeMin, timeMax).catch(() => {})
    }

    // Skip if dropdown filter is active and this calendar isn't selected
    const visible = selectedLocalIds
      ? mapped.filter((e) => selectedLocalIds.includes(e.calendarId ?? ''))
      : mapped

    return deduplicateEvents([...serverEvents, ...visible])
  } catch {
    // Sidecar not available or EventKit not authorized — return server events only
    return serverEvents
  }
}

/**
 * Push local exchange events to the server for AI access.
 * Sends the time range so the server can delete-and-replace,
 * ensuring removed/moved events don't linger.
 * Fire-and-forget — failures are silently ignored.
 */
async function pushLocalEventsToServer(events: CalendarEvent[], timeMin: string, timeMax: string): Promise<void> {
  await fetch('/api/account/calendar/local-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin,
      timeMax,
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        isAllDay: e.isAllDay,
        location: e.location,
        organizer: e.organizer,
        attendees: e.attendees,
        conferenceUrl: e.conferenceUrl,
        calendarName: e.calendarName,
        calendarId: e.calendarId,
        hasRecurrence: e.hasRecurrence,
        description: e.description,
      })),
    }),
  })
}

/**
 * Deduplicate events by title + start time (truncated to minute).
 * When duplicates exist, the first occurrence wins (server events come first).
 */
function deduplicateEvents(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>()
  return events.filter((event) => {
    const startKey = event.start.substring(0, 16) // "2025-01-15T10:00"
    const key = `${event.title.toLowerCase()}|${startKey}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
