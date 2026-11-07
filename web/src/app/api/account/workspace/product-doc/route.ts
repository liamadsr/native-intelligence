import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { fetchWorkspaceSettings } from '@/lib/workspace-settings'
import {
  PRODUCT_DOC_COLUMNS,
  isProductDocId,
  productDocIneligibility,
  readProductDocPointer,
  setWorkspaceProductDoc,
  type ProductDocIneligibleReason,
  type ProductDocPointer,
  type ProductDocRow,
} from '@/lib/workspace/product-doc'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET/PUT/DELETE /api/account/workspace/product-doc
 *
 * The workspace's curated product doc (src/lib/workspace/product-doc.ts): the
 * document the live agent states product facts from on every member's calls.
 * The pointer lives at `workspace.settings.product_doc`.
 *
 *   GET    any member: the pointer + the doc's title and updated_at, or null.
 *   PUT    owner/admin: `{ document_id }`. The document must be in this
 *          workspace, active, published, not a generated spec page and not
 *          someone's own meeting prep (isProductDocEligible).
 *   DELETE owner/admin: clears it.
 *
 * Writes go through the SERVICE client after the role gate, as the edition
 * route does: the workspace UPDATE policy is owner-only (migration 013), so an
 * admin's session client would update 0 rows. Reads stay on the session client.
 */

const INELIGIBLE: Record<ProductDocIneligibleReason, string> = {
  archived: 'That document is archived. Pick an active one.',
  draft: 'That document is a draft. Publish it first.',
  spec: 'Generated spec pages can’t be the product doc. Pick a document your team maintains.',
  private: 'That document is private (Only me). Pick a document the whole workspace shares.',
  personal: 'That document is someone’s own meeting prep. Pick a document the whole workspace shares.',
}

interface ProductDocView extends ProductDocPointer {
  title: string | null
  updated_at: string | null
  /** False when the document is gone or no longer qualifies (the agent then ignores it). */
  available: boolean
}

async function readDocRow(supabase: SupabaseClient, workspaceId: string, documentId: string) {
  return supabase
    .from('document')
    .select(PRODUCT_DOC_COLUMNS)
    .eq('id', documentId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
}

function view(pointer: ProductDocPointer, row: ProductDocRow | null): ProductDocView {
  return {
    ...pointer,
    title: row && typeof row.title === 'string' ? row.title : null,
    updated_at: row && typeof row.updated_at === 'string' ? row.updated_at : null,
    available: !!row && productDocIneligibility(row) === null,
  }
}

export async function GET(): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const pointer = readProductDocPointer(await fetchWorkspaceSettings(supabase, workspaceId))
  if (!pointer) return NextResponse.json({ product_doc: null })

  const { data, error } = await readDocRow(supabase, workspaceId, pointer.document_id)
  if (error) return serverError()
  return NextResponse.json({ product_doc: view(pointer, data as ProductDocRow | null) })
}

export async function PUT(request: NextRequest): Promise<Response> {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth

  // The doc speaks for the product on EVERY member's calls: an admin/owner
  // choice, like the edition.
  if (member.role !== 'owner' && member.role !== 'admin') {
    return forbidden('Only workspace admins can set the product doc')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const rawId = (body as { document_id?: unknown } | null)?.document_id
  if (!isProductDocId(rawId)) return badRequest('Expected `document_id`')
  // Stored lowercase: the pointer is compared as text, case-sensitively, by
  // the database (359's is_product_doc, against id::text) and the app
  // (src/lib/documents/access.ts), and a uuid's text form is lowercase. An
  // uppercase pointer would still resolve here (uuid equality ignores case)
  // but quietly switch off the product doc's write protection.
  const documentId = rawId.toLowerCase()

  // Scoped to THIS workspace (the filter is the fence on a device token's
  // service-role client; RLS is the second one on a session).
  const { data, error } = await readDocRow(supabase, workspaceId, documentId)
  if (error) return serverError()
  const row = data as ProductDocRow | null
  if (!row) return notFound('Document not found in this workspace')
  const reason = productDocIneligibility(row)
  if (reason) return badRequest(INELIGIBLE[reason], { reason })

  const pointer: ProductDocPointer = {
    document_id: documentId,
    set_by: member.id,
    set_at: new Date().toISOString(),
  }
  const service = (await import('@/lib/supabase/service')).getServiceClient()
  const result = await setWorkspaceProductDoc(service, workspaceId, pointer)
  if (!result.ok) return serverError(result.error)

  return NextResponse.json({ product_doc: view(pointer, row) })
}

export async function DELETE(): Promise<Response> {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { workspaceId, member } = auth

  if (member.role !== 'owner' && member.role !== 'admin') {
    return forbidden('Only workspace admins can clear the product doc')
  }

  const service = (await import('@/lib/supabase/service')).getServiceClient()
  const result = await setWorkspaceProductDoc(service, workspaceId, null)
  if (!result.ok) return serverError(result.error)
  return NextResponse.json({ product_doc: null })
}
