/**
 * Workspace members' sign-in email addresses.
 *
 * There is NO `member.email` column: `member` (migration 013) holds `user_id`,
 * `role` and `display_name`, and the address lives on `auth.users`. Naming it
 * in a PostgREST query (a select, an `.eq('email', …)` filter, an embed such
 * as `member(email)`) doesn't come back empty: PostgREST rejects the WHOLE
 * query with "column member.email does not exist". `auth.users` can't be
 * embedded either (`user:user_id(email)`), since the auth schema isn't exposed.
 * Callers that ignored the error silently lost every member match: the
 * calendar → CRM sweep refused every run, meeting prep never found a teammate,
 * and attendees were never linked to the teammates they were.
 *
 * So member emails are resolved here: `member.user_id`, then one GoTrue admin
 * `getUserById` per member on the service client, a few at a time, the way
 * `src/app/api/account/workspace/route.ts` does it. Deliberately NOT a
 * `listUsers` page, which walks the whole product's user base to find a
 * handful of members.
 *
 * A workspace's list is kept for a minute per instance: calendar sync and
 * participant seeding look a member up per attendee, and would otherwise pay
 * one admin round trip per member for every one of them. A teammate who has
 * just joined is matched at most a minute late.
 *
 * Nothing here throws. A failed read or lookup leaves that member out, and a
 * list missing anyone that way is not kept.
 */
import { getServiceClient } from '@/lib/admin'

export interface MemberEmail {
  /** `member.id`. */
  id: string
  userId: string
  displayName: string | null
  /** Their sign-in address (`auth.users.email`), lower-cased. */
  email: string
}

/** How long a workspace's list is reused. */
const CACHE_MS = 60_000

/** Admin lookups in flight at once. The workspace route's ceiling, for the
 *  same reason: one unbounded burst per member trips GoTrue's throttling. */
const LOOKUP_CONCURRENCY = 10

/** Workspaces whose lists are kept at once. */
const CACHE_MAX = 200

const cache = new Map<string, { expires: number; members: Promise<MemberEmail[]> }>()

/** Test seam: forget every kept list. */
export function _resetMemberEmailCacheForTests(): void {
  cache.clear()
}

/** Every member of the workspace whose sign-in email could be resolved. */
export async function listMemberEmails(workspaceId: string): Promise<MemberEmail[]> {
  if (!workspaceId) return []
  const now = Date.now()
  const kept = cache.get(workspaceId)
  if (kept && kept.expires > now) return kept.members

  const members: Promise<MemberEmail[]> = readMemberEmails(workspaceId).then((result) => {
    // An incomplete list is used once, not kept.
    if (!result.complete && cache.get(workspaceId)?.members === members) cache.delete(workspaceId)
    return result.members
  })
  if (cache.size >= CACHE_MAX) {
    for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id)
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  }
  cache.set(workspaceId, { expires: now + CACHE_MS, members })
  return members
}

/** The members whose sign-in email is one of `emails`, keyed by that email
 *  lower-cased. */
export async function findMembersByEmail(
  workspaceId: string,
  emails: Iterable<string | null | undefined>,
): Promise<Map<string, MemberEmail>> {
  const wanted = new Set<string>()
  for (const email of emails) {
    const key = email?.trim().toLowerCase()
    if (key) wanted.add(key)
  }
  const found = new Map<string, MemberEmail>()
  if (!wanted.size) return found
  for (const member of await listMemberEmails(workspaceId)) {
    if (wanted.has(member.email) && !found.has(member.email)) found.set(member.email, member)
  }
  return found
}

/** The member whose sign-in email this is, or null. */
export async function findMemberByEmail(
  workspaceId: string,
  email: string | null | undefined,
): Promise<MemberEmail | null> {
  const key = email?.trim().toLowerCase()
  if (!key) return null
  return (await findMembersByEmail(workspaceId, [key])).get(key) ?? null
}

async function readMemberEmails(
  workspaceId: string,
): Promise<{ members: MemberEmail[]; complete: boolean }> {
  try {
    const service = getServiceClient()
    const { data, error } = await service
      .from('member')
      .select('id, user_id, display_name')
      .eq('workspace_id', workspaceId)
    if (error) {
      console.warn('[member-emails] member read failed:', error.message)
      return { members: [], complete: false }
    }

    const rows = ((data ?? []) as Array<{ id?: string | null; user_id?: string | null; display_name?: string | null }>)
      .filter((row): row is { id: string; user_id: string; display_name?: string | null } => !!row?.id && !!row.user_id)
    const members: MemberEmail[] = []
    let complete = true
    for (let i = 0; i < rows.length; i += LOOKUP_CONCURRENCY) {
      const chunk = rows.slice(i, i + LOOKUP_CONCURRENCY)
      const emails = await Promise.all(
        chunk.map(async (row) => {
          try {
            const { data: got, error: lookupError } = await service.auth.admin.getUserById(row.user_id)
            if (lookupError) {
              complete = false
              return null
            }
            return got?.user?.email?.trim().toLowerCase() || null
          } catch {
            complete = false
            return null
          }
        }),
      )
      chunk.forEach((row, j) => {
        const email = emails[j]
        if (email) members.push({ id: row.id, userId: row.user_id, displayName: row.display_name ?? null, email })
      })
    }
    return { members, complete }
  } catch (err) {
    console.warn('[member-emails] lookup failed:', err)
    return { members: [], complete: false }
  }
}
