/**
 * POST /api/account/imports/[id]/apply
 * Run a staged import (or carry on one that stopped part-way). Answers 202 at
 * once; the import runs after the answer and the page follows GET /[id].
 * Every record is written on the caller's own client.
 */
import { after, NextResponse } from 'next/server'
import { conflict, notFound } from '@/lib/api-errors'
import { loadImport } from '@/lib/imports/journal'
import { requireImporter, UUID_RE } from '@/lib/imports/route-auth'
import { runDepsFor } from '@/lib/imports/route-run'
import { runApply } from '@/lib/imports/run'

export const maxDuration = 800

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = await requireImporter()
  if (who instanceof Response) return who
  const { id } = await params
  if (!UUID_RE.test(id)) return notFound('Import not found')
  const imp = await loadImport(who.svc, id, who)
  if (!imp || imp.status === 'discarded') return notFound('Import not found')
  if (imp.status !== 'staged' && imp.status !== 'failed') return conflict(imp.status === 'running' ? 'This import is already running.' : 'This import has already run.')
  after(async () => {
    await runApply(runDepsFor(who, imp))
  })
  return NextResponse.json({ ok: true, status: 'running' }, { status: 202 })
}
