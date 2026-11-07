import { NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { startWiring } from '@/lib/website/start'
import { outcomeError } from '@/lib/website/http'

/**
 * POST /api/account/website/wire: connect the site's form to the business's
 * intake, exactly as wire_website_form does on the person's own turn. It
 * starts the coding run; the pull request it opens merges only on their yes
 * (the card in their chat and the code texted to them).
 */
export async function POST() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    const out = await startWiring(getServiceClient(), { userId: auth.user.id, workspaceId: auth.workspaceId }, {})
    if (!out.success) return outcomeError(out)
    return NextResponse.json({ started: true })
  } catch (err) {
    console.error('[website] wiring failed to start', err)
    return serverError('Could not start that just now.')
  }
}
