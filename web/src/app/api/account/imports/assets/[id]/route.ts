/**
 * GET /api/account/imports/assets/[id]
 * A file an import brought in (a Notion page's image), for someone who can
 * read a page it is on: the import's documents that link it are read on the
 * CALLER's client (their visibility and per-person grants apply), and only
 * when one comes back is the caller sent to a short-lived signed link.
 */
import { NextResponse } from 'next/server'
import { notFound, serverError } from '@/lib/api-errors'
import { requireWorkspace } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/supabase/service'
import { assetAddress, assetStoragePath } from '@/lib/imports/assets'
import { UUID_RE } from '@/lib/imports/route-auth'
import type { AssetRecord } from '@/lib/imports/types'

const TTL_SECONDS = 300

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params
  if (!UUID_RE.test(id)) return notFound('File not found')
  const svc = getServiceClient()
  const { data: item } = await svc
    .from('work_import_item')
    .select('id, import_id, workspace_id, kind, record, outcome, undo_outcome')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  const asset = item as { id: string; import_id: string; kind: string; record: AssetRecord; outcome: string; undo_outcome: string | null } | null
  if (!asset || asset.kind !== 'asset' || asset.outcome !== 'created' || asset.undo_outcome === 'removed') return notFound('File not found')
  const { data: imp } = await svc.from('work_import').select('user_id').eq('id', asset.import_id).maybeSingle()
  if (!imp) return notFound('File not found')
  // The import's documents, then one of them that links the file, read as the caller.
  const { data: docs } = await svc.from('work_import_item').select('entity_id').eq('import_id', asset.import_id).eq('kind', 'document').eq('outcome', 'created').not('entity_id', 'is', null).limit(2000)
  const docIds = ((docs ?? []) as Array<{ entity_id: string }>).map((d) => d.entity_id)
  let readable = false
  for (let i = 0; i < docIds.length && !readable; i += 200) {
    const { data } = await supabase.from('document').select('id').in('id', docIds.slice(i, i + 200)).ilike('content', `%${assetAddress(asset.id)}%`).limit(1)
    readable = (data ?? []).length > 0
  }
  if (!readable) return notFound('File not found')
  const path = assetStoragePath((imp as { user_id: string }).user_id, asset.import_id, asset.id, asset.record.file_name)
  const { data: signed, error } = await svc.storage.from('attachments').createSignedUrl(path, TTL_SECONDS)
  if (error || !signed?.signedUrl) return serverError('The file could not be opened.')
  return NextResponse.redirect(signed.signedUrl, { status: 302, headers: { 'Cache-Control': 'private, max-age=60' } })
}
