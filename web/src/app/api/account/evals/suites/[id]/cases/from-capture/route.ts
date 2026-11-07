/**
 * POST /api/account/evals/suites/[id]/cases/from-capture — seed a case from a
 * recorded capture: `{ capture_id, name? }`.
 *
 * The suite is verified on the RLS-scoped client first, as the plain cases
 * POST does; the service write then runs scoped to the workspace that read
 * resolved. Whether the caller may replay that capture is decided inside
 * `createEvalCaseFromCapture` (the capture visibility fence): only a
 * workspace-visible capture can become a case, because a run's trials are
 * readable by every member. A private capture (even the caller's own), one
 * they cannot see, or one that does not exist is the same 404.
 *
 * The case comes back with empty expectations, live mode only, for a person to
 * fill in (the goal, the moments to speak up, the windows to stay quiet).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspace, requireWorkspaceFeature } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { createEvalCaseFromCapture } from '@/lib/evals/case-from-capture'
import { getSuite } from '@/lib/evals/queries'
import { CreateCaseFromCaptureSchema } from '../../../../schemas'
import { parseBody } from '../../../../parse-body'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  const suite = await getSuite(supabase, workspaceId, id)
  if (!suite) return notFound('Suite not found')

  const parsed = await parseBody(request, CreateCaseFromCaptureSchema)
  if (!parsed.ok) return parsed.response

  try {
    const result = await createEvalCaseFromCapture(getServiceClient(), {
      workspaceId,
      userId: user.id,
      suiteId: id,
      captureId: parsed.data.capture_id,
      name: parsed.data.name,
    })
    if (!result.ok) {
      return result.reason === 'not_found'
        ? notFound('Capture not found')
        : badRequest('That capture has no transcript to replay')
    }
    return NextResponse.json({ case: result.caseRow }, { status: 201 })
  } catch (err) {
    console.error('[evals] create case from capture failed:', err)
    return serverError()
  }
}
