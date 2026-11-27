/**
 * Whether a held outward call runs on its own (docs/plans/earned-autonomy.md
 * §5, phase 3), asked at TWO moments: by the outward gate when it holds the
 * call (holdOutward in safety/action-review.ts), and again by the runner just
 * before the call runs at the end of its undo window (run-action.ts). The
 * same checks both times, so anything that changed in the window (a revoke,
 * an undo of another one, the kill switch, a recipient no longer known, the
 * daily caps) sends it back to the person's card.
 *
 * Liam, 11-27, decision 1: "The person's yes to 'handle this kind yourself'
 * counts as their final yes for outward kinds, with the 5-minute undo window
 * before each send. Revoke stays available at any time." This amends Liam,
 * 10-26: "nothing reaches another person without the person's final yes"
 * (outward-gate.ts, chat/home-turn.ts ACT_ON_YOUR_OWN_GUIDANCE): the per-kind
 * yes IS that final yes, and the card stays up through the window as the
 * last chance to say no.
 *
 * It never widens WHO may raise a call: only a hold the trust authority
 * already answers `ask` (caller.ts decideAction: the person in the app or
 * remote, a flow step, a home turn) can run on its own. An unattended caller
 * it denies stays denied; a guest's call and a Mac job's call always ask.
 *
 * Every check fails closed: a read that fails is a "no", and the call waits
 * for the person exactly as it did before this existed.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isAgentPaused } from '@/lib/work/agent-paused'
import { earnedAutonomyGraduating, earnedAutonomyQuiet } from './config'
import { callHitsHardLimit, hardLimitOfKind } from './hard-limits'
import { kindOfCall, type AutonomyKind } from './kind'
import { knownRecipients } from './known'
import {
  evaluateKind,
  MAX_AUTONOMOUS_PER_KIND_PER_DAY,
  MAX_AUTONOMOUS_PER_PERSON_PER_DAY,
  OUTCOMES_READ,
  type AutonomyLevel,
  type AutonomyOutcomeKind,
  type OutcomeEvent,
} from './rules'

/** The undo window before a graduated call runs (Liam, 11-27, decision 4: "a 5-minute undo window"). */
export const UNDO_WINDOW_MINUTES = 5

export type GraduationRefusal =
  | 'off'
  | 'caller'
  | 'guest'
  | 'mac_job'
  | 'hard_limit'
  | 'paused'
  | 'not_granted'
  | 'demoted'
  | 'kind_cap'
  | 'person_cap'
  | 'new_recipient'
  | 'read_failed'

export type Graduation =
  | { run: true; level: Exclude<AutonomyLevel, 'ask'>; kind: AutonomyKind; runAt: string }
  | { run: false; reason: GraduationRefusal; kind?: AutonomyKind }

export interface GraduationArgs {
  workspaceId: string
  userId: string
  tool: string
  input: unknown
  context?: unknown
  /** The verified caller class (caller.ts), and what the trust authority said for this hold. */
  caller: string
  decision: 'run' | 'ask' | 'deny'
  /** A Mac job's call (C1): always the person's card. */
  localAgent?: unknown
  /**
   * The runner's own re-check: this action's row is already counted in the
   * day's caps, so they are compared with `>` its own count instead of `>=`.
   */
  recheckActionId?: string
  now?: Date
}

export interface GraduationDeps {
  env?: Record<string, string | undefined>
  paused?: (db: SupabaseClient, workspaceId: string) => Promise<boolean>
  known?: typeof knownRecipients
}

const DAY = 86_400_000

export async function graduationFor(db: SupabaseClient, args: GraduationArgs, deps: GraduationDeps = {}): Promise<Graduation> {
  const env = deps.env ?? process.env
  if (!earnedAutonomyGraduating(env)) return { run: false, reason: 'off' }
  // Only a hold that would be the person's card: never one the authority denies.
  if (args.decision !== 'ask') return { run: false, reason: 'caller' }
  if (!['person', 'person_remote', 'agent_unattended'].includes(args.caller)) return { run: false, reason: 'caller' }
  if (args.localAgent) return { run: false, reason: 'mac_job' }
  const context = args.context && typeof args.context === 'object' ? (args.context as Record<string, unknown>) : {}
  if (context.guest) return { run: false, reason: 'guest' }

  const kind = kindOfCall({ tool: args.tool, input: args.input, context })
  // A connected app's tool: the door has no destructive hint here, so it fails closed.
  if (hardLimitOfKind(kind)) return { run: false, reason: 'hard_limit', kind }

  const now = args.now ?? new Date()
  try {
    if (await (deps.paused ?? isAgentPaused)(db, args.workspaceId)) return { run: false, reason: 'paused', kind }

    const decisions = await db
      .from('autonomy_kind')
      .select('level, pinned_ask, granted_at, demoted_at, offer_declined_at')
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .eq('kind_key', kind.key)
      .maybeSingle()
    if (decisions.error) return { run: false, reason: 'read_failed', kind }
    const d = decisions.data as { level?: AutonomyLevel; pinned_ask?: boolean; granted_at?: string | null; demoted_at?: string | null; offer_declined_at?: string | null } | null
    if (!d || (d.level !== 'tell' && d.level !== 'quiet') || d.pinned_ask) return { run: false, reason: 'not_granted', kind }

    const outcomes = await db
      .from('autonomy_outcome')
      .select('outcome, edit_ratio, created_at')
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .eq('kind_key', kind.key)
      .order('created_at', { ascending: false })
      .limit(OUTCOMES_READ)
    if (outcomes.error) return { run: false, reason: 'read_failed', kind }
    const events: OutcomeEvent[] = ((outcomes.data ?? []) as Array<{ outcome: AutonomyOutcomeKind; edit_ratio: number | string | null; created_at: string }>).map((o) => ({
      outcome: o.outcome,
      at: o.created_at,
      editRatio: o.edit_ratio === null ? null : Number(o.edit_ratio),
    }))
    const quiet = earnedAutonomyQuiet(env)
    const ev = evaluateKind(events, { level: d.level, pinnedAsk: d.pinned_ask, grantedAt: d.granted_at, demotedAt: d.demoted_at, offerDeclinedAt: d.offer_declined_at }, now, false, { quiet })
    if (ev.level === 'ask') return { run: false, reason: 'demoted', kind }

    // The day's caps (decision 4: 20 per kind, 50 per person), counting every
    // action not sent back to a card.
    const since = new Date(now.getTime() - DAY).toISOString()
    const today = await db
      .from('autonomy_action')
      .select('id, kind_key, status')
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .gte('created_at', since)
      .limit(MAX_AUTONOMOUS_PER_PERSON_PER_DAY + 10)
    if (today.error) return { run: false, reason: 'read_failed', kind }
    const counted = ((today.data ?? []) as Array<{ id: string; kind_key: string; status: string }>).filter((a) => a.status !== 'cancelled' && a.id !== args.recheckActionId)
    if (counted.filter((a) => a.kind_key === kind.key).length >= MAX_AUTONOMOUS_PER_KIND_PER_DAY) return { run: false, reason: 'kind_cap', kind }
    if (counted.length >= MAX_AUTONOMOUS_PER_PERSON_PER_DAY) return { run: false, reason: 'person_cap', kind }

    // Never to someone new (decision 3), on every call.
    const known = await (deps.known ?? knownRecipients)(db, { workspaceId: args.workspaceId, userId: args.userId, recipients: kind.recipients })
    if (callHitsHardLimit(kind, known)) return { run: false, reason: 'new_recipient', kind }

    return { run: true, level: ev.level === 'quiet' && quiet ? 'quiet' : 'tell', kind, runAt: new Date(now.getTime() + UNDO_WINDOW_MINUTES * 60_000).toISOString() }
  } catch {
    return { run: false, reason: 'read_failed', kind }
  }
}
