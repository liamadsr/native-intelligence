'use client'

/**
 * The New-list sheet (§10, Page 2) — a right-side ~520px sheet, not a modal,
 * because it is a document being edited rather than a question being answered.
 *
 * What earns the sheet: the ICP arrives PRE-FILLED from the workspace's own
 * enriched company row, and every seeded field carries a provenance line. The
 * user never types their own company (§4). The four starter templates switch
 * which pre-filled draft is showing — the server hands back one draft per
 * purpose in a single trip, so switching is instant and lossless.
 *
 * The three exclusion toggles carry LIVE COUNTS, which is what makes an
 * abstract switch legible: "Exclude the 412 companies already in your CRM"
 * says what pressing it will do. `exclude_contacted` is a TRI-STATE
 * (off/active/ever), rendered as a segmented control rather than a checkbox,
 * because 'active' is what a re-engagement list needs and a boolean cannot
 * say it.
 *
 * PR 1 SCOPE: the primary button is "Create list" and there is no Find. Nothing
 * in this sheet spends Exa money — discovery arrives in PR 3/4 with its own
 * consent dialog carrying real numbers (§9).
 */

import { useEffect, useMemo, useState } from 'react'
import { Building2, Loader2, Telescope } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import type { IcpDraft } from '@/lib/prospecting/icp'
import type {
  Icp,
  ProspectExcludeContacted,
  ProspectListPurpose,
  ProspectListRow,
} from '@/lib/prospecting/types'
import { IcpEditor } from './icp-editor'
import { DEFAULT_EXCLUDE_CONTACTED } from './ui-helpers'
import {
  createList,
  errorCode,
  errorMessage,
  type ExclusionCountsPayload,
  type SourcePayload,
} from './api'

// ============================================================
// Templates
// ============================================================

/** The four starter templates the sheet leads with (§4). `talent` exists in
 *  the purpose enum but is not offered as a starter card — the spec names four
 *  and a fifth would dilute the choice; it stays reachable through the API. */
export const STARTER_PURPOSES: ProspectListPurpose[] = [
  'buyers',
  'investors',
  'partners',
  'custom',
]

/**
 * Why the Investors template is tagged and the other three are not.
 *
 * Buyers, Partners and Talent all search for COMPANIES against a description
 * of a company, which is what Exa's deep search is actually good at. Fund
 * discovery is a different problem wearing the same shape: a fund's public
 * surface says almost nothing about its thesis, so the angles fall back on the
 * portfolio comparables the user listed (§7's investor angles cite
 * `comparables`) — which means the results are only as good as that list, and
 * a user who left it thin gets plausible-looking funds with no real basis.
 *
 * Nobody has run this at volume. Saying so on the card costs one small word
 * and buys the honest expectation; discovering it from twenty bad funds costs
 * the user their trust in every other template too.
 */
export const EXPERIMENTAL_PURPOSES: ReadonlySet<ProspectListPurpose> = new Set<ProspectListPurpose>([
  'investors',
])

export const EXPERIMENTAL_TOOLTIP =
  'Fund discovery is unproven; results lean on portfolio comparables you list'

/** A small caps tag, quiet enough to sit inside a card title without
 *  competing with it. Exported so the index and the sheet cannot drift. */
export function ExperimentalTag({ className }: { className?: string }) {
  return (
    <span
      title={EXPERIMENTAL_TOOLTIP}
      className={cn(
        'shrink-0 rounded-full border border-border bg-muted/40 px-1.5 py-px text-[9px] font-normal uppercase tracking-wide text-muted-foreground',
        className,
      )}
    >
      Experimental
    </span>
  )
}

/**
 * The four starter templates, in ONE place, in consistent second person.
 *
 * Every surface reads from here — the sheet's template picker, the empty
 * state's four cards, and the default list name — because the production
 * report was that the cards were written in three different voices ("Customers
 * like us" is first person plural, "Products that complement yours" is not a
 * company, "Describe who to find, from scratch" is an instruction to the
 * user). Each blurb now names a COMPANY the search will return, addressed to
 * "you".
 */
export const PURPOSE_META: Record<
  ProspectListPurpose,
  { title: string; blurb: string; defaultName: string }
> = {
  buyers: {
    title: 'Customers',
    blurb: 'Companies like the ones that already buy from you',
    defaultName: 'Customers',
  },
  investors: {
    title: 'Investors',
    blurb: 'Funds that back companies like yours',
    defaultName: 'Investors',
  },
  partners: {
    title: 'Partners',
    blurb: 'Companies whose products complement yours',
    defaultName: 'Partners',
  },
  talent: {
    title: 'Talent',
    blurb: 'Companies whose people you would want to hire',
    defaultName: 'Talent',
  },
  custom: {
    title: 'Custom',
    blurb: "Tell us who you're looking for",
    defaultName: 'New list',
  },
}

/**
 * The one-line footer under every template card.
 *
 * Liam pressed Investors and got the sheet: "what was the point of selecting
 * it from there?" The flow is unchanged on purpose — this makes its INTENT
 * legible. The card is not the search; it is the thing that fills the search
 * in, and the sheet after it is a review of that fill.
 */
export const TEMPLATE_CARD_FOOTER =
  'Pre-fills who to find from your profile · edit before the first search'

/** "Investors — review who to find". The sheet is a REVIEW step after a card
 *  chose the template, not a second place to answer the same question. */
export function sheetTitleFor(purpose: ProspectListPurpose): string {
  return `${PURPOSE_META[purpose].title} — review who to find`
}

// ============================================================
// Exclusion controls
// ============================================================

const CONTACTED_OPTIONS: Array<{
  value: ProspectExcludeContacted
  label: string
  hint: string
}> = [
  { value: 'off', label: 'Off', hint: 'Ignore who you have contacted' },
  { value: 'active', label: 'Active', hint: 'Hide people in a live sequence' },
  { value: 'ever', label: 'Ever', hint: 'Hide anyone ever enrolled' },
]

function ExclusionToggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  children: React.ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/40">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
      />
      <span className="min-w-0 flex-1 leading-relaxed">{children}</span>
    </label>
  )
}

// ============================================================
// The sheet
// ============================================================

export function NewListSheet({
  open,
  source,
  initialPurpose,
  onClose,
  onCreated,
}: {
  open: boolean
  /** GET /source's payload — drafts, the company row, and the live counts.
   *  Null while it is still loading, or when nothing resolved. */
  source: SourcePayload | null
  /** Which starter card was pressed. */
  initialPurpose: ProspectListPurpose
  onClose: () => void
  /** The created list — the caller opens it (a real history step). */
  onCreated: (list: ProspectListRow) => void
}) {
  const [purpose, setPurpose] = useState<ProspectListPurpose>(initialPurpose)
  const [name, setName] = useState('')
  const [icp, setIcp] = useState<Icp | null>(null)
  const [excludeCrm, setExcludeCrm] = useState(true)
  const [excludeOtherLists, setExcludeOtherLists] = useState(false)
  // 'ever' for EVERY template, matching migration 248's column default and
  // §3 ("a list is for NEW people"). 'active' is the re-engagement setting and
  // is opted into, never landed on by accident.
  const [excludeContacted, setExcludeContacted] =
    useState<ProspectExcludeContacted>(DEFAULT_EXCLUDE_CONTACTED)
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  // The name is only auto-followed while the user has not typed one — a
  // template switch must never overwrite a name someone chose.
  const [nameTouched, setNameTouched] = useState(false)

  const draft: IcpDraft | null = useMemo(
    () => source?.icp_draft_by_purpose?.[purpose] ?? null,
    [source, purpose],
  )

  // Re-seed on open and on every template switch. Depending on `draft` (not
  // `source`) means a payload refresh that leaves this purpose's draft
  // identical does not stomp edits in progress.
  useEffect(() => {
    if (!open) return
    setPurpose(initialPurpose)
  }, [open, initialPurpose])

  useEffect(() => {
    if (!open || !draft) return
    setIcp(draft.icp)
  }, [open, draft])

  useEffect(() => {
    if (!open || nameTouched) return
    setName(PURPOSE_META[purpose].defaultName)
  }, [open, purpose, nameTouched])

  // A fresh open starts fresh: a name typed and abandoned last time must not
  // reappear pre-filled under a different template, and neither must exclusion
  // settings the user changed and then cancelled out of — the next list would
  // silently inherit them, which is exactly the kind of invisible carry-over
  // that made 'active' look like the default.
  useEffect(() => {
    if (open) return
    setNameTouched(false)
    setNameError(null)
    setExcludeCrm(true)
    setExcludeOtherLists(false)
    setExcludeContacted(DEFAULT_EXCLUDE_CONTACTED)
  }, [open])

  if (!open) return null

  const counts: ExclusionCountsPayload = source?.counts ?? {
    crm_companies: 0,
    other_lists: 0,
    contacted_people: 0,
  }
  const contactedMeta = CONTACTED_OPTIONS.find((o) => o.value === excludeContacted)

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError('Give the list a name')
      return
    }
    if (!icp) return
    setSaving(true)
    setNameError(null)
    try {
      const list = await createList({
        name: trimmed,
        purpose,
        icp,
        source_company_id: source?.source?.id ?? null,
        exclude_crm: excludeCrm,
        exclude_other_lists: excludeOtherLists,
        exclude_contacted: excludeContacted,
      })
      onCreated(list)
    } catch (err) {
      // A duplicate name is fixed in one keystroke — it belongs under the
      // field, not in a toast the user has to remember while retyping.
      if (errorCode(err) === 'LIST_NAME_TAKEN') {
        setNameError('You already have a list with that name')
      } else {
        toast.error(errorMessage(err, 'Could not create the list'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    /* PORTALED, not in-tree. The dashboard shell puts content and chat in
       sibling columns with their own stacking contexts, so an in-tree
       `fixed` panel is painted OVER by the chat dock and its footer becomes
       unclickable. Radix's Sheet portals to document.body, which is also
       where every other overlay in the app lives — and it brings Escape,
       focus trapping and scroll locking with it. */
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <SheetContent
        side="right"
        aria-label="New prospect list"
        /* No SheetDescription: the sheet's subject is the form itself. Radix
           warns unless the omission is declared. */
        aria-describedby={undefined}
        /* The primitive's default is `w-3/4 sm:max-w-sm` with p-6; this sheet
           owns its own header/body/footer chrome, so the padding is dropped
           and the width pinned at the spec's ~520px. `flex h-full flex-col`
           is what lets the body scroll: it gives the `min-h-0 flex-1` body a
           bounded parent. */
        className="flex h-full w-full max-w-[520px] flex-col gap-0 border-l border-border p-0 sm:max-w-[520px]"
      >
        {/* ── Header ── */}
        <SheetHeader className="flex h-12 shrink-0 flex-row items-center gap-2 space-y-0 border-b border-border px-4 text-left">
          <Telescope className="h-4 w-4 shrink-0 text-muted-foreground" />
          <SheetTitle className="truncate text-sm font-semibold">{sheetTitleFor(purpose)}</SheetTitle>
        </SheetHeader>

        {/* ── Body ── */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {/* Template switcher */}
          <div className="grid grid-cols-2 gap-1.5">
            {STARTER_PURPOSES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPurpose(p)}
                aria-pressed={p === purpose}
                className={cn(
                  'rounded-md border px-2.5 py-2 text-left transition-colors',
                  p === purpose
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border hover:bg-muted/40',
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-xs font-medium">
                    {PURPOSE_META[p].title}
                  </span>
                  {EXPERIMENTAL_PURPOSES.has(p) && <ExperimentalTag />}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  {PURPOSE_META[p].blurb}
                </span>
              </button>
            ))}
          </div>

          {/* Name */}
          <div className="space-y-1 px-2">
            <label htmlFor="prospect-list-name" className="block text-xs text-muted-foreground">
              List name
            </label>
            <Input
              id="prospect-list-name"
              value={name}
              onChange={(e) => {
                setNameTouched(true)
                setName(e.target.value)
                if (nameError) setNameError(null)
              }}
              className="h-8 text-sm"
            />
            {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          </div>

          {/* Source company line — what the pre-fill came from, and the
              correction affordance. A WRONG source company silently mis-seeds
              every ICP in the workspace, so this ships from day one (§4). */}
          {source?.source && (
            <div className="flex items-start gap-2 rounded-md border border-dashed border-border px-3 py-2">
              <Building2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
                Pre-filled from{' '}
                <span className="font-medium text-foreground">
                  {source.source.name || source.source.domain}
                </span>
                . Not your company? Close this sheet and use{' '}
                <span className="font-medium text-foreground">Not your company?</span> on the
                company card to point Prospecting at the right website.
              </div>
            </div>
          )}

          {/* The ICP */}
          {icp ? (
            <IcpEditor
              icp={icp}
              provenance={draft?.provenance ?? {}}
              onChange={setIcp}
            />
          ) : (
            <div className="flex items-center gap-2 px-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading your company profile…
            </div>
          )}

          {/* Exclusions — the counts are what make the switches legible. */}
          <section className="space-y-0.5">
            <h3 className="px-2 text-sm font-medium">What to skip</h3>
            <ExclusionToggle checked={excludeCrm} onChange={setExcludeCrm}>
              Exclude the{' '}
              <span className="font-medium tabular-nums">{counts.crm_companies}</span>{' '}
              {counts.crm_companies === 1 ? 'company' : 'companies'} already in your CRM
            </ExclusionToggle>
            <ExclusionToggle checked={excludeOtherLists} onChange={setExcludeOtherLists}>
              Exclude anything in your{' '}
              <span className="font-medium tabular-nums">{counts.other_lists}</span> other{' '}
              {counts.other_lists === 1 ? 'list' : 'lists'}
            </ExclusionToggle>

            <div className="rounded-md px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="leading-relaxed">
                  Exclude people you&apos;ve contacted (
                  <span className="font-medium tabular-nums">{counts.contacted_people}</span>)
                </span>
                <div
                  role="group"
                  aria-label="Exclude contacted"
                  className="ml-auto inline-flex rounded-md border border-border p-0.5"
                >
                  {CONTACTED_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={excludeContacted === option.value}
                      title={option.hint}
                      onClick={() => setExcludeContacted(option.value)}
                      className={cn(
                        'rounded-[3px] px-2 py-0.5 text-xs transition-colors',
                        excludeContacted === option.value
                          ? 'bg-muted font-medium text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              {contactedMeta && (
                <p className="mt-1 text-[11px] text-muted-foreground">{contactedMeta.hint}</p>
              )}
            </div>
          </section>
        </div>

        {/* ── Footer. Outside the scrolling body, so "Create list" is always
               reachable however long the ICP grows. ── */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={saving || !icp}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Create list
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
