'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  EVAL_CANDIDATE_SOURCES,
  EVAL_CANDIDATE_STATUSES,
  type EvalCandidateSource,
  type EvalCandidateStatus,
} from '@/lib/evals/flywheel/types'
import type { FlywheelSkillCase } from '@/lib/evals/flywheel/case-schema'
import { CaseEditor } from './case-editor'
import { Chips, EvidenceView, Facts, Section } from './evidence-view'
import {
  SOURCE_CLASS,
  SOURCE_LABEL,
  STATUS_LABEL,
  candidateSummary,
  formatWhen,
  type AdminEvalCandidate,
} from './labels'

/**
 * The flywheel's review queue (/admin/evals): candidates newest first, by
 * status and source, with each source's count; the selected one's evidence
 * and the reviewer's calls (dismiss, promote into a case, reopen); and the
 * export of promoted cases for scripts/eval-flywheel-import.ts.
 */

type StatusFilter = EvalCandidateStatus | 'all'
type SourceFilter = EvalCandidateSource | 'all'

export function EvalsReview() {
  const [status, setStatus] = useState<StatusFilter>('new')
  const [source, setSource] = useState<SourceFilter>('all')
  const [candidates, setCandidates] = useState<AdminEvalCandidate[]>([])
  const [counts, setCounts] = useState<Partial<Record<EvalCandidateSource, number>>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ status, source, limit: '200' })
      const res = await fetch(`/api/admin/evals/candidates?${qs}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to load candidates')
      const rows = (body.candidates ?? []) as AdminEvalCandidate[]
      setCandidates(rows)
      setCounts(body.counts ?? {})
      setSelectedId((id) => (id && rows.some((r) => r.id === id) ? id : (rows[0]?.id ?? null)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load candidates')
    } finally {
      setLoading(false)
    }
  }, [status, source])

  useEffect(() => {
    void load()
  }, [load])

  const selected = candidates.find((c) => c.id === selectedId) ?? null
  const total = EVAL_CANDIDATE_SOURCES.reduce((n, s) => n + (counts[s] ?? 0), 0)

  async function review(row: AdminEvalCandidate, next: 'new' | 'dismissed' | 'promoted', caseDraft?: { skill: string; case: FlywheelSkillCase }) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/evals/candidates/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(caseDraft ? { status: next, case_draft: caseDraft } : { status: next }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to save')
      setEditing(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setBusy(false)
    }
  }

  // The download is a read; marking is its own POST of exactly the ids downloaded,
  // so a case promoted in between is never marked without being in the file.
  async function exportPromoted(mark: boolean) {
    setExporting(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/evals/export')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Export failed')
      }
      const text = await res.text()
      const cases = JSON.parse(text) as Array<{ candidateId: string }>
      const blob = new Blob([text], { type: 'application/json' })
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'flywheel-cases.json'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      if (mark && cases.length > 0) {
        const marked = await fetch('/api/admin/evals/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidateIds: cases.map((c) => c.candidateId) }),
        })
        if (!marked.ok) {
          const body = await marked.json().catch(() => ({}))
          throw new Error(body.error || 'Downloaded, but marking them exported failed')
        }
        await load()
      }
      setExportOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Filters and export */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-40" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EVAL_CANDIDATE_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </SelectItem>
            ))}
            <SelectItem value="all">All statuses</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto">
          <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export promoted
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Source">
        <SourceTab active={source === 'all'} onClick={() => setSource('all')} label="All" count={total} />
        {EVAL_CANDIDATE_SOURCES.map((s) => (
          <SourceTab key={s} active={source === s} onClick={() => setSource(s)} label={SOURCE_LABEL[s]} count={counts[s] ?? 0} />
        ))}
      </div>

      {error ? (
        <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* The queue */}
        <div className="min-w-0 rounded-xl border bg-card">
          {loading && candidates.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : candidates.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nothing here.</p>
          ) : (
            <ul className="max-h-[70vh] divide-y overflow-y-auto">
              {candidates.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(row.id)
                      setEditing(false)
                    }}
                    className={cn(
                      'block w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/50',
                      row.id === selectedId && 'bg-muted',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <SourceBadge source={row.source} />
                      {status === 'all' ? <span className="text-[10px] text-muted-foreground">{STATUS_LABEL[row.status]}</span> : null}
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{formatWhen(row.created_at)}</span>
                    </div>
                    <p className="mt-1 truncate text-sm">{candidateSummary(row)}</p>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {[row.workspace_name, row.user_email].filter(Boolean).join(' · ') || row.workspace_id}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* The selected candidate */}
        <div className="min-w-0">
          {selected ? (
            <div className="space-y-4 rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <SourceBadge source={selected.source} />
                <span className="text-xs text-muted-foreground">{STATUS_LABEL[selected.status]}</span>
                <div className="ml-auto flex gap-2">
                  {selected.status === 'new' ? (
                    <>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => review(selected, 'dismissed')}>
                        Dismiss
                      </Button>
                      <Button size="sm" disabled={busy || editing} onClick={() => setEditing(true)}>
                        Promote
                      </Button>
                    </>
                  ) : (
                    <>
                      {selected.status === 'exported' ? (
                        <span className="self-center text-xs text-muted-foreground">In the repository since {formatWhen(selected.exported_at)}</span>
                      ) : null}
                      {selected.status === 'promoted' || selected.status === 'exported' ? (
                        <Button variant="ghost" size="sm" disabled={busy || editing} onClick={() => setEditing(true)}>
                          Edit case
                        </Button>
                      ) : null}
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => review(selected, 'new')}>
                        Reopen
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <Facts
                facts={[
                  ['Workspace', selected.workspace_name ?? selected.workspace_id],
                  ['Person', selected.user_email ?? selected.user_id],
                  ['When', formatWhen(selected.created_at)],
                  ['Conversation', selected.conversation_id],
                  ['Ref', selected.ref_type ? `${selected.ref_type}:${selected.ref_id ?? ''}` : null],
                  ['Reviewed', selected.reviewed_at ? formatWhen(selected.reviewed_at) : null],
                ]}
              />

              {editing ? (
                <CaseEditor
                  key={selected.id}
                  row={selected}
                  busy={busy}
                  onCancel={() => setEditing(false)}
                  onSave={(draft) => review(selected, 'promoted', draft)}
                />
              ) : null}

              <EvidenceView row={selected} />

              {selected.tools.length ? (
                <Section title="Tools">
                  <Chips items={selected.tools} />
                </Section>
              ) : null}

              {selected.case_draft && !editing ? (
                <Section title="Saved case">
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2.5 font-mono text-[11px]">
                    {JSON.stringify(selected.case_draft, null, 2)}
                  </pre>
                </Section>
              ) : null}
            </div>
          ) : (
            <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">Pick a candidate.</div>
          )}
        </div>
      </div>

      <AlertDialog open={exportOpen} onOpenChange={setExportOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Export promoted cases</AlertDialogTitle>
            <AlertDialogDescription>
              Downloads every promoted case not yet exported, for scripts/eval-flywheel-import.ts. Marking them exported
              takes them out of the next export; reopening or editing one brings it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={exporting}>Cancel</AlertDialogCancel>
            <Button variant="outline" disabled={exporting} onClick={() => exportPromoted(false)}>
              Download only
            </Button>
            <Button disabled={exporting} onClick={() => exportPromoted(true)}>
              {exporting ? 'Exporting…' : 'Download and mark exported'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SourceBadge({ source }: { source: EvalCandidateSource }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
        SOURCE_CLASS[source] ?? 'border-border text-muted-foreground',
      )}
    >
      {SOURCE_LABEL[source] ?? source}
    </span>
  )
}

function SourceTab({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-xs transition-colors',
        active ? 'border-foreground/20 bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
      )}
    >
      {label} <span className="tabular-nums opacity-70">{count}</span>
    </button>
  )
}
