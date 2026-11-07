/**
 * A helper's model, decided before it starts: the main agent's choice from
 * HELPER_MODELS when it named one (`model` on the task), else the rules on
 * its task (routeHelperTask, auto model selection, src/lib/ai/model-route.ts);
 * then, for a premium model (Strong), the plan, the daily cap and the kill
 * switch (grantStrongBatch), whoever picked it. Refused, it runs on
 * HELPER_MODEL_FALLBACK. Every route carries its roster key (`model`).
 * Shared by the quick helpers (the `helpers` tool's first step, through
 * /api/internal/chat/helper-tiers) and the background ones (start_helper,
 * src/lib/chat/start-helper.ts).
 *
 * Jev's model.tier never decides here while JEV_TIER_MODE is 'shadow': the
 * callers fire it after answering, for the undecided tasks only.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkUsageLimits } from './auth'
import { HELPER_MODEL_FALLBACK, helperModelForTier, type HelperModelKey } from './models'
import { helperRouteForModel, routeHelperTask, type ModelRoute, type ModelTier } from './model-route'
import { grantStrongBatch, type StrongGrantDeps } from './model-escalation-budget'

interface HelperTierBase {
  userId: string
  workspaceId: string
  surface: 'quick_helper' | 'background_helper'
  /** The person's own message this turn, when known: "use the best model" there counts. */
  turnExcerpt?: string
  /** The tier when the rules can't tell. */
  defaultTier: ModelTier
  /**
   * The highest tier this start may run (a server-started helper, with no
   * person's ask behind it, is held to Think). Absent: no ceiling.
   */
  maxTier?: Exclude<ModelTier, 'strong'>
}

export interface HelperTierArgs extends HelperTierBase {
  /** Names this start once, for the escalation count (a run id, or a tool call's task). */
  key: string
  /** The task and its context, as the helper will read them. */
  task: string
  /** The model the main agent chose (HELPER_MODELS), when it named one. */
  requested?: HelperModelKey
}

export interface HelperTierBatchArgs extends HelperTierBase {
  tasks: Array<{ key: string; task: string; requested?: HelperModelKey }>
}

export interface HelperTierDecision {
  route: ModelRoute
  /** The rules could not tell: Jev may answer in shadow. */
  undecided: boolean
}

export interface HelperTierDeps extends StrongGrantDeps {
  /** is_paid_plan, read only when the rules want Strong. */
  isPaidPlan?: (userId: string) => Promise<boolean>
}

async function paidPlan(userId: string): Promise<boolean> {
  try {
    return (await checkUsageLimits(userId))?.is_paid_plan ?? false
  } catch {
    return false
  }
}

/** The tier a helper task runs on. Never throws: a failed read keeps it off Strong. */
export async function decideHelperTier(supabase: SupabaseClient, args: HelperTierArgs, deps: HelperTierDeps = {}): Promise<HelperTierDecision> {
  const { key, task, requested, ...base } = args
  const [decision] = await decideHelperTiers(supabase, { ...base, tasks: [{ key, task, ...(requested ? { requested } : {}) }] }, deps)
  return decision
}

/** A premium route refused (`why` joins its signals): HELPER_MODEL_FALLBACK, decided by the cap. */
function refusedRoute(ruled: ModelRoute, why?: string): ModelRoute {
  return helperRouteForModel(HELPER_MODEL_FALLBACK, 'cap', why ? [...ruled.signals, why] : ruled.signals)
}

/** A route with its roster key: the agent's choice, else its tier's model. */
function withModel(route: ModelRoute): ModelRoute {
  return route.model ? route : { ...route, model: helperModelForTier(route.tier) }
}

/**
 * The tier of each task of one start, in order. The plan and the cap are read
 * once for the whole batch, and at most the cap's remainder is granted Strong
 * (grantStrongBatch), so parallel tasks can't overshoot it. Never throws.
 */
export async function decideHelperTiers(supabase: SupabaseClient, args: HelperTierBatchArgs, deps: HelperTierDeps = {}): Promise<HelperTierDecision[]> {
  const ruled = args.tasks.map((t) =>
    routeHelperTask(t.task, { turnExcerpt: args.turnExcerpt, defaultTier: args.defaultTier, ...(t.requested ? { requested: t.requested } : {}) }),
  )
  const out: HelperTierDecision[] = ruled.map(({ undecided, ...route }) => ({ route: withModel(route), undecided }))
  const wantStrong = ruled.flatMap((r, i) => (r.tier === 'strong' ? [i] : []))
  if (args.maxTier) {
    // Held to a ceiling (a server start): a premium model is never asked
    // for. The ceiling is Think, so it runs on the Think model.
    for (const i of wantStrong) {
      out[i] = {
        route: helperRouteForModel(args.maxTier === 'fast' ? 'flash' : HELPER_MODEL_FALLBACK, 'cap', [...ruled[i].signals, 'server_start']),
        undecided: false,
      }
    }
    return out
  }
  if (wantStrong.length === 0) return out
  const granted = await grantStrongBatch(
    supabase,
    {
      userId: args.userId,
      workspaceId: args.workspaceId,
      isPaidPlan: await (deps.isPaidPlan ?? paidPlan)(args.userId),
      surface: args.surface,
      fallbackTier: 'think',
      requests: wantStrong.map((i) => ({ key: args.tasks[i].key, signals: ruled[i].signals })),
    },
    deps,
  )
  // Granted: the model the agent (or the rules) wanted, decided as before.
  // Refused: the fallback model, `by: 'cap'` with the reason in its signals.
  wantStrong.forEach((i, j) => {
    const g = granted[j]
    out[i] = { route: g.tier === 'strong' ? { ...out[i].route, signals: g.signals } : refusedRoute(ruled[i], g.signals.at(-1)), undecided: false }
  })
  return out
}
