import type { SupabaseClient } from '@supabase/supabase-js'
import { createNotification } from '@/lib/notifications'

/**
 * The email-management cron's follow-up pass: one `contact_followup_due`
 * notice for each contact whose follow-up date falls in the next 24 hours,
 * to the contact's owner. The notice tap (agent-events/notice.ts) turns it
 * into a quiet `contact.followup_due` event, so the agent's digest names it.
 *
 * The owner is the contact's creator (`created_by_member_id`, migration 058).
 * `member_id` is a contact that IS a workspace member, never its owner. It
 * used to go to the workspace's first five members instead
 * (docs/plans/retire-notifications-page.md). A contact with no creator gets
 * no notice. Returns the count sent.
 */
export async function checkContactFollowups(supabase: SupabaseClient, nowMs: number = Date.now()): Promise<number> {
  const now = new Date(nowMs)
  const todayStr = now.toISOString().split('T')[0]
  const tomorrow = new Date(nowMs + 24 * 60 * 60 * 1000)

  const { data: contacts } = await supabase
    .from('contact')
    .select('id, full_name, workspace_id, next_followup_at, created_by_member_id')
    .lte('next_followup_at', tomorrow.toISOString())
    .gte('next_followup_at', now.toISOString())

  let count = 0
  for (const contact of (contacts ?? []) as Array<{ id: string; full_name: string; workspace_id: string; created_by_member_id: string | null }>) {
    if (!contact.created_by_member_id) continue
    await createNotification({
      workspaceId: contact.workspace_id,
      recipientId: contact.created_by_member_id,
      type: 'contact_followup_due',
      title: `Follow up with ${contact.full_name}`,
      targetType: 'contact',
      targetId: contact.id,
      groupKey: `followup_contact:${contact.id}:${todayStr}`,
    })
    count++
  }
  return count
}
