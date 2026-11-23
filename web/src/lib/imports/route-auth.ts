/**
 * The imports routes' caller (src/app/api/account/imports): a signed-in
 * member of the workspace, never a guest (a guest makes no tasks, documents
 * or tables), with their own session client for every record an import
 * makes and the service client for the journal.
 */
import { requireWorkspaceMember } from '@/lib/api-auth'
import { forbidden } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import type { Who } from './stage'

export async function requireImporter(): Promise<Who | Response> {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (auth.member.role === 'guest') return forbidden('A guest can’t import into this workspace.')
  return { db: auth.supabase, svc: getServiceClient(), workspaceId: auth.workspaceId, userId: auth.user.id, memberId: auth.member.id }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
