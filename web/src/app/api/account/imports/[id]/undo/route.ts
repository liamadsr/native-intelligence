/**
 * POST /api/account/imports/[id]/undo
 * Take an import back as a whole: only what it made, keeping anything changed
 * since, on the caller's own client (src/lib/imports/undo.ts). Answers 202;
 * the undo runs after the answer.
 */
import { after, NextResponse } from 'next/server'
import { conflict, notFound } from '@/lib/api-errors'
import { loadImport } from '@/lib/imports/journal'
import { requireImporter, UUID_RE } from '@/lib/imports/route-auth'
import { runUndo } from '@/lib/imports/run'

export const maxDuration = 800

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = await requireImporter()
  if (who instanceof Response) return who
  const { id } = await params
  if (!UUID_RE.test(id)) return notFound('Import not found')
  const imp = await loadImport(who.svc, id, who)
  if (!imp || imp.status === 'discarded') return notFound('Import not found')
  if (imp.status === 'undone') return conflict('This import was already undone.')
  if (imp.status === 'staged') return conflict('This import hasn’t run: discard it instead.')
  if (imp.status === 'running') return conflict('Wait for the import to finish, then undo it.')
  after(async () => {
    await runUndo({ db: who.db, svc: who.svc, imp, userId: who.userId })
  })
  return NextResponse.json({ ok: true, status: 'undoing' }, { status: 202 })
}
