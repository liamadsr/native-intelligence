import { requireWorkspaceMember } from '@/lib/api-auth'
import { forbidden, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { appOrigin } from '@/lib/twilio/config'
import { rotateIntakeKey } from '@/lib/customers/intake-key'
import { intakeUrl } from '@/lib/customers/profile-input'

export const dynamic = 'force-dynamic'

/**
 * POST /api/account/business/intake-key: a new secret URL for the website's
 * quote form (roadmap B1). The old one stops working. The URL is in this
 * answer only: it is never stored or shown again. Body (optional):
 * `{ allowed_origins: ["https://brightweave.com"] }`. Owners only.
 */
export async function POST(request: Request) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (auth.member.role !== 'owner') return forbidden('Only an owner of the workspace can make the quote form link.')
  const body = (await request.json().catch(() => null)) as { allowed_origins?: unknown } | null
  try {
    const made = await rotateIntakeKey(getServiceClient(), {
      workspaceId: auth.workspaceId,
      userId: auth.user.id,
      allowedOrigins: Array.isArray(body?.allowed_origins) ? (body.allowed_origins as string[]) : [],
    })
    return Response.json({ url: intakeUrl(appOrigin(), made.key), prefix: made.prefix, allowed_origins: made.allowedOrigins }, { status: 201 })
  } catch (err) {
    console.error('[business] intake key failed:', err instanceof Error ? err.message : String(err))
    return serverError()
  }
}
