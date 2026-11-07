/**
 * Which of the attended-only tools a BOT's chat may hold (bots v3 Phase 5,
 * "tell it what to do next", docs/plans/bots-v3.md): granted per bot, by what
 * the bot fronts, never by a persona's categories or a teammate's bounds.
 *
 *   settle_card           Captures (system key `captures`, Triage's until
 *                         migration 318), and any bot that fronts a triage
 *                         loop (a loop whose skill makes a verdict, or the
 *                         seeded Triage loop): its runs make the cards, so
 *                         "accept it after all" is said to it.
 *   revise_email_draft    Mail (system key `mail`, Email drafts' until 318),
 *                         and a Correspondent (role `correspondent`), which
 *                         fronts the drafting pass in a workspace that has one
 *                         (emailPassTeammateId).
 *   undo_extraction_pass  Captures (Extraction's until 318).
 *
 * Every other bot gets none. The grant is ADDED after a chat's ceiling is
 * narrowed (composeTeammateChatCeiling), so a read-only or propose-only bot
 * (a work bot) still holds exactly its grant, and is still capped by the
 * workspace's edition. Attended chats only: a teammate chat, a loop run's
 * follow-up chat (skill-run-chat-ceiling.ts) and a work run's follow-up chat
 * (run-work-spec-rebuild.ts ceilingForWorkRunTurn, capped by the edition and
 * by a delegating chat's bound). An unattended run never
 * reaches this module.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { flowTeammateKey } from '@/lib/work/system-teammates'

/** What a bot's grants are decided from. */
export interface FollowThroughFacts {
  systemKey?: string | null
  role?: string | null
  /** The bot fronts at least one triage loop (seeded, or a verdict skill's). */
  frontsTriageLoop?: boolean
}

/** The attended-only tools a bot with these facts may hold. Pure. */
export function followThroughFor(facts: FollowThroughFacts): Set<string> {
  const out = new Set<string>()
  if (facts.systemKey === 'captures' || facts.frontsTriageLoop) out.add('settle_card')
  if (facts.systemKey === 'mail' || facts.role === 'correspondent') out.add('revise_email_draft')
  if (facts.systemKey === 'captures') out.add('undo_extraction_pass')
  return out
}

/** At most this many loops a bot fronts are read for the triage check. */
const FRONTED_LOOPS_READ = 25

/**
 * The grants of bot `teammateId` in `workspaceId`, read live: its system key
 * and role, and whether it fronts a triage loop. Fails CLOSED: any read that
 * fails, or a bot that isn't there, grants nothing. Service client (every
 * caller is an internal route or spec rebuild that already verified a token).
 */
export async function resolveFollowThrough(
  supabase: SupabaseClient,
  args: { workspaceId: string; teammateId: string | null | undefined },
): Promise<Set<string>> {
  if (!args.teammateId) return new Set()
  try {
    const { data: mate, error } = await supabase
      .from('ai_team_member')
      .select('system_key, role')
      .eq('id', args.teammateId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle<{ system_key: string | null; role: string | null }>()
    if (error || !mate) return new Set()
    const base = followThroughFor({ systemKey: mate.system_key, role: mate.role })
    if (base.has('settle_card')) return base
    return followThroughFor({
      systemKey: mate.system_key,
      role: mate.role,
      frontsTriageLoop: await frontsTriageLoop(supabase, args.workspaceId, args.teammateId),
    })
  } catch {
    return new Set()
  }
}

/** The seeded loop whose runs make triage cards. The Commitment reconciler ('seed:reconcile') is Captures' too, but makes none. */
const TRIAGE_SEED_KEY = 'seed:triage'

/**
 * Whether the bot fronts a loop whose runs make triage cards: the seeded
 * Triage loop, or a loop running a verdict-class skill. Not every loop
 * Captures fronts: since migration 318 the seeded reconciler maps to Captures
 * as well (systemKeyForFlow), and fronting it never earned settle_card.
 */
async function frontsTriageLoop(supabase: SupabaseClient, workspaceId: string, teammateId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('flow')
    .select('seed_key, actions')
    .eq('workspace_id', workspaceId)
    .eq('ai_team_member_id', teammateId)
    .limit(FRONTED_LOOPS_READ)
  if (error) return false
  for (const flow of (data ?? []) as Array<{ seed_key?: string | null; actions?: unknown }>) {
    if (flow.seed_key === TRIAGE_SEED_KEY) return true
    // The verdict check alone: a seed key other than Triage's never counts.
    const key = await flowTeammateKey(supabase, workspaceId, {
      seed_key: null,
      actions: Array.isArray(flow.actions) ? (flow.actions as Array<{ type: string }>) : null,
    })
    if (key === 'captures') return true
  }
  return false
}
