/**
 * GET    /api/account/imports/[id]   one of the caller's imports: its preview,
 *                                     progress, summary.
 * DELETE /api/account/imports/[id]   discard a staged import (nothing was made).
 */
import { NextResponse } from 'next/server'
import { conflict, notFound, serverError } from '@/lib/api-errors'
import { uploadStoragePath } from '@/lib/imports/assets'
import { claimImport, loadImport } from '@/lib/imports/journal'
import { importView } from '@/lib/imports/preview'
import { requireImporter, UUID_RE } from '@/lib/imports/route-auth'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  const who = await requireImporter()
  if (who instanceof Response) return who
  const { id } = await params
  if (!UUID_RE.test(id)) return notFound('Import not found')
  try {
    const imp = await loadImport(who.svc, id, who)
    if (!imp || imp.status === 'discarded') return notFound('Import not found')
    return NextResponse.json({ import: await importView(who.db, who.svc, imp) })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not read that import')
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const who = await requireImporter()
  if (who instanceof Response) return who
  const { id } = await params
  if (!UUID_RE.test(id)) return notFound('Import not found')
  const imp = await loadImport(who.svc, id, who)
  if (!imp || imp.status === 'discarded') return notFound('Import not found')
  if (!(await claimImport(who.svc, id, ['staged'], 'discarded'))) return conflict('Only an import that hasn’t run can be discarded. Undo it instead.')
  await who.svc.storage.from('attachments').remove([uploadStoragePath(who.userId, id)]).catch(() => {})
  return NextResponse.json({ ok: true })
}
