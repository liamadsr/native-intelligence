/**
 * A project's priority (migration 691): the actions' own five values
 * (action_priority, 022), stored as text. "None" is stored as 'none', never
 * null: production's projects.priority predates 691 and is NOT NULL with
 * default 'none', so a null write is refused there, while a database built
 * from the migrations alone has a nullable column that also accepts 'none'.
 * A null read still means none. Client-safe and pure: the routes, the
 * composer and the project card read it here.
 */
import type { PriorityValue } from '@/lib/views/property-options'

export const PROJECT_PRIORITIES: readonly PriorityValue[] = ['none', 'low', 'medium', 'high', 'urgent']

export function isProjectPriority(v: unknown): v is PriorityValue {
  return typeof v === 'string' && (PROJECT_PRIORITIES as readonly string[]).includes(v)
}

/**
 * What a request's `priority` sets: `undefined` when it didn't send one,
 * `'none'` to clear it (null or '' from a client), a value, or `'invalid'`
 * for anything else (a 400).
 */
export function parseProjectPriority(v: unknown): PriorityValue | undefined | 'invalid' {
  if (v === undefined) return undefined
  if (v === null || v === '') return 'none'
  return isProjectPriority(v) ? v : 'invalid'
}
