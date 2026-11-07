'use client'

/**
 * The people stage's consent screen (§9, "One press commits both per-company
 * stages, so it names both prices and exposes `people_per_company` inline —
 * setting it to 0 buys research only").
 *
 * It is a dialog rather than a third row of the gate banner for one reason:
 * `people_per_company` is a NUMBER the user edits, and the two things they
 * need beside it — which titles will be searched for, and what the whole thing
 * costs — do not fit in a banner without shrinking the ICP's buyer titles to
 * an ellipsis. The titles are the single most useful thing on this screen: a
 * people search anchored to the wrong roles is money spent on the wrong
 * people, and this is the last moment before it is spent.
 *
 * THE ZERO IS REAL AND IT IS NOT A CANCEL. `people_per_company: 0` is a valid
 * list setting (migration 248's CHECK is `between 0 and 10`) meaning "research
 * only, no people" — so the confirm at 0 is disabled with copy saying what
 * zero means, rather than starting a run that would find nothing and report
 * `0/0`.
 *
 * ONE CALL PER COMPANY, NOT PER PERSON. The estimate multiplies companies, not
 * companies × people, because the engine makes exactly one `category:'people'`
 * search per company and `people_per_company` caps how many of the returned
 * people are KEPT. Quoting per-person would over-quote by 3× and make the
 * cheapest stage read as the most expensive.
 *
 * THE SPARSE WARNING IS NOT OPTIONAL (§7 Stage 4). Exa does not index every
 * profile, and `includeDomains` anchoring restricts retrieval to pages that
 * mention the company — realistic yield is 1–3 people and sometimes zero. A
 * dialog that lets a user set 5 and expect 5 turns a working feature into a
 * bug report on first use.
 */

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { Icp } from '@/lib/prospecting/types'
import { MAX_ENTRIES_PER_TARGETED_RUN } from '@/lib/prospecting/spend'
import {
  companiesLabel,
  estimateMinutesLabel,
} from './ui-helpers'

/** Migration 248: `people_per_company integer CHECK (between 0 and 10)`. The
 *  input clamps to the same band the column will accept, so a typed 40 is
 *  corrected in front of the user rather than 400'd behind them. */
export const MIN_PEOPLE_PER_COMPANY = 0
export const MAX_PEOPLE_PER_COMPANY = 10

/**
 * Clamp a typed people-per-company into the column's band.
 *
 * Mirrors `clampBudgetInput`'s contract, with one deliberate difference: ZERO
 * IS A VALID VALUE here (it means "research only"), so an empty or
 * unparseable field falls back to the list's current setting rather than to
 * the floor — snapping a half-deleted "3" to 0 would silently turn a people
 * run into a no-op.
 */
export function clampPeoplePerCompany(raw: string, fallback: number): number {
  const trimmed = raw.trim()
  if (trimmed === '') return fallback
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_PEOPLE_PER_COMPANY, Math.max(MIN_PEOPLE_PER_COMPANY, Math.floor(n)))
}

export function PeopleDialog({
  open,
  /** How many company entries the run will search at — ALREADY capped by the
   *  parent at `MAX_ENTRIES_PER_TARGETED_RUN`, because the price, the wall
   *  clock and the expected yield on this screen all derive from it and the
   *  parent truncates the selection to that cap before starting the run. */
  companyCount,
  /** The list's stored `people_per_company`, seeding the input. */
  peoplePerCompany,
  /** The ICP as run — its `buyer_titles` ARE the query, so they are shown. */
  icp,
  cappedByRunSize = false,
  busy = false,
  alreadyRunning = false,
  onCancel,
  onConfirm,
}: {
  open: boolean
  companyCount: number
  peoplePerCompany: number
  icp: Icp | null
  /** True when the population was larger than one run holds, so the dialog can
   *  say which part of it this press buys. */
  cappedByRunSize?: boolean
  busy?: boolean
  alreadyRunning?: boolean
  onCancel: () => void
  /** Runs the people stage at this many people per company. The parent
   *  persists the number onto the list when it differs, so the next run
   *  remembers it. */
  onConfirm: (peoplePerCompany: number) => void | Promise<void>
}) {
  // Free text while typing (so a half-deleted field is not snapped), clamped
  // on blur and on confirm.
  const [text, setText] = useState(String(peoplePerCompany))

  useEffect(() => {
    if (open) setText(String(peoplePerCompany))
  }, [open, peoplePerCompany])

  if (!open) return null

  const perCompany = clampPeoplePerCompany(text, peoplePerCompany)
  const titles = (icp?.target.buyer_titles ?? []).filter((t) => t.trim() !== '')
  const target = companyCount * perCompany

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel() }}>
      <DialogContent
        aria-label="Find people"
        className="w-[min(30rem,calc(100vw-2rem))] max-w-[30rem] gap-0 rounded-lg border-border p-4"
      >
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm font-semibold">Find people</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed">
            One search per company, anchored to its own website — so a namesake
            at another company never lands on your list.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 space-y-2.5 rounded-md border border-border bg-muted/20 px-3 py-2.5">
          <p className="text-xs tabular-nums text-muted-foreground">
            {companiesLabel(companyCount)}
          </p>

          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">People per company</span>
            <Input
              type="number"
              min={MIN_PEOPLE_PER_COMPANY}
              max={MAX_PEOPLE_PER_COMPANY}
              step="1"
              aria-label="People per company"
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => setText(String(clampPeoplePerCompany(text, peoplePerCompany)))}
              className="h-7 w-20 text-right text-xs tabular-nums"
            />
          </label>

          <p className="text-[11px] leading-snug text-muted-foreground">
            Between {MIN_PEOPLE_PER_COMPANY} and {MAX_PEOPLE_PER_COMPANY} — how many people we
            keep per company.
          </p>
        </div>

        {titles.length > 0 ? (
          <div className="mt-3 space-y-1.5">
            <p className="text-[11px] text-muted-foreground">Looking for</p>
            <div className="flex flex-wrap gap-1">
              {titles.map((title) => (
                <span
                  key={title}
                  className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {title}
                </span>
              ))}
            </div>
          </div>
        ) : (
          /* No titles is a real state (the investor template leaves them
             blank) and it degrades the search rather than breaking it — say
             so, and point at the fix. */
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Your ICP names no buyer titles, so this searches for whoever the company presents as
            leadership. Adding titles makes it much sharper.
          </p>
        )}

        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {estimateMinutesLabel(companyCount)}. Expect fewer than{' '}
          <span className="tabular-nums">{target}</span> — many companies publish no team page,
          and we only keep people we can verify at that company.
        </p>

        {cappedByRunSize && (
          /* One run holds 50 companies. Saying so here, beside the price it
             changes, keeps the quoted figures binding on what this press
             actually buys. */
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            Searching the first {MAX_ENTRIES_PER_TARGETED_RUN}; press again for the rest.
          </p>
        )}

        {alreadyRunning && (
          <p className="mt-3 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground">
            Already running — showing the run in progress.
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || perCompany === 0 || companyCount === 0}
            title={
              perCompany === 0
                ? 'Zero people per company means research only — nothing to find'
                : undefined
            }
            onClick={() => void onConfirm(perCompany)}
          >
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Find people
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
