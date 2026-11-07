/**
 * The to-do a payment closes (roadmap C2): "Get paid: $600.00 from Sarah Lee
 * (Rug wash)" on the owner's board while the link is out, done when the
 * customer pays. The agent may name an existing to-do instead (the job's own);
 * either way the webhook's follow-ups close it (completeActionOnReview: the
 * team's first completed state, as a person's write, so status loops fire).
 *
 * Server only. Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { completeActionOnReview } from '@/lib/actions/agent-finish'

/** An action of this workspace, by id (the agent's `action_id`), or null. */
export async function findWorkspaceAction(supabase: SupabaseClient, workspaceId: string, actionId: string): Promise<{ id: string; title: string } | null> {
  try {
    const { data } = await supabase.from('actions').select('id, title').eq('id', actionId).eq('workspace_id', workspaceId).maybeSingle<{ id: string; title: string }>()
    return data ?? null
  } catch {
    return null
  }
}

/** Make the owner's "get paid" to-do, assigned to them, linked to the contact. */
export async function createPaymentTodo(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; title: string; description: string; contactId: string | null },
): Promise<string | null> {
  try {
    const { data: team } = await supabase.from('team').select('id').eq('workspace_id', args.workspaceId).order('created_at', { ascending: true }).limit(1).maybeSingle<{ id: string }>()
    if (!team) return null
    const { data: state } = await supabase.from('workflow_state').select('id').eq('team_id', team.id).eq('is_default', true).maybeSingle<{ id: string }>()
    if (!state) return null
    const { data: member } = await supabase.from('member').select('id').eq('workspace_id', args.workspaceId).eq('user_id', args.userId).maybeSingle<{ id: string }>()
    const { data: action, error } = await supabase
      .from('actions')
      .insert({
        user_id: args.userId,
        workspace_id: args.workspaceId,
        team_id: team.id,
        title: args.title.slice(0, 200),
        description: args.description,
        priority: 'none',
        status_id: state.id,
        confirmation: 'confirmed',
        links: [],
        all_day: true,
        ...(member ? { assignee_id: member.id } : {}),
      })
      .select('id')
      .single<{ id: string }>()
    if (error || !action) {
      console.warn('[payments] to-do not made:', error?.message ?? 'no row')
      return null
    }
    if (member) await supabase.from('action_assignee').insert({ action_id: action.id, member_id: member.id })
    if (args.contactId) {
      const { error: linkError } = await supabase.from('entity_link').insert({
        workspace_id: args.workspaceId,
        source_type: 'action',
        source_id: action.id,
        target_type: 'contact',
        target_id: args.contactId,
        relation: 'about',
        created_by: args.userId,
      })
      if (linkError && linkError.code !== '23505') console.warn('[payments] to-do contact link skipped:', linkError.message)
    }
    return action.id
  } catch (err) {
    console.warn('[payments] to-do not made:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Close it (already closed: left alone). */
export async function closePaymentTodo(supabase: SupabaseClient, args: { actionId: string; workspaceId: string; actorUserId: string }): Promise<boolean> {
  return (await completeActionOnReview(supabase, args)) !== null
}
