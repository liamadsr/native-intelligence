import { requireWorkspaceMember } from '@/lib/api-auth'
import { forbidden } from '@/lib/api-errors'

/**
 * The folder routes' caller: a member of the workspace, never a guest
 * (migration 690 leaves guests out of folders; the database refuses them too).
 */
export async function requireFolderMember() {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if ((auth.member as { role?: string | null }).role === 'guest') return forbidden('Folders are for the workspace’s members.')
  return auth
}
