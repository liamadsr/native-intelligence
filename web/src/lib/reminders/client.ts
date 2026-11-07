/**
 * Browser-side reminder API helpers.
 *
 * Reminders are private per-user rows, so they never travel on the shared
 * entity-event bus (`entity-events.ts` mirrors across tabs and re-emits
 * teammates' realtime changes — neither applies here). Instead this module
 * owns a single in-tab CustomEvent so the surfaces that show a reminder for
 * the same entity — the header pill, the toolbar popover, a row context
 * menu — stay in sync after any set/clear without each one polling.
 *
 * Every mutation helper emits it on success; call sites just await.
 */
import type { Reminder, ReminderEntityType } from './types'

const REMINDER_CHANGED_EVENT = 'dial8:reminder-changed'

export interface ReminderChangedDetail {
  entityType: ReminderEntityType
  entityId: string
}

/** Read the `{ error }` body an api-errors helper returns, with a fallback. */
async function apiError(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null)
  return new Error(body?.error || fallback)
}

/** The caller's pending reminder for this entity, or null if there isn't one. */
export async function fetchReminder(
  entityType: ReminderEntityType,
  entityId: string,
): Promise<Reminder | null> {
  const params = new URLSearchParams({ entity_type: entityType, entity_id: entityId })
  const res = await fetch(`/api/account/reminders?${params}`)
  if (!res.ok) throw await apiError(res, 'Could not load the reminder.')
  const body = (await res.json()) as { reminder: Reminder | null }
  return body.reminder ?? null
}

/**
 * Set (or replace) the caller's pending reminder for this entity. One-shot —
 * the server upserts onto the existing pending row rather than stacking.
 */
export async function setReminder(
  entityType: ReminderEntityType,
  entityId: string,
  remindAt: Date,
): Promise<Reminder> {
  const res = await fetch('/api/account/reminders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_type: entityType,
      entity_id: entityId,
      remind_at: remindAt.toISOString(),
    }),
  })
  if (!res.ok) throw await apiError(res, 'Could not set the reminder.')
  const body = (await res.json()) as { reminder: Reminder }
  emitReminderChanged(entityType, entityId)
  return body.reminder
}

/** Drop the caller's pending reminder for this entity. No-op if none exists. */
export async function clearReminder(
  entityType: ReminderEntityType,
  entityId: string,
): Promise<void> {
  const params = new URLSearchParams({ entity_type: entityType, entity_id: entityId })
  const res = await fetch(`/api/account/reminders?${params}`, { method: 'DELETE' })
  if (!res.ok) throw await apiError(res, 'Could not remove the reminder.')
  emitReminderChanged(entityType, entityId)
}

/** Announce that this entity's pending reminder changed (set, moved, cleared). */
export function emitReminderChanged(entityType: ReminderEntityType, entityId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<ReminderChangedDetail>(REMINDER_CHANGED_EVENT, {
      detail: { entityType, entityId },
    }),
  )
}

/** Subscribe to reminder changes. Returns an unsubscribe function. */
export function onReminderChanged(cb: (detail: ReminderChangedDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const wrapped = (e: Event) => cb((e as CustomEvent).detail as ReminderChangedDetail)
  window.addEventListener(REMINDER_CHANGED_EVENT, wrapped)
  return () => window.removeEventListener(REMINDER_CHANGED_EVENT, wrapped)
}
