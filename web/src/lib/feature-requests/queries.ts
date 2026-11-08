/**
 * Shared helpers for the feature-request board.
 *
 * The board is GLOBAL (cross-workspace): feature_requests / votes / comments
 * are keyed on auth.users, not on a workspace. Any authenticated Native Intelligence user
 * sees the same board. So routes here use requireUser() rather than
 * requireWorkspace().
 *
 * Author display names are resolved SERVER-SIDE with a service client because:
 *   - user_profiles RLS restricts SELECT to the owner's own row, so a normal
 *     authed client can't read other posters' names.
 *   - We deliberately do NOT expose raw emails on the public board.
 * The service client reads user_profiles.preferred_name and falls back to a
 * privacy-masked email local-part, then to "Anonymous".
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/supabase/service'

export const FEATURE_REQUEST_STATUSES = [
  'open',
  'planned',
  'in_progress',
  'completed',
  'declined',
] as const

export type FeatureRequestStatus = (typeof FEATURE_REQUEST_STATUSES)[number]

/**
 * The board hosts three kinds of post (migration 137). They share the same
 * table, votes, comments, and status triage — `type` is the only difference.
 */
export const FEEDBACK_TYPES = ['feedback', 'feature_request', 'bug'] as const

export type FeedbackType = (typeof FEEDBACK_TYPES)[number]

/**
 * Post visibility (migration 138). `public` is on the shared board for everyone;
 * `private` is visible only to the author (and admins, via the service client).
 */
export const FEEDBACK_VISIBILITIES = ['public', 'private'] as const

export type FeedbackVisibility = (typeof FEEDBACK_VISIBILITIES)[number]

export interface FeatureRequestRow {
  id: string
  user_id: string
  title: string
  description: string | null
  type: FeedbackType
  visibility: FeedbackVisibility
  status: FeatureRequestStatus
  vote_count: number
  comment_count: number
  created_at: string
  updated_at: string
}

export interface FeatureRequestComment {
  id: string
  feature_request_id: string
  user_id: string
  body: string
  created_at: string
}

/** Public shape sent to the client — author identity, never raw email. */
export interface PublicAuthor {
  user_id: string
  name: string
  is_self: boolean
}

/**
 * Resolve display names for a set of user ids using the service client.
 * Returns a map of user_id -> friendly name. Preference order:
 *   user_profiles.preferred_name > masked email local-part > "Anonymous".
 *
 * Masking: "jane.doe@x.com" -> "jane.doe" (local-part only). We drop the
 * domain so the board doesn't leak full addresses while still giving posts a
 * recognizable handle.
 */
export async function resolveAuthorNames(
  userIds: string[],
): Promise<Record<string, string>> {
  const ids = [...new Set(userIds)].filter(Boolean)
  const names: Record<string, string> = {}
  if (ids.length === 0) return names

  const service = getServiceClient()

  // Prefer the user-set preferred_name.
  const { data: profiles } = await service
    .from('user_profiles')
    .select('user_id, preferred_name')
    .in('user_id', ids)

  for (const p of profiles ?? []) {
    if (p.user_id && p.preferred_name?.trim()) {
      names[p.user_id] = p.preferred_name.trim()
    }
  }

  // Fall back to a masked email local-part for anyone still unnamed.
  const missing = ids.filter((id) => !names[id])
  await Promise.all(
    missing.map(async (id) => {
      const { data } = await service.auth.admin.getUserById(id)
      const email = data?.user?.email
      names[id] = email ? email.split('@')[0] : 'Anonymous'
    }),
  )

  return names
}

/**
 * Fetch the set of feature_request ids the given user has voted on.
 * Used to render the "voted" state of the upvote button.
 */
export async function getUserVotedIds(
  supabase: SupabaseClient,
  userId: string,
  featureRequestIds: string[],
): Promise<Set<string>> {
  if (featureRequestIds.length === 0) return new Set()
  const { data } = await supabase
    .from('feature_request_votes')
    .select('feature_request_id')
    .eq('user_id', userId)
    .in('feature_request_id', featureRequestIds)
  return new Set((data ?? []).map((v) => v.feature_request_id as string))
}
