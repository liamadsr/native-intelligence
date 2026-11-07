/**
 * The read side's self-heal for a workspace's Assistant (docs/plans/bots-v4.md,
 * "Work with no teammate"). Work with no bot the caller can reach is the
 * Assistant's (bot-owner.ts), so a workspace with no Assistant shows that
 * work nowhere. Writers re-seed on a miss (system-teammates.ts
 * systemTeammateId) and migration 311 keeps a team delete from taking the
 * system teammates with it; this covers a reader that finds none before any
 * writer has run.
 *
 * Called by the light read (GET /api/account/agent-work `?light=1`) with the
 * roster it just read. No extra cost when every workspace's Assistant is in
 * it: nothing is read or called. For each workspace missing one, it calls
 * `seed_system_teammates` once (idempotent on (workspace_id, system_key);
 * service role only, so on the SERVICE client) and says which workspaces got
 * one, so the caller reads the roster again.
 *
 * At the roster's cap (ROSTER_LIMIT) a missing Assistant may only be past the
 * cap, so nothing is seeded. A workspace whose seed added nothing (no team, so
 * nothing to seed on) or failed is not tried again for HEAL_RETRY_MS on this
 * server instance, so a teamless workspace doesn't cost an RPC per read.
 * Fail-soft: a failed seed is logged and the answer goes out as it was.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ASSISTANT_SYSTEM_KEY, ROSTER_LIMIT, type OwnerTeammateFacts } from './bot-owner'

/** How long a workspace whose seed added nothing waits before the next try, per server instance. */
export const HEAL_RETRY_MS = 10 * 60_000
/** At most this many workspaces seeded per read (the rest wait for the next one). */
export const HEAL_MAX_PER_READ = 5

const lastMiss = new Map<string, number>()

/** Tests only: forget every workspace's last miss. */
export function resetAssistantHealForTests(): void {
  lastMiss.clear()
}

/** The workspaces in `workspaceIds` with no Assistant in `roster` (none at the roster's cap: it can't say). */
export function workspacesMissingAssistant(workspaceIds: readonly string[], roster: readonly OwnerTeammateFacts[]): string[] {
  if (roster.length >= ROSTER_LIMIT) return []
  const held = new Set(roster.filter((t) => t?.system_key === ASSISTANT_SYSTEM_KEY).map((t) => t.workspace_id))
  return [...new Set(workspaceIds)].filter((w) => !held.has(w))
}

/**
 * Seeds the system teammates of each workspace with no Assistant in `roster`.
 * `service` is called only when one is missing (a getter, so the light read
 * builds no client otherwise). Returns the workspaces the seed added rows to.
 */
export async function healMissingAssistants(args: {
  service: () => SupabaseClient
  workspaceIds: readonly string[]
  roster: readonly OwnerTeammateFacts[]
  now?: number
}): Promise<string[]> {
  const now = args.now ?? Date.now()
  const missing = workspacesMissingAssistant(args.workspaceIds, args.roster)
    .filter((w) => {
      const at = lastMiss.get(w)
      return at === undefined || now - at >= HEAL_RETRY_MS
    })
    .slice(0, HEAL_MAX_PER_READ)
  if (missing.length === 0) return []

  let service: SupabaseClient
  try {
    service = args.service()
  } catch (err) {
    console.warn('[assistant-heal] no service client:', err instanceof Error ? err.message : err)
    return []
  }
  const healed: string[] = []
  await Promise.all(
    missing.map(async (workspaceId) => {
      try {
        const { data, error } = await service.rpc('seed_system_teammates', { p_workspace_id: workspaceId })
        if (error) throw new Error(error.message)
        if (typeof data === 'number' && data > 0) {
          lastMiss.delete(workspaceId)
          healed.push(workspaceId)
          console.info(`[assistant-heal] re-seeded ${data} system teammate(s) in ${workspaceId}`)
        } else {
          lastMiss.set(workspaceId, now)
        }
      } catch (err) {
        lastMiss.set(workspaceId, now)
        console.warn(`[assistant-heal] seed failed (${workspaceId}):`, err instanceof Error ? err.message : err)
      }
    }),
  )
  return healed
}
