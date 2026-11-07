import type { SupabaseClient } from '@supabase/supabase-js'
import type { Clock } from './when'

/** What every fact builder (./builders/*) gets. */
export interface BriefContext {
  /** The user's own client: RLS runs as them. The default for every read. */
  supabase: SupabaseClient
  /** Service role, only for the shared gatherers that fence explicitly
   *  (lib/crm/person-context.ts, company-context.ts: workspace, visibility
   *  RPCs, capture visibility, the user's own mailbox), as the chat's
   *  get_contact_details runs them. */
  service: SupabaseClient
  workspaceId: string
  userId: string
  /** The user's member row here: "you" among participants and assignees. */
  memberId: string
  /** Their sign-in address: "you" among a meeting's guests. */
  userEmail: string | null
  clock: Clock
}

/** A PostgREST read, as the builders type their casts. */
export type Result<T> = { data: T[] | null; error: { message: string } | null }
export type OneResult<T> = { data: T | null; error: { message: string } | null }
export type CountResult = { count: number | null; error: { message: string } | null }

/** A section a builder could not read: logged, and the brief goes on without
 *  it (a missing section is better than no brief). */
export function rows<T>(name: string, result: Result<T>): T[] {
  if (result.error) {
    console.warn(`[listen-brief] ${name} failed:`, result.error.message)
    return []
  }
  return result.data ?? []
}

/** One row, the same way: null when it could not be read (or wasn't asked). */
export function row<T>(name: string, result: OneResult<T> | null): T | null {
  if (!result) return null
  if (result.error) {
    console.warn(`[listen-brief] ${name} failed:`, result.error.message)
    return null
  }
  return result.data
}

/** A head-only count, or null when it could not be read: the sheet then says
 *  nothing rather than a wrong number. */
export function counted(name: string, result: CountResult): number | null {
  if (result.error) {
    console.warn(`[listen-brief] ${name} failed:`, result.error.message)
    return null
  }
  return result.count ?? 0
}

/** The user's own addresses, lower-cased: their sign-in address, and their
 *  connected calendar and mail accounts. Whoever is on a meeting under one of
 *  them is the user, never named. */
export async function ownAddresses(ctx: Pick<BriefContext, 'supabase' | 'userId' | 'userEmail'>): Promise<string[]> {
  const result = await ctx.supabase.from('connected_account').select('account_email').eq('user_id', ctx.userId)
  const connected = rows('own addresses', result as Result<{ account_email: string | null }>).flatMap((r) =>
    r.account_email ? [r.account_email.toLowerCase()] : [],
  )
  return ctx.userEmail ? [ctx.userEmail.toLowerCase(), ...connected] : connected
}
