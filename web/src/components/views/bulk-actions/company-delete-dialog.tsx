'use client'

import * as React from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export interface CompanyDeleteResult {
  companies: number
  contacts: number
}

interface CompanyDeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyIds: string[]
  /** Shown in the title for the single-company case. */
  companyName?: string
  onDeleted: (result: CompanyDeleteResult) => void
}

/**
 * Confirmation for the company cascade delete — deleting a company deletes
 * every contact filed under it, so the generic "N item(s)" confirm is not
 * enough: the user must see exactly how many PEOPLE go with the companies
 * before they can confirm.
 *
 * On open it dry-runs POST /api/account/companies/bulk-delete to get the real
 * counts; the Delete button stays disabled until they arrive. Composes the
 * same AlertDialog as every other delete flow — never `window.confirm` (the
 * desktop WebView patches it to an async dialog that returns a truthy
 * Promise, so the guarded action would run before the user answers).
 */
export function CompanyDeleteDialog({
  open,
  onOpenChange,
  companyIds,
  companyName,
  onDeleted,
}: CompanyDeleteDialogProps) {
  const [counts, setCounts] = React.useState<CompanyDeleteResult | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Key the ids by content so reopening with the same selection still re-runs
  // the dry run (counts can change between opens — a contact added meanwhile).
  const idsKey = companyIds.join(',')

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setCounts(null)
    setError(null)
    fetch('/api/account/companies/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: idsKey.split(',').filter(Boolean), dry_run: true }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error || `HTTP ${res.status}`)
        }
        return res.json() as Promise<CompanyDeleteResult>
      })
      .then((data) => {
        if (!cancelled) setCounts(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to count people')
      })
    return () => {
      cancelled = true
    }
  }, [open, idsKey])

  async function handleConfirm() {
    if (!counts || deleting) return
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch('/api/account/companies/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: companyIds }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      const result = (await res.json()) as CompanyDeleteResult
      onDeleted(result)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  const single = companyIds.length === 1
  // Title count follows the dry-run-verified number once it arrives — the
  // snapshotted selection may include companies deleted elsewhere meanwhile,
  // and the title must not disagree with the description's counts.
  const companyCount = counts?.companies ?? companyIds.length
  const title = single
    ? `Delete ${companyName || 'this company'}?`
    : `Delete ${companyCount} companies?`

  let description: string
  if (!counts) {
    description = ''
  } else if (counts.contacts === 0) {
    description = single
      ? 'This company has no people. It will be permanently deleted. This cannot be undone.'
      : 'These companies have no people. They will be permanently deleted. This cannot be undone.'
  } else {
    const people = `${counts.contacts} ${counts.contacts === 1 ? 'person' : 'people'}`
    description = single
      ? `This will permanently delete this company and its ${people}, including their interaction history. This cannot be undone.`
      : `This will permanently delete ${counts.companies} companies and their ${people}, including their interaction history. This cannot be undone.`
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!deleting) onOpenChange(next) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {counts ? description : (
              <span className="text-muted-foreground">Counting people…</span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            // preventDefault keeps the dialog open through the async delete
            // (Radix closes on Action click by default) — it must survive to
            // show an error, and must not close before the request lands.
            onClick={(e) => {
              e.preventDefault()
              void handleConfirm()
            }}
            // Disabled until the dry run resolves: confirming without the
            // counts on screen would defeat the whole point of this dialog.
            disabled={!counts || deleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
