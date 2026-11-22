/**
 * The calendars on the Calendar page and which of them are hidden.
 *
 * A calendar is what the grid colours as one (event-colors' calendarKey): an
 * account's calendar by name. The list is read off the events the page holds
 * (last month to the end of next month), so it needs no provider call and its
 * swatches are the grid's own colours; a calendar with no event in that window
 * is not listed.
 *
 * Hidden calendars are kept as a set of keys in this browser (localStorage,
 * one small entry for all workspaces), as the page's other view choices are:
 * nothing is stored on the server, and a calendar seen for the first time is
 * shown. Hiding is the page's own: the Capture button's calendar, a chat's
 * calendar card and the assistant still read every calendar.
 *
 * Pure but for the two storage functions; the behaviour follows Macro's
 * calendar sidebar (github.com/macro-inc/macro, AGPL-3.0). None of its code
 * is here.
 */
import type { IEvent } from '@/calendar/interfaces'
import type { TEventColor } from '@/calendar/types'

export interface SidebarCalendar {
  /** `${accountId}|${calendarName}`: the key the grid colours by. */
  key: string
  name: string
  color: TEventColor
}

export interface SidebarAccount {
  /** The connected account's id; '' for calendars no account stands behind (the desktop's Exchange calendars). */
  id: string
  label: string
  calendars: SidebarCalendar[]
}

export const calendarKeyOf = (event: Pick<IEvent, 'accountId' | 'calendarName'>): string => `${event.accountId ?? ''}|${event.calendarName ?? ''}`

/** The calendars among these (already coloured) events, by account, in name order. Tasks are not a calendar. */
export function listCalendars(events: readonly IEvent[]): SidebarAccount[] {
  const accounts = new Map<string, SidebarAccount & { seen: Set<string> }>()
  for (const event of events) {
    if (event.isAction) continue
    const id = event.accountId ?? ''
    let account = accounts.get(id)
    if (!account) {
      account = { id, label: '', calendars: [], seen: new Set() }
      accounts.set(id, account)
    }
    if (!account.label && event.accountEmail) account.label = event.accountEmail
    const key = calendarKeyOf(event)
    if (account.seen.has(key)) continue
    account.seen.add(key)
    account.calendars.push({ key, name: event.calendarName || 'Calendar', color: event.color })
  }
  return [...accounts.values()]
    .map(({ id, label, calendars }) => ({
      id,
      label: label || (id ? 'Calendar account' : 'On this Mac'),
      calendars: calendars.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => Number(!a.id) - Number(!b.id) || a.label.localeCompare(b.label))
}

/** The events of calendars that are shown. Tasks always are. The same array when nothing is hidden. */
export function withoutHiddenCalendars(events: IEvent[], hidden: ReadonlySet<string>): IEvent[] {
  if (hidden.size === 0) return events
  const shown = events.filter((event) => event.isAction || !hidden.has(calendarKeyOf(event)))
  return shown.length === events.length ? events : shown
}

/** An account's checkbox: every calendar shown, none, or some. */
export function accountVisibility(account: SidebarAccount, hidden: ReadonlySet<string>): 'all' | 'none' | 'some' {
  const hiddenCount = account.calendars.filter((c) => hidden.has(c.key)).length
  return hiddenCount === 0 ? 'all' : hiddenCount === account.calendars.length ? 'none' : 'some'
}

/** Show or hide one calendar. */
export function toggleCalendar(hidden: ReadonlySet<string>, key: string, show: boolean): Set<string> {
  const next = new Set(hidden)
  if (show) next.delete(key)
  else next.add(key)
  return next
}

/** Show or hide every calendar of an account. */
export function toggleAccount(hidden: ReadonlySet<string>, account: SidebarAccount, show: boolean): Set<string> {
  const next = new Set(hidden)
  for (const calendar of account.calendars) {
    if (show) next.delete(calendar.key)
    else next.add(calendar.key)
  }
  return next
}

const HIDDEN_KEY = 'ni:calendar-hidden:v1'
/** A list longer than this is not kept (nobody hides this many calendars; a runaway write would eat the shared quota). */
const HIDDEN_MAX = 200

export function readHiddenCalendars(): Set<string> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(HIDDEN_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string').slice(0, HIDDEN_MAX) : [])
  } catch {
    return new Set()
  }
}

export function writeHiddenCalendars(hidden: ReadonlySet<string>): void {
  try {
    if (hidden.size === 0) localStorage.removeItem(HIDDEN_KEY)
    else localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden].slice(0, HIDDEN_MAX)))
  } catch {
    // Kept for this visit only.
  }
}
