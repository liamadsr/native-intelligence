/**
 * Reminder types — shared by the picker UI, the API route, and the cron pass.
 *
 * A reminder is PER-USER and PRIVATE (RLS is owner-only, see migration 224).
 * At most one PENDING reminder exists per (user, entity); setting one again
 * replaces it. `remind_at` is an absolute UTC instant — presets resolve to a
 * concrete instant on the client at pick time, so there is no wall-clock +
 * timezone pair to reconcile later.
 */

/** Entity kinds a reminder can hang off. Mirrors the `entity_type` CHECK. */
export const REMINDER_ENTITY_TYPES = [
  'action',
  'project',
  'initiative',
  'capture',
  'document',
] as const

export type ReminderEntityType = (typeof REMINDER_ENTITY_TYPES)[number]

/**
 * A reminder row as the client sees it. There is deliberately NO `member_id`:
 * the recipient is derived server-side from (user_id, workspace_id) at fire
 * time, so a denormalised — and therefore client-writable — member column
 * could only ever be a way to address someone else's inbox.
 */
export interface Reminder {
  id: string
  workspace_id: string
  user_id: string
  entity_type: ReminderEntityType
  entity_id: string
  /** ISO timestamptz — the instant the cron sweep should fire on. */
  remind_at: string
  /** Set by the cron pass when it claims the row; null = still pending. */
  delivered_at: string | null
  created_at: string
  updated_at: string
}
