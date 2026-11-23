/**
 * The label (tag) row as the label routes return it: today's fields, plus
 * `personal` (migration 700's owner_user_id is set). Server and client safe.
 */
import { TAG_KINDS, type TagKind } from './kinds'

export const LABEL_FIELDS = 'id, name, color, group_name, scopes, created_at, owner_user_id'

export interface LabelRow {
  id: string
  name: string
  color: string
  group_name: string | null
  scopes: string[] | null
  created_at: string
  owner_user_id?: string | null
}

export function toLabelResponse<T extends LabelRow>(row: T): Omit<T, 'owner_user_id'> & { personal: boolean } {
  const { owner_user_id, ...rest } = row
  return { ...rest, personal: Boolean(owner_user_id) }
}

/** The scopes a tag may name: the kinds that take tags. Anything else is dropped; none is null (every kind). */
export function cleanScopes(value: unknown): TagKind[] | null {
  if (!Array.isArray(value)) return null
  const kinds = value.filter((s): s is TagKind => typeof s === 'string' && (TAG_KINDS as string[]).includes(s))
  return kinds.length > 0 ? [...new Set(kinds)] : null
}

export function isScope(value: unknown): value is TagKind {
  return typeof value === 'string' && (TAG_KINDS as string[]).includes(value)
}

/** Postgres refusals from 700's guard and policies, as a person reads them. */
export function labelWriteError(code: string | undefined): { status: number; message: string } | null {
  if (code === '23505') return { status: 409, message: 'A tag with that name already exists' }
  if (code === '22023' || code === '23514') return { status: 400, message: 'A tag name is 1 to 64 characters and does not start with #' }
  if (code === '42501') return { status: 403, message: 'You cannot change this tag' }
  return null
}
