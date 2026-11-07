import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceIdSafe } from '@/lib/workspace'
import { renderEmbeddedQueries } from '@/lib/wiki/render'
import { canEditDocument, loadDocumentAccess } from '@/lib/documents/access'
import { WikiEditor } from '../wiki-editor'

export const dynamic = 'force-dynamic'

interface BacklinkRow {
  id: string
  source_type: string
  source_id: string
  relation: string
  label: string | null
}

export default async function WikiDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const workspaceId = await getCurrentWorkspaceIdSafe()
  if (!workspaceId) {
    return <div className="p-8 text-sm text-muted-foreground">No workspace selected.</div>
  }

  const { id } = await params

  const { data: doc } = await supabase
    .from('document')
    .select('id, title, content, slug, type, tags, frontmatter, published_status, published_at, revision, updated_at')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!doc) notFound()

  // Who may change it (migration 359): view only when they can't edit.
  const { access } = await loadDocumentAccess(supabase, workspaceId, user.id, id)
  const canEdit = access ? canEditDocument(access) : false
  const memberId = access?.memberId ?? null

  let draftContent: string | null = null
  let draftUpdatedAt: string | null = null
  if (memberId) {
    const { data: draft } = await supabase
      .from('document_draft')
      .select('content, updated_at')
      .eq('document_id', id)
      .eq('author_id', memberId)
      .maybeSingle()
    draftContent = draft?.content ?? null
    draftUpdatedAt = draft?.updated_at ?? null
  }

  // Render embedded queries against the *published* body (drafts have their own
  // preview path via the rendered endpoint).
  const { blocks } = await renderEmbeddedQueries(supabase, workspaceId, doc.content ?? '')

  // Backlinks via entity_link.
  const { data: backlinkRows } = await supabase
    .from('entity_link')
    .select('id, source_type, source_id, relation')
    .eq('workspace_id', workspaceId)
    .eq('target_type', 'document')
    .eq('target_id', id)
    .order('created_at', { ascending: false })
    .limit(50)

  const docIds = (backlinkRows || []).filter((r) => r.source_type === 'document').map((r) => r.source_id as string)
  const claimIds = (backlinkRows || []).filter((r) => r.source_type === 'claim').map((r) => r.source_id as string)

  const labels = new Map<string, string>()
  if (docIds.length > 0) {
    const { data: docs } = await supabase
      .from('document')
      .select('id, title, slug')
      .in('id', docIds)
      .eq('workspace_id', workspaceId)
    for (const d of docs || []) {
      labels.set(`document:${d.id}`, (d.title as string) || (d.slug as string) || (d.id as string))
    }
  }
  if (claimIds.length > 0) {
    const { data: claims } = await supabase
      .from('claim')
      .select('id, text')
      .in('id', claimIds)
      .eq('workspace_id', workspaceId)
    for (const c of claims || []) {
      const text = (c.text as string) || ''
      labels.set(`claim:${c.id}`, text.length > 80 ? `${text.slice(0, 80)}…` : text)
    }
  }

  const backlinks: BacklinkRow[] = (backlinkRows || []).map((r) => ({
    id: r.id as string,
    source_type: r.source_type as string,
    source_id: r.source_id as string,
    relation: r.relation as string,
    label: labels.get(`${r.source_type}:${r.source_id}`) ?? null,
  }))

  const publishedBody = doc.content ?? ''
  const tags: string[] = Array.isArray(doc.tags) ? (doc.tags as string[]) : []

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-4">
        <Link href="/account/wiki" className="text-xs text-muted-foreground hover:underline">
          ← Wiki
        </Link>
      </div>

      <header className="mb-6 border-b border-border pb-4">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-3xl font-semibold">{doc.title || '(untitled)'}</h1>
          <div className="flex items-center gap-2">
            <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
              {doc.type}
            </span>
            {doc.published_status === 'draft' && (
              <span className="rounded bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                draft
              </span>
            )}
          </div>
        </div>
        {(tags.length > 0 || doc.slug) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {doc.slug && <span className="font-mono">[[{doc.slug}]]</span>}
            {tags.map((t) => (
              <span key={t} className="rounded bg-muted px-1.5 py-0.5">
                {t}
              </span>
            ))}
          </div>
        )}
      </header>

      <WikiEditor
        documentId={id}
        publishedTitle={doc.title}
        publishedBody={publishedBody}
        initialDraftBody={draftContent}
        draftUpdatedAt={draftUpdatedAt}
        renderedBlocks={blocks}
        canEdit={canEdit}
        publishedRevision={typeof (doc as { revision?: unknown }).revision === 'number' ? (doc as { revision: number }).revision : null}
      />

      {backlinks.length > 0 && (
        <section className="mt-12 border-t border-border pt-6">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Backlinks · {backlinks.length}
          </h2>
          <ul className="space-y-2">
            {backlinks.map((b) => (
              <li key={b.id} className="text-sm">
                <span className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {b.relation}
                </span>
                {b.source_type === 'document' ? (
                  <Link href={`/account/wiki/${b.source_id}`} className="hover:underline">
                    {b.label || b.source_id}
                  </Link>
                ) : (
                  <span>
                    <span className="text-muted-foreground">{b.source_type}:</span> {b.label || b.source_id}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
