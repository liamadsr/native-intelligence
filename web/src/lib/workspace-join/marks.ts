/**
 * What a person's account remembers about workspaces it must not be offered
 * again through join-by-domain, in their auth app_metadata (only the service
 * role writes it):
 *
 *   ni_workspaces_left       they left, or an owner removed them, however
 *                            they had joined (invite, link, domain, or from
 *                            before any of this). Join-by-domain never offers
 *                            it again and refuses it. The invite link still
 *                            works for them; an admin resets the link for that.
 *   ni_join_offer_dismissed  they said "Not now" on the domain page.
 *
 * The leave and remove routes write the mark BEFORE the membership goes, so
 * a failed write leaves the person in, never out-but-offered.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export const LEFT_KEY = 'ni_workspaces_left'
export const DISMISSED_KEY = 'ni_join_offer_dismissed'
type MarkKey = typeof LEFT_KEY | typeof DISMISSED_KEY

/** The most ids a list keeps (the oldest fall off). */
const MAX_MARKS = 500

export interface MarkedUser {
  app_metadata?: Record<string, unknown> | null
}

export function marksOf(user: MarkedUser | null | undefined, key: MarkKey): string[] {
  const value = user?.app_metadata?.[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Add workspace ids to one of a person's marks. Reads their app_metadata
 * fresh (the service role's view), so two writers don't drop each other's
 * ids from a stale copy. Throws when the write fails: the caller decides
 * whether that stops what it was doing.
 */
export async function addMarks(
  service: SupabaseClient,
  userId: string,
  key: MarkKey,
  workspaceIds: string[],
): Promise<void> {
  if (workspaceIds.length === 0) return
  const { data, error: readError } = await service.auth.admin.getUserById(userId)
  if (readError || !data?.user) throw new Error(readError?.message ?? 'Could not read the account')
  const current = marksOf(data.user, key)
  const next = [...current.filter((id) => !workspaceIds.includes(id)), ...workspaceIds].slice(-MAX_MARKS)
  const { error } = await service.auth.admin.updateUserById(userId, { app_metadata: { [key]: next } })
  if (error) throw new Error(error.message)
}

/** They left this workspace, or were removed from it: never offer it by domain again. */
export function recordLeftWorkspace(service: SupabaseClient, userId: string, workspaceId: string): Promise<void> {
  return addMarks(service, userId, LEFT_KEY, [workspaceId])
}
