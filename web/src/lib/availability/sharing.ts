/**
 * Whether a person's teammates may learn when they are busy
 * (member.availability_sharing, migration 552): one setting per workspace,
 * on their own member row.
 *
 *   busy_only  (the default) the other members of that workspace may learn
 *              when the person is busy: blocks only, never what an event is,
 *              where it is, who is in it or which calendar it is on. In
 *              practice they see only the times that work for everyone
 *              (./team.ts).
 *   none       their time is not shared: a request that includes them comes
 *              back unknown for them, "they don't share their availability".
 *
 * Nothing to set up: busy_only is what a member has until they change it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export const AVAILABILITY_SHARING = ['busy_only', 'none'] as const
export type AvailabilitySharing = (typeof AVAILABILITY_SHARING)[number]

export function isAvailabilitySharing(value: unknown): value is AvailabilitySharing {
  return typeof value === 'string' && (AVAILABILITY_SHARING as readonly string[]).includes(value)
}

/**
 * A stored value as the app reads it. Anything unreadable is `none`: a
 * person's time is shared only on a value that says so.
 */
export function readSharingValue(value: unknown): AvailabilitySharing {
  return value === 'busy_only' ? 'busy_only' : 'none'
}

interface Person {
  userId: string
  workspaceId: string
}

/** The person's sharing in the workspace. Throws on a failed read, or when they are not a member there. */
export async function readSharing(supabase: SupabaseClient, person: Person): Promise<AvailabilitySharing> {
  const { data, error } = await supabase.from('member').select('availability_sharing').eq('workspace_id', person.workspaceId).eq('user_id', person.userId).maybeSingle()
  if (error) throw new Error(`Availability sharing could not be read: ${error.message}`)
  if (!data) throw new Error('Not a member of this workspace')
  return readSharingValue((data as { availability_sharing?: unknown }).availability_sharing)
}

/** Save the person's sharing in the workspace, on their own member row only. Throws on a bad value or a failed write. */
export async function saveSharing(supabase: SupabaseClient, person: Person, sharing: AvailabilitySharing): Promise<AvailabilitySharing> {
  if (!isAvailabilitySharing(sharing)) throw new Error(`Availability sharing is 'busy_only' or 'none', not "${String(sharing)}".`)
  const { data, error } = await supabase
    .from('member')
    .update({ availability_sharing: sharing })
    .eq('workspace_id', person.workspaceId)
    .eq('user_id', person.userId)
    .select('availability_sharing')
  if (error) throw new Error(`Availability sharing could not be saved: ${error.message}`)
  if (!(data as unknown[] | null)?.length) throw new Error('Not a member of this workspace')
  return sharing
}
