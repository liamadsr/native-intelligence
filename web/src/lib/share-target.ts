import type { getServiceClient } from '@/lib/admin'

type ServiceClient = ReturnType<typeof getServiceClient>

export interface ShareTargetRow {
  workspace_id: string
  shareable_type: string
  shareable_id: string
  created_by: string
}

/**
 * Whether a share row may open its item. The public share routes read the
 * item on the service client, so they ask this first. RLS (migration 447)
 * already stops a member writing a share for something they can't see; this
 * catches a row that got past it anyway (one written before 447, or by the
 * service role):
 *   - the item exists and is in the share's workspace;
 *   - a private item opens only from its own creator's share.
 */
export async function shareTargetAllowed(service: ServiceClient, share: ShareTargetRow): Promise<boolean> {
  if (share.shareable_type === 'document') {
    const { data: doc } = await service
      .from('document')
      .select('workspace_id, visibility, created_by')
      .eq('id', share.shareable_id)
      .maybeSingle()
    if (!doc || doc.workspace_id !== share.workspace_id) return false
    return doc.visibility !== 'private' || (!!doc.created_by && doc.created_by === share.created_by)
  }

  if (share.shareable_type === 'capture') {
    const { data: capture } = await service
      .from('captures')
      .select('workspace_id, visibility, user_id')
      .eq('id', share.shareable_id)
      .maybeSingle()
    if (!capture || capture.workspace_id !== share.workspace_id) return false
    if (capture.visibility !== 'private') return true
    // A capture's creator is an auth user; the share's is a member row.
    const { data: creator } = await service
      .from('member')
      .select('user_id')
      .eq('id', share.created_by)
      .eq('workspace_id', share.workspace_id)
      .maybeSingle()
    return !!creator?.user_id && creator.user_id === capture.user_id
  }

  return false
}
