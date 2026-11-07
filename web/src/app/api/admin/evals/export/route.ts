import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'
import { badRequest, serverError, unauthorized } from '@/lib/api-errors'
import { validateCaseDraft } from '@/lib/evals/flywheel/case-schema'
import type { EvalCandidateRow, FlywheelCase } from '@/lib/evals/flywheel/types'

/**
 * GET /api/admin/evals/export
 *
 * The promoted flywheel cases not yet exported, as a FlywheelCase[] JSON
 * download, oldest promotion first: the input of scripts/eval-flywheel-import.ts,
 * which writes them into src/lib/packs/skill-evals/cases/flywheel.json.
 * Read-only: a download marks nothing. A row whose stored case no longer
 * validates is left out (the reviewer reopens and fixes it).
 *
 * POST /api/admin/evals/export  { candidateIds: string[] }  → { marked: string[] }
 *
 * Marks exactly those rows `exported` (with `exported_at`), so the next
 * download holds only newer promotions: the admin page posts the ids it just
 * downloaded. Only a row still `promoted` is marked; `marked` says which were.
 * A reviewer can reopen an exported row (PATCH .../candidates/[id]); the
 * import dedupes on candidateId, so exporting it again is harmless.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The most ids one mark takes (a download is every unexported promotion, far fewer). */
const MARK_MAX = 500

type PromotedRow = Pick<EvalCandidateRow, 'id' | 'source' | 'polarity' | 'case_draft' | 'reviewed_at' | 'updated_at'>

export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return unauthorized()
  }

  const supabase = await getAdminServiceClient()

  const { data, error } = await supabase
    .from('eval_candidate')
    .select('id, source, polarity, case_draft, reviewed_at, updated_at')
    .eq('status', 'promoted')
    .is('exported_at', null)
    .order('reviewed_at', { ascending: true })
  if (error) return serverError(error.message)

  const cases: FlywheelCase[] = []
  for (const row of (data ?? []) as PromotedRow[]) {
    const checked = validateCaseDraft(row.case_draft)
    if (!checked.ok) continue
    cases.push({
      candidateId: row.id,
      skill: checked.value.skill,
      source: row.source,
      polarity: row.polarity,
      promotedAt: row.reviewed_at ?? row.updated_at,
      case: checked.value.case as Record<string, unknown>,
    })
  }

  const day = new Date().toISOString().slice(0, 10)
  return new Response(JSON.stringify(cases, null, 2) + '\n', {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="flywheel-cases-${day}.json"`,
      'Cache-Control': 'no-store',
    },
  })
}

export async function POST(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return unauthorized()
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const ids: unknown = body && typeof body === 'object' ? (body as { candidateIds?: unknown }).candidateIds : undefined
  if (!Array.isArray(ids) || ids.length === 0) return badRequest('candidateIds must be a non-empty array')
  if (ids.length > MARK_MAX) return badRequest(`candidateIds takes at most ${MARK_MAX} ids`)
  if (!ids.every((id) => typeof id === 'string' && UUID_RE.test(id))) return badRequest('candidateIds must be candidate ids')
  const unique = [...new Set(ids as string[])]

  const supabase = await getAdminServiceClient()
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('eval_candidate')
    .update({ status: 'exported', exported_at: now, updated_at: now })
    .in('id', unique)
    // Only a promotion: a row reopened or dismissed since the download stays as it is.
    .eq('status', 'promoted')
    .select('id')
  if (error) return serverError(error.message)

  const marked = Array.isArray(data) ? (data as Array<{ id: string }>).map((r) => r.id) : []
  return NextResponse.json({ marked })
}
