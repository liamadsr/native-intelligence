/**
 * Which calendar a scheduled meeting link goes on, as the new-meeting dialog
 * picks it (client side). The person's last choice for meeting links first;
 * else the app's own default calendar for new events (the calendar's event
 * dialog keeps it as "oauth:<account>:<calendar>" under ni:default-calendar-id);
 * else the first of their writable calendars (the server lists their primary
 * first). Both kept in this browser's storage, as the app keeps such small
 * preferences; a storage that can't be read is no choice.
 */
export const MEETING_CALENDAR_KEY = 'ni:meeting-link-calendar'
export const APP_DEFAULT_CALENDAR_KEY = 'ni:default-calendar-id'

function read(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

/** The account in the app's default calendar id ("oauth:<account>:<calendar>"), or null. Pure. */
export function accountOfDefaultCalendar(value: string | null): string | null {
  const match = value ? /^oauth:([0-9a-f-]{36}):/i.exec(value) : null
  return match ? match[1] : null
}

/** The calendar to preselect among `ids` (the writable ones, the default first). Pure. */
export function defaultCalendarOf(ids: readonly string[], remembered: string | null, appDefault: string | null): string | null {
  if (!ids.length) return null
  if (remembered && ids.includes(remembered)) return remembered
  const fromApp = accountOfDefaultCalendar(appDefault)
  if (fromApp && ids.includes(fromApp)) return fromApp
  return ids[0]
}

/** This browser's remembered choice and the app's default calendar. */
export function storedCalendarChoice(): { remembered: string | null; appDefault: string | null } {
  return { remembered: read(MEETING_CALENDAR_KEY), appDefault: read(APP_DEFAULT_CALENDAR_KEY) }
}

/** Remember the person's choice for next time. */
export function rememberCalendarChoice(accountId: string): void {
  try {
    localStorage.setItem(MEETING_CALENDAR_KEY, accountId)
  } catch {
    // A storage that can't be written: the default next time.
  }
}
