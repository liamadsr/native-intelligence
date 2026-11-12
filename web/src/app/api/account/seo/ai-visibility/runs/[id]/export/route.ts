/**
 * GET /api/account/seo/ai-visibility/runs/[id]/export: one check as a CSV
 * download, a row per answer (prompt, engine, status, whether the brand was
 * named or cited and where, the brands named, the cited URLs, the answer's
 * text). Cells a spreadsheet would run as formulas are written as text.
 * Free.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { UUID } from '@/lib/seo/ai-visibility/http'
import { exportRunCsv } from '@/lib/seo/ai-visibility/queries'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Check not found')
  try {
    const csv = await exportRunCsv(getServiceClient(), auth.workspaceId, id)
    if (csv === null) return notFound('Check not found')
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="ai-visibility-${id.slice(0, 8)}.csv"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (err) {
    console.error('[seo-ai] export failed', err)
    return serverError('Could not export the check just now.')
  }
}
