/**
 * Where the person's pick for their main agent's model (./agent-model.ts) is
 * kept: the account's `user_metadata`, beside the agent's name and look
 * (api/account/profile). Server only: it reads through the service client's
 * admin API, keyed on the user the caller already verified.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isChatGptPlanUsage } from '@/lib/chatgpt/plan-models'
import { AGENT_MODEL_FIELD, parseAgentModel, type AgentModelId } from './agent-model'

/**
 * The model the person saved for their main agent, checked: a model id, or
 * null for Auto (nothing saved, something that isn't a pick, or a failed
 * read). A failed read runs the turn on Auto rather than failing it, as a
 * spec that can't be built would; it says so in the logs.
 */
export async function readSavedAgentModel(supabase: SupabaseClient, userId: string): Promise<AgentModelId | null> {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId)
    if (error) throw error
    const metadata = (data?.user?.user_metadata ?? {}) as Record<string, unknown>
    return parseAgentModel(metadata[AGENT_MODEL_FIELD])
  } catch (err) {
    console.warn('[agent-model] could not read the saved model, running Auto:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Save the person's pick (null: Auto) on their account. Throws when the account doesn't take it. */
export async function saveAgentModel(supabase: SupabaseClient, userId: string, model: AgentModelId | null): Promise<void> {
  // GoTrue merges `user_metadata` key by key: the name, the look and the
  // rest stay as they are. Auto is saved as null, which reads back as Auto.
  const { error } = await supabase.auth.admin.updateUserById(userId, { user_metadata: { [AGENT_MODEL_FIELD]: model } })
  if (error) throw error
}

/**
 * What the setting may offer, from the person's plan: `chatgpt` (the free
 * tier: their ChatGPT plan's model runs, nothing to pick), `paid` (every
 * model) or `unpaid` (no premium model). The usage check the chat runs each
 * turn, with the same opt-in, so the setting and the turn agree. Null when
 * the check fails: the setting then offers every model, and the turn still
 * applies the plan.
 */
export type AgentModelPlan = 'chatgpt' | 'paid' | 'unpaid'

export async function readAgentModelPlan(supabase: SupabaseClient, userId: string): Promise<AgentModelPlan | null> {
  const { data, error } = await supabase.rpc('check_ai_usage_limit', { p_user_id: userId, p_chatgpt_plan: true })
  if (error) {
    console.warn('[agent-model] plan check failed:', error.message)
    return null
  }
  const row = (Array.isArray(data) ? data[0] : undefined) as { reason?: string | null; is_paid_plan?: boolean | null } | undefined
  if (isChatGptPlanUsage(row)) return 'chatgpt'
  return row?.is_paid_plan === true ? 'paid' : 'unpaid'
}
