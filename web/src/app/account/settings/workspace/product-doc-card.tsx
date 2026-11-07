'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { FileText, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { DocumentSearchPicker, type DocumentOption } from '@/components/documents/document-search-picker'

/** What GET/PUT /api/account/workspace/product-doc answer. */
interface ProductDocView {
  document_id: string
  title: string | null
  updated_at: string | null
  available: boolean
}

const ENDPOINT = '/api/account/workspace/product-doc'

/**
 * Settings → Workspace "Product facts": the document the live agent states
 * product facts from on calls. Owners and admins pick, change or clear it;
 * members see it read-only.
 */
type DocumentRow = { id: string; title: string; published_status?: string; type?: string; frontmatter?: Record<string, unknown> | null }

export function ProductDocCard({ canManage }: { canManage: boolean }) {
  const [doc, setDoc] = useState<ProductDocView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [documents, setDocuments] = useState<DocumentOption[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(ENDPOINT)
      .then((r) => {
        if (!r.ok) throw new Error('load failed')
        return r.json()
      })
      .then((data: { product_doc?: ProductDocView | null } | null) => {
        if (!cancelled) setDoc(data?.product_doc ?? null)
      })
      .catch(() => {
        if (!cancelled) setError('Couldn’t load the product doc')
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The workspace's documents, read only when the picker first opens.
  useEffect(() => {
    if (!pickerOpen || documents !== null) return
    // Docs only: a skill report or a meeting prep is never the product doc (migration 367).
    fetch('/api/account/documents?kind=doc')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { documents?: DocumentRow[] } | null) => {
        setDocuments(
          (data?.documents ?? [])
            // The same docs the server refuses: drafts and spec pages (a meeting prep is a 'prep', left out above).
            .filter((d) => d.published_status !== 'draft' && d.type !== 'spec' && !d.frontmatter?.meeting_prep)
            .map((d) => ({ id: d.id, title: d.title })),
        )
      })
      .catch(() => setDocuments([]))
  }, [pickerOpen, documents])

  const choose = useCallback(async (documentId: string) => {
    setPickerOpen(false)
    setBusy(true)
    setError('')
    try {
      const res = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: documentId }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error ?? 'Couldn’t set the product doc')
      setDoc(data?.product_doc ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t set the product doc')
    } finally {
      setBusy(false)
    }
  }, [])

  const clear = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(ENDPOINT, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error ?? 'Couldn’t clear the product doc')
      }
      setDoc(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t clear the product doc')
    } finally {
      setBusy(false)
    }
  }, [])

  if (!loaded) return null
  // A member with nothing set has nothing to see here.
  if (!doc && !canManage) return null

  return (
    <div id="product-facts" className="scroll-mt-8" data-testid="product-doc-card">
      <Label className="text-sm font-medium">Product facts</Label>
      <p className="text-xs text-muted-foreground">
        Your agent states product facts only from this doc on calls.
      </p>

      <div className="mt-2 rounded-lg border px-4 py-3">
        {doc ? (
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Link
                href={`/account/wiki/${doc.document_id}`}
                className="truncate text-sm font-medium hover:underline"
              >
                {doc.title || 'Untitled document'}
              </Link>
              {!doc.available && (
                <span className="shrink-0 text-xs text-muted-foreground">Not available</span>
              )}
            </div>
            {canManage && (
              <div className="flex shrink-0 items-center gap-1">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={busy}
                  onClick={() => setPickerOpen(true)}
                >
                  Change
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  disabled={busy}
                  onClick={clear}
                >
                  Clear
                </Button>
              </div>
            )}
          </div>
        ) : null}

        {canManage && (!doc || pickerOpen) && (
          <div className={doc ? 'mt-2' : undefined}>
            <DocumentSearchPicker
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              documents={(documents ?? []).filter((d) => d.id !== doc?.document_id)}
              onSelect={choose}
              label={doc ? 'Pick another document' : 'Choose a document'}
            />
          </div>
        )}
      </div>

      {error && <p className="mt-1.5 text-sm text-destructive">{error}</p>}
    </div>
  )
}
