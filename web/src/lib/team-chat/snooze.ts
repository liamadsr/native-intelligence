/**
 * Muting a channel for a while (docs/plans/channels-inbox.md, phase 1;
 * migration 702): from the channel's menu, for an hour, until tomorrow
 * morning or for a week. While it lasts nothing about the channel notifies
 * the person (no inbox item, banner or email, mentions included), as if it
 * were muted; unlike a mute its unread count keeps counting, and it ends by
 * itself. "Until I turn it back on" is the `muted` level (migration 560), not
 * a snooze.
 *
 * Pure and client-safe: the page works out the time in the person's own
 * clock, the route checks it ({@link snoozeUntilError}) and 702's
 * team_chat_snooze stores it.
 */

/** The menu's timed choices. */
export const SNOOZE_CHOICES = ['hour', 'tomorrow', 'week'] as const
export type SnoozeChoice = (typeof SNOOZE_CHOICES)[number]

/** The longest snooze 702 accepts. */
export const SNOOZE_MAX_MS = 31 * 24 * 60 * 60_000
/** "Until tomorrow" ends at this hour of the next morning, the person's own time. */
export const SNOOZE_MORNING_HOUR = 8

export function isSnoozeChoice(value: unknown): value is SnoozeChoice {
  return typeof value === 'string' && (SNOOZE_CHOICES as readonly string[]).includes(value)
}

/** When a choice ends, from `now` in the clock of the device it runs on (the person's). */
export function snoozeUntil(choice: SnoozeChoice, now: Date = new Date()): Date {
  if (choice === 'hour') return new Date(now.getTime() + 60 * 60_000)
  if (choice === 'week') return new Date(now.getTime() + 7 * 24 * 60 * 60_000)
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, SNOOZE_MORNING_HOUR, 0, 0, 0)
  return next
}

/** The menu's words for a choice. */
export function snoozeChoiceLabel(choice: SnoozeChoice): string {
  if (choice === 'hour') return 'Mute for 1 hour'
  if (choice === 'tomorrow') return 'Mute until tomorrow'
  return 'Mute for a week'
}

/** True while a stored snooze is still running. */
export function isSnoozed(mutedUntil: string | null | undefined, now: Date = new Date()): boolean {
  if (!mutedUntil) return false
  const at = Date.parse(mutedUntil)
  return Number.isFinite(at) && at > now.getTime()
}

/**
 * Why a requested end time is refused, or null when it's fine: a time, in
 * the future, at most {@link SNOOZE_MAX_MS} away (702 holds the same).
 */
export function snoozeUntilError(raw: unknown, now: Date = new Date()): string | null {
  if (typeof raw !== 'string') return 'until must be a time'
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return 'until must be a time'
  if (at <= now.getTime()) return 'until must be in the future'
  if (at - now.getTime() > SNOOZE_MAX_MS) return 'a channel can be muted for 31 days at most'
  return null
}

/**
 * How the header says it: "Muted until 3:00 PM" today, "Muted until
 * tomorrow, 8:00 AM", else "Muted until Tue, Nov 24, 8:00 AM". In the
 * device's own locale and clock.
 */
export function snoozeLabel(mutedUntil: string, now: Date = new Date(), locale?: string): string {
  const at = new Date(mutedUntil)
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(at) - day(now)) / (24 * 60 * 60_000))
  if (days <= 0) return `Muted until ${time}`
  if (days === 1) return `Muted until tomorrow, ${time}`
  const date = at.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })
  return `Muted until ${date}, ${time}`
}
