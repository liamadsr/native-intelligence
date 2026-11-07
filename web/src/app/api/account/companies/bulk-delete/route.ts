import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { deleteCompaniesWithContacts } from '@/lib/crm/delete-companies'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/companies/bulk-delete
 *
 * Cascade-deletes companies AND all their contacts (see
 * src/lib/crm/delete-companies.ts for why this runs on the service client).
 *
 * Body: { ids: string[] (1..100), dry_run?: boolean }
 *   dry_run=true  → { companies, contacts } counts of what WOULD be deleted
 *   otherwise     → performs the cascade → { companies, contacts } deleted
 *
 * Owner/admin only: the cascade runs on the service client, and the
 * contact_delete RLS policy (migration 058) reserves contact deletion for
 * creator-or-admin — a plain member must not gain blanket delete power (or
 * dry-run counts of private contacts they cannot see) through this route.
 */
export async function POST(request: NextRequest) {
  // select must name 'role' — the helper defaults to just 'id', which would
  // leave member.role undefined and 403 owners too.
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { workspaceId, member } = auth
  if (member.role !== 'owner' && member.role !== 'admin') {
    return forbidden('Only workspace owners or admins can delete companies and their people')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const { ids, dry_run } = (body ?? {}) as { ids?: unknown; dry_run?: unknown }
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    !ids.every((id) => typeof id === 'string')
  ) {
    return badRequest('ids must be a non-empty array of strings')
  }
  if (ids.length > 100) {
    return badRequest('Maximum 100 companies per request')
  }

  try {
    const result = await deleteCompaniesWithContacts(
      getServiceClient(),
      workspaceId,
      ids,
      // Boolean(): a truthy non-boolean (e.g. "true") must never fall through
      // to the destructive path — only an explicit absent/false performs it.
      { dryRun: Boolean(dry_run) },
    )
    return NextResponse.json(result)
  } catch (err) {
    console.error('[companies/bulk-delete] cascade failed:', err)
    return serverError()
  }
}
