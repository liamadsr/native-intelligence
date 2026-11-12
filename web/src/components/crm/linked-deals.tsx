'use client'

/**
 * A company's or a contact's Deals tab (Tables, phase 7): the pipeline rows
 * whose Company or Contacts links it, read from their relation edges
 * (/api/account/pipelines/deals). Each shows its stage (won and lost marked),
 * its pipeline, value and expected close; a click opens it in its pipeline
 * on the Deals page, in the row panel.
 */
import { useEffect, useState } from 'react'
import { CircleDollarSign } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { cn } from '@/lib/utils'
import { formatDealValue, formatDealTotals } from '@/lib/crm/deal-format'
import { openTarget } from '@/lib/chat-cards/open-card'
import type { StageOutcome } from '@/lib/crm/custom-field-types'

export interface LinkedDeal {
  id: string
  name: string
  pipeline_id: string
  pipeline: string | null
  stage: string | null
  status: StageOutcome
  value: number | null
  currency: string
  expected_close_date: string | null
  updated_at: string
}

/** The list itself, given its deals (the tab reads them; a screenshot passes them). */
export function LinkedDealsList({ deals, onOpen }: { deals: readonly LinkedDeal[]; onOpen: (deal: LinkedDeal) => void }) {
  const open = deals.filter((d) => d.status === 'open')
  const pipelines = new Set(deals.map((d) => d.pipeline_id))
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6" data-linked-deals="">
      {open.length > 0 && (
        <p className="py-2 text-xs text-muted-foreground">
          {open.length} open{formatDealTotals(open) ? ` · ${formatDealTotals(open)}` : ''}
        </p>
      )}
      <ul className="divide-y divide-border">
        {deals.map((d) => (
          <li key={d.id}>
            <button type="button" onClick={() => onOpen(d)} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-muted/40" data-deal-row={d.id}>
              <CircleDollarSign
                aria-hidden
                className={cn('h-4 w-4 shrink-0', d.status === 'won' ? 'text-emerald-500' : d.status === 'lost' ? 'text-muted-foreground/50' : 'text-muted-foreground')}
              />
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-sm font-medium', d.status === 'lost' ? 'text-muted-foreground' : 'text-foreground')}>{d.name || 'Untitled deal'}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[d.stage ?? 'No stage', pipelines.size > 1 ? d.pipeline : null].filter(Boolean).join(' · ')}
                </span>
              </span>
              {d.expected_close_date && <span className="shrink-0 text-xs text-muted-foreground">{format(parseISO(d.expected_close_date), 'MMM d')}</span>}
              <span className="w-20 shrink-0 text-right text-sm tabular-nums text-foreground/80">{formatDealValue(d.value, d.currency)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function LinkedDeals({ target }: { target: { kind: 'company' | 'contact'; id: string } }) {
  const [deals, setDeals] = useState<LinkedDeal[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setDeals(null)
    void fetch(`/api/account/pipelines/deals?${target.kind}_id=${encodeURIComponent(target.id)}`)
      .then(async (r) => {
        const json = (await r.json().catch(() => ({}))) as { deals?: LinkedDeal[]; error?: string }
        if (!live) return
        if (!r.ok) setError(json.error || 'Could not load deals')
        else setDeals(json.deals ?? [])
      })
      .catch(() => live && setError('Could not load deals'))
    return () => {
      live = false
    }
  }, [target.kind, target.id])

  if (error) return <p className="px-5 py-10 text-center text-sm text-destructive">{error}</p>
  if (!deals) return <p className="px-5 py-10 text-center text-sm text-muted-foreground">Loading…</p>
  if (!deals.length) {
    return (
      <p className="px-5 py-10 text-center text-sm text-muted-foreground">
        No deals yet. A deal shows here once its {target.kind === 'company' ? 'Company' : 'Contacts'} names this {target.kind}.
      </p>
    )
  }
  return <LinkedDealsList deals={deals} onOpen={(d) => openTarget({ type: 'deal', id: d.id, title: d.name, pipelineId: d.pipeline_id }, { from: 'link' })} />
}
