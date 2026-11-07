/**
 * The names a public post must never carry, from the person's own recent
 * calls (P9; content-skill-set.md §4 "Public-safe", decision 2): the people
 * on those calls who aren't workspace members and the CRM contacts and
 * companies linked to them, folded the way the public-safe screen matches
 * them (public-safe.ts blockedPhrases). Private calls count most of all: a
 * customer met on a private call is exactly who a post must never name, and
 * the post's own sources won't cite that call.
 *
 * lint_post (post-sources.ts) and the weekly post pass (post-week.ts) both
 * add these to the names a draft is screened for, so a post that names a
 * customer is caught even when it cites only shipped work.
 *
 * Bounded and batched: the person's calls of the last RECENT_DAYS (the ones
 * they recorded and the ones they were on), at most MAX_CALLS, read in five
 * queries whatever the count. A failed read returns what it has (never
 * throws); the post's own sources are still screened as before.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { blockedPhrases } from './public-safe'

/** How far back the person's calls are read. */
export const RECENT_DAYS = 30
/** The most calls read. */
export const MAX_CALLS = 20

const DAY_MS = 24 * 60 * 60 * 1000

/** A short cache: lint_post runs on every version of a post. */
const CACHE_MS = 60_000
const cache = new Map<string, { at: number; names: string[] }>()

/** Forget the cached names (tests). */
export function forgetRecentCallNames(): void {
  cache.clear()
}

/** The outside names of the person's recent calls, folded. Never throws. */
export async function recentCallNames(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; now?: Date },
): Promise<string[]> {
  const key = `${args.workspaceId}:${args.userId}`
  const hit = cache.get(key)
  const nowMs = (args.now ?? new Date()).getTime()
  if (hit && nowMs - hit.at < CACHE_MS) return hit.names
  const names = await readRecentCallNames(supabase, args.workspaceId, args.userId, nowMs)
  cache.set(key, { at: nowMs, names })
  return names
}

async function readRecentCallNames(supabase: SupabaseClient, workspaceId: string, userId: string, nowMs: number): Promise<string[]> {
  const since = new Date(nowMs - RECENT_DAYS * DAY_MS).toISOString()
  const people: Array<{ full: string | null; last: string | null }> = []
  const companies: Array<string | null> = []
  let ownNames: string[] = []
  try {
    const { data: member } = await supabase.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle()
    const memberId = (member as { id?: unknown } | null)?.id
    const [recorded, attended] = await Promise.all([
      supabase.from('captures').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).neq('is_eval', true).gte('created_at', since).order('created_at', { ascending: false }).limit(MAX_CALLS),
      typeof memberId === 'string'
        ? // Bounded by the call's date in the query (P9 review S10): an unordered
          // first page of a long history could miss this month's calls.
          supabase.from('capture_participant').select('capture_id, captures!inner(created_at)').eq('member_id', memberId).gte('captures.created_at', since).limit(200)
        : Promise.resolve({ data: [] as Array<{ capture_id: string }> }),
    ])
    const ids = [
      ...new Set([
        ...((recorded.data ?? []) as Array<{ id: string }>).map((r) => r.id),
        ...((attended.data ?? []) as Array<{ capture_id: string }>).map((r) => r.capture_id),
      ]),
    ].slice(0, 200)
    if (ids.length === 0) return []
    // Only recent calls in this workspace (an attended row is checked through its capture).
    const { data: own } = await supabase
      .from('captures')
      .select('id')
      .eq('workspace_id', workspaceId)
      .neq('is_eval', true)
      .gte('created_at', since)
      .in('id', ids)
      .order('created_at', { ascending: false })
      .limit(MAX_CALLS)
    const captureIds = ((own ?? []) as Array<{ id: string }>).map((r) => r.id)
    if (captureIds.length === 0) return []

    const [parts, from, to] = await Promise.all([
      supabase.from('capture_participant').select('member_id, external_name, contact_id, company, is_self').in('capture_id', captureIds).limit(400),
      supabase.from('entity_link').select('target_type, target_id').eq('workspace_id', workspaceId).eq('source_type', 'capture').in('source_id', captureIds).limit(200),
      supabase.from('entity_link').select('source_type, source_id').eq('workspace_id', workspaceId).eq('target_type', 'capture').in('target_id', captureIds).limit(200),
    ])
    const contactIds = new Set<string>()
    const companyIds = new Set<string>()
    for (const p of (parts.data ?? []) as Array<{ member_id: string | null; external_name: string | null; contact_id: string | null; company: string | null; is_self: boolean | null }>) {
      if (p.member_id || p.is_self) continue
      people.push({ full: p.external_name, last: null })
      companies.push(p.company)
      if (p.contact_id) contactIds.add(p.contact_id)
    }
    for (const l of (from.data ?? []) as Array<{ target_type: string; target_id: string }>) {
      if (l.target_type === 'contact') contactIds.add(l.target_id)
      if (l.target_type === 'company') companyIds.add(l.target_id)
    }
    for (const l of (to.data ?? []) as Array<{ source_type: string; source_id: string }>) {
      if (l.source_type === 'contact') contactIds.add(l.source_id)
      if (l.source_type === 'company') companyIds.add(l.source_id)
    }
    if (contactIds.size) {
      const { data: contacts } = await supabase.from('contact').select('full_name, last_name, company_id').eq('workspace_id', workspaceId).in('id', [...contactIds].slice(0, 100))
      for (const c of (contacts ?? []) as Array<{ full_name: string | null; last_name: string | null; company_id: string | null }>) {
        people.push({ full: c.full_name, last: c.last_name })
        if (c.company_id) companyIds.add(c.company_id)
      }
    }
    if (companyIds.size) {
      const { data: rows } = await supabase.from('company').select('name, is_workspace_company').eq('workspace_id', workspaceId).in('id', [...companyIds].slice(0, 100))
      for (const c of (rows ?? []) as Array<{ name: string | null; is_workspace_company?: boolean | null }>) if (c.is_workspace_company !== true) companies.push(c.name)
    }
    // The workspace's own company is never a name to keep out of its own posts.
    const { data: ownCompany } = await supabase.from('company').select('name').eq('workspace_id', workspaceId).eq('is_workspace_company', true).limit(1)
    ownNames = blockedPhrases({ companies: ((ownCompany ?? []) as Array<{ name: string | null }>).map((c) => c.name) })
  } catch {
    /* what was read so far */
  }
  const own = new Set(ownNames)
  return blockedPhrases({ people, companies }).filter((p) => !own.has(p))
}
