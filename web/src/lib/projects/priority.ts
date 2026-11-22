/**
 * A project's priority (migration 691): the actions' own five values
 * (action_priority, 022), stored as text, or null for none set. Client-safe
 * and pure: the routes, the composer and the project card read it here.
 */
import type { PriorityValue } from '@/lib/views/property-options'

export const PROJECT_PRIORITIES: readonly PriorityValue[] = ['none', 'low', 'medium', 'high', 'urgent']

export function isProjectPriority(v: unknown): v is PriorityValue {
  return typeof v === 'string' && (PROJECT_PRIORITIES as readonly string[]).includes(v)
}

/**
 * What a request's `priority` sets: `undefined` when it didn't send one,
 * `null` to clear it, a value, or `'invalid'` for anything else (a 400).
 */
export function parseProjectPriority(v: unknown): PriorityValue | null | undefined | 'invalid' {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  return isProjectPriority(v) ? v : 'invalid'
}
