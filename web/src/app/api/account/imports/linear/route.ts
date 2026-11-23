/**
 * GET /api/account/imports/linear
 * The Linear teams the workspace's connection reads, and ours to put each
 * into. Only for the person who connected Linear (an import reads Linear as
 * them).
 */
import { NextResponse } from 'next/server'
import { apiError, serverError } from '@/lib/api-errors'
import { requireImporter } from '@/lib/imports/route-auth'
import { linearTeamsFor } from '@/lib/imports/stage'

export async function GET() {
  const who = await requireImporter()
  if (who instanceof Response) return who
  try {
    const out = await linearTeamsFor(who)
    if (!out.ok) return apiError(out.error, { status: out.code === 'not_yours' ? 403 : 409, code: (out.code ?? 'LINEAR').toUpperCase() })
    return NextResponse.json({ linear: out.linear, teams: out.ours })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not read Linear')
  }
}
