/**
 * The Strong tier's cost guard (Liam, 2026-10-15): at most STRONG_DAILY_CAP
 * Strong escalations per person per UTC day, counted from ai_usage_logs.
 *
 * Each escalation granted writes one zero-cost row (feature
 * 'model.escalation', billing skipped, an idempotency key per escalation so a
 * replay of the same start counts once), and the count is those rows since
 * UTC midnight (idx_ai_usage_logs_user_created, migration 158). Counting the
 * escalations, not the Strong model's usage rows, keeps one long helper run at
 * one, however many turns it bills.
 *
 * Above the cap the task falls to Think (`by: 'cap'`). Trial and unpaid users
 * get no Strong at all (the plan clamp: clampModelToPlan's PREMIUM_MODELS).
 * `AUTO_MODEL_ESCALATION=off` turns every escalation into Think: a cost kill
 * switch, not a runtime flag. The dollar allowance still applies on top.
 *
 * One request's tasks are granted off one count, at most `cap - used` of them
 * (grantStrongBatch). Two separate requests racing at nine may both pass: the
 * cap is a cost bound, and a transaction to make it exact would cost more
 * than the eleventh helper. A count that can't be read fails closed (Think).
 *
 * The markers are real ai_usage_logs rows: the admin AI-usage views leave
 * them out, and check_ai_usage_limit counts at most ten a day of them as
 * zero-cost requests (left alone on purpose).
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logUsage, type LogUsageParams } from './auth'
import { STRONG_MODEL, usageProviderLabel } from './models'
import { ESCALATION_FEATURE, STRONG_DAILY_CAP, autoEscalationEnabled, modelRouteMetadata, tierReasoning, type ModelRoute, type ModelTier } from './model-route'

export { ESCALATION_FEATURE, STRONG_DAILY_CAP, autoEscalationEnabled }

/** UTC midnight of `now`'s day, ISO. */
export function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
}

/** The person's Strong escalations since UTC midnight, or null when the count can't be read. */
export async function strongEscalationsToday(supabase: SupabaseClient, userId: string, now: Date = new Date()): Promise<number | null> {
  try {
    const { count, error } = await supabase
      .from('ai_usage_logs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('feature', ESCALATION_FEATURE)
      .gte('created_at', utcDayStart(now))
    if (error || typeof count !== 'number') return null
    return count
  } catch {
    return null
  }
}

export interface StrongGrantArgs {
  userId: string
  workspaceId: string
  /** From check_ai_usage_limit (checkUsageLimits): unpaid and trial plans get no Strong. */
  isPaidPlan: boolean
  /** Names this escalation once: a replay of the same start (same key) never counts twice. */
  key: string
  /** Where it was asked for, for the log ('quick_helper', 'background_helper', 'skill_run'). */
  surface: string
  /** The rule names that asked for Strong. */
  signals: string[]
  /** The tier when Strong is refused (Think, unless the caller says otherwise). */
  fallbackTier?: ModelTier
  now?: Date
}

/** One escalation asked for in a batch: its key and the rules that asked. */
export interface StrongRequest {
  key: string
  signals: string[]
}

export type StrongBatchArgs = Omit<StrongGrantArgs, 'key' | 'signals'> & { requests: StrongRequest[] }

export interface StrongGrantDeps {
  count?: typeof strongEscalationsToday
  log?: (userId: string, params: LogUsageParams) => Promise<unknown>
  env?: Record<string, string | undefined>
}

/** Grant Strong, or say why not; one request (see grantStrongBatch). Never throws. */
export async function grantStrong(supabase: SupabaseClient, args: StrongGrantArgs, deps: StrongGrantDeps = {}): Promise<ModelRoute> {
  const { key, signals, ...rest } = args
  const [route] = await grantStrongBatch(supabase, { ...rest, requests: [{ key, signals }] }, deps)
  return route
}

/**
 * Grant Strong to each request, in order, or say why not: the kill switch,
 * the plan, the daily cap, or a count that can't be read. The count is read
 * ONCE per batch and at most `cap - used` requests are granted, so four tasks
 * in one `helpers` call can't take nine to thirteen. Each grant is logged
 * before it is returned, so the next request counts it; a marker that isn't
 * written (an error, 'lost', or 'retry-enqueued', whose row doesn't exist yet)
 * refuses that request, since it would not count. Never throws.
 */
export async function grantStrongBatch(supabase: SupabaseClient, args: StrongBatchArgs, deps: StrongGrantDeps = {}): Promise<ModelRoute[]> {
  const fallback = args.fallbackTier ?? 'think'
  const refuse = (req: StrongRequest, why: string): ModelRoute => ({ tier: fallback, by: 'cap', signals: [...req.signals, why], reasoning: tierReasoning(fallback) })
  if (args.requests.length === 0) return []
  if (!autoEscalationEnabled(deps.env)) return args.requests.map((r) => refuse(r, 'escalation_off'))
  if (!args.isPaidPlan) return args.requests.map((r) => refuse(r, 'plan'))
  const used = await (deps.count ?? strongEscalationsToday)(supabase, args.userId, args.now)
  if (used === null) return args.requests.map((r) => refuse(r, 'cap_unreadable'))
  const out: ModelRoute[] = []
  let granted = 0
  for (const req of args.requests) {
    if (used + granted >= STRONG_DAILY_CAP) {
      out.push(refuse(req, 'daily_cap'))
      continue
    }
    const route: ModelRoute = { tier: 'strong', by: 'rule', signals: req.signals, reasoning: tierReasoning('strong') }
    try {
      const outcome = await (deps.log ?? logUsage)(args.userId, {
        provider: usageProviderLabel(STRONG_MODEL),
        model: STRONG_MODEL,
        feature: ESCALATION_FEATURE,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        costUsd: 0,
        // A marker, not spend: the Strong run bills its own tokens.
        skipBilling: true,
        idempotencyKey: `${ESCALATION_FEATURE}:${req.key}`,
        metadata: {
          workspace_id: args.workspaceId,
          surface: args.surface,
          escalations_before: used + granted,
          model_route: modelRouteMetadata(route),
        },
      })
      // Not written yet (queued for retry) or not at all: it would not count.
      if (outcome === 'lost' || outcome === 'retry-enqueued') {
        out.push(refuse(req, 'cap_unreadable'))
        continue
      }
    } catch (err) {
      console.warn('[model-escalation] marker not logged:', err instanceof Error ? err.message : String(err))
      out.push(refuse(req, 'cap_unreadable'))
      continue
    }
    granted++
    out.push(route)
  }
  return out
}
