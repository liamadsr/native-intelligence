/**
 * The notice destination members get once a merge has committed: "<source>
 * was merged into <destination>: N actions, M people, … came over." Every
 * notice goes through the agent (migration 401) as an FYI it tells in chat;
 * the agent event carries only the title, so the counts ride in the title.
 *
 * The person who merged is the actor: createNotification skips them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createNotificationsForMany } from '@/lib/notifications'
import { mergeCountsLine } from './wording'

export { mergeCountsLine }

export interface MergeAnnouncement {
  destinationWorkspaceId: string
  /** The merging person's member id in the destination (skipped as the actor). */
  actorMemberId: string
  sourceName: string
  destinationName: string
  mergeId: string
  /** merge_workspace's `rows_before` (per-table counts of what came over). */
  rowsBefore: Record<string, number>
}

/** The notice's title: what merged into what, and what came over. Pure. */
export function mergeAnnouncementTitle(sourceName: string, destinationName: string, rowsBefore: Record<string, number>): string {
  const counts = mergeCountsLine(rowsBefore)
  const head = `${sourceName} was merged into ${destinationName}`
  return counts ? `${head}: ${counts} came over.` : `${head}.`
}

/** The body: the one sentence people need to hear. Pure. */
export function mergeAnnouncementBody(rowsBefore: Record<string, number>): string {
  const counts = mergeCountsLine(rowsBefore)
  return counts ? `${counts} came over. Nothing was deleted.` : 'Nothing was deleted.'
}

/** Tell every destination member except the actor. Never throws. */
export async function announceWorkspaceMerge(service: SupabaseClient, a: MergeAnnouncement): Promise<number> {
  try {
    const { data: members, error } = await service
      .from('member')
      .select('id')
      .eq('workspace_id', a.destinationWorkspaceId)
    if (error || !members) return 0
    const recipients = (members as Array<{ id: string }>).map((m) => m.id).filter((id) => id !== a.actorMemberId)
    if (recipients.length === 0) return 0
    await createNotificationsForMany(recipients, {
      workspaceId: a.destinationWorkspaceId,
      type: 'workspace_merged',
      title: mergeAnnouncementTitle(a.sourceName, a.destinationName, a.rowsBefore),
      body: mergeAnnouncementBody(a.rowsBefore),
      actorId: a.actorMemberId,
      groupKey: `workspace_merged:${a.mergeId}`,
      metadata: { merge_id: a.mergeId, source_name: a.sourceName, rows_before: a.rowsBefore },
    })
    return recipients.length
  } catch (err) {
    console.error('[workspace-merge] announcement failed', err)
    return 0
  }
}
