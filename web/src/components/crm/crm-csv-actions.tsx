'use client'

/**
 * Export CSV (companies and contacts, what the person can see) and Import CSV
 * (companies: stage, owner, revenue and custom fields filled when their
 * columns are there), in the Companies and Contacts list toolbar (679).
 */
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Download, Upload } from 'lucide-react'
import { downloadFile } from '@/lib/download'

export function CrmCsvActions({ entityType, onImported }: { entityType: string; onImported?: () => void }) {
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  if (entityType !== 'company' && entityType !== 'contact') return null
  const label = entityType === 'company' ? 'companies' : 'contacts'

  const exportCsv = async () => {
    setBusy(true)
    try {
      await downloadFile('/api/account/crm/export', `${label}.csv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: entityType }),
      }, (h) => {
        if (h.get('X-Export-Truncated')) toast('The export holds the first 10,000.')
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  const importCsv = async (file: File) => {
    setBusy(true)
    try {
      const form = new FormData()
      form.set('file', file)
      const res = await fetch('/api/account/companies/import', { method: 'POST', body: form })
      const json = (await res.json().catch(() => ({}))) as { added?: number; updated?: number; skipped?: unknown[]; warnings?: unknown[]; error?: string }
      if (!res.ok) {
        toast.error(json.error ?? 'Import failed')
        return
      }
      const notes = [json.skipped?.length ? `${json.skipped.length} skipped` : null, json.warnings?.length ? `${json.warnings.length} cells not read` : null].filter(Boolean).join(', ')
      toast(`Imported: ${json.added ?? 0} added, ${json.updated ?? 0} updated${notes ? ` (${notes})` : ''}.`)
      onImported?.()
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const btn = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50'
  return (
    <>
      <button type="button" className={btn} onClick={() => void exportCsv()} disabled={busy} title={`Export ${label} as CSV`} aria-label={`Export ${label} as CSV`} data-crm-export={entityType}>
        <Download className="h-3.5 w-3.5" />
      </button>
      {entityType === 'company' && (
        <>
          <button type="button" className={btn} onClick={() => fileRef.current?.click()} disabled={busy} title="Import companies from CSV" aria-label="Import companies from CSV" data-crm-import="">
            <Upload className="h-3.5 w-3.5" />
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && void importCsv(e.target.files[0])} />
        </>
      )}
    </>
  )
}
