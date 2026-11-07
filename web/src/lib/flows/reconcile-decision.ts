import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runDecision } from '@/lib/ai/decisions/run-decision'
import { excludePrivateSourcedClaims } from '@/lib/knowledge/claim-visibility'
import type { FlowWithSecrets, RunSkillActionConfig } from './types'

const MAX_CLAIMS = 40
export interface ReconcileSkip { reason: string; inferenceId?: string }

/** A seed tag alone is insufficient: users can customize a seeded flow. */
export function isDefaultReconciler(flow: FlowWithSecrets): boolean {
  if (!flow.enabled || flow.trigger_type !== 'schedule' || flow.seed_key !== 'seed:reconcile' ||
      !flow.created_by || flow.actions.length !== 1) return false
  const action = flow.actions[0]
  if (action.type !== 'run_skill' || !action.enabled || action.condition || action.parent_id) return false
  const config = action.config as RunSkillActionConfig
  return config.mode === 'report' && !!config.skill_id && !config.instructions?.trim() && !config.trust &&
    !config.deliver?.document_title &&
    Object.keys(config).every(key => ['skill_id', 'mode', 'deliver', 'model'].includes(key))
}

/** A narrow, fail-open preflight for the built-in claims→actions reconciler.
 * Read ALL active knowledge, never just recent changes: an old promise still
 * matters. Larger, private, partial and uncertain snapshots run normally. */
export async function decideReconcileSkip(
  db: SupabaseClient, flow: FlowWithSecrets, runId?: string,
): Promise<ReconcileSkip | null> {
  if (!isDefaultReconciler(flow)) return null
  try {
    const config = flow.actions[0].config as RunSkillActionConfig
    const { data: recipe, error: recipeError } = await db.from('recipe').select('id')
      .eq('id', config.skill_id).eq('is_system', true).eq('category', 'skill').eq('slug', 'reconcile').maybeSingle()
    if (recipeError || !recipe) return null
    const { data: claims, error } = await db.from('claim').select('id, text, type, updated_at')
      .eq('workspace_id', flow.workspace_id).eq('status', 'active')
      .order('id', { ascending: true }).limit(MAX_CLAIMS + 1)
    // Null isn't proof of an empty workspace. We also retain dismissed and
    // suggested active claims here, making the absence test conservative.
    if (error || !claims || claims.length > MAX_CLAIMS) return null
    if (claims.length === 0) return { reason: 'No active knowledge claims to reconcile — skipped.' }
    if (claims.some(claim => claim.type === 'commitment')) return null
    const visible = await excludePrivateSourcedClaims(db, flow.workspace_id, claims)
    // That helper returns [] on read failures. A reduced set cannot establish
    // absence and must never expose a private source to the classifier.
    if (visible.length !== claims.length) return null
    const input = { complete: true, claims: visible.map(claim => ({ id: claim.id,
      text: claim.text, type: claim.type, updatedAt: claim.updated_at })) }
    const decision = await runDecision('automation.reconcile_required', input, {
      userId: flow.created_by, workspaceId: flow.workspace_id, runId,
    })
    if (decision.status !== 'accepted' || decision.value.runRequired) return null
    // A new/edited/deleted claim during inference invalidates the snapshot.
    const { data: current, error: currentError } = await db.from('claim').select('id, updated_at')
      .eq('workspace_id', flow.workspace_id).eq('status', 'active')
      .order('id', { ascending: true }).limit(MAX_CLAIMS + 1)
    if (currentError || !current || current.length !== claims.length ||
        current.some((claim, index) => claim.id !== claims[index].id || claim.updated_at !== claims[index].updated_at)) return null
    return { reason: 'No commitments found in active knowledge — skipped this reconciliation.', inferenceId: decision.inferenceId }
  } catch {
    return null
  }
}
