'use client'

import { PageTitle } from '@/components/views/page-title'

/**
 * Prospecting — the view mounted by tab-content for `view: 'prospecting'`.
 *
 * Renders the lists index or one list's detail depending on the tab location,
 * exactly like SequencesView: a `{ kind: 'prospect_list', id }` location
 * renders the detail page, the bare view renders the index — so opening a list
 * is a real history step and Back returns to the index.
 *
 * PROP CONTRACT (what tab-content passes; do not change):
 *
 *   listId              — from the tab location; non-null renders the detail
 *   onOpenList(id,name) — push a detail history entry
 *   onListNameLoaded    — deep links arrive with the placeholder name
 *                         'Prospect list'; called once the real name is known
 *                         so the tab label + Recently viewed adopt it
 *   onCloseDetail       — return to the index as a history step
 *
 * Because the page renders its OWN header (ViewHeader, which draws the nav
 * toggle), 'prospecting' is in tab-content's VIEWS_WITH_OWN_HEADER — BOTH
 * branches must therefore keep rendering a ViewHeader, or the nav toggle
 * vanishes (a documented historical bug; omitting the header while staying out
 * of that set produces the inverse, a doubled header).
 *
 * THE EMPTY STATE IS THE POINT. It is what earns the whole pre-fill wedge
 * (§4): the workspace's own company is already created and enriched at signup,
 * so the first thing a user sees is a sentence about their own business and
 * four ways to answer "who should we find?" — never a blank ICP form.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Building2, Loader2, Plus, Sparkles, Telescope } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { UnifiedViewLayout } from '@/components/views/unified-view-layout'
import { publishProspectListLive, useProspectEntryActionTarget } from '@/components/views/list/entity-row'
import { onEntityDeleted } from '@/lib/entity-events'
import type { ProspectListWithCounts } from '@/lib/prospecting/lists'
import { type ProspectListPurpose } from '@/lib/prospecting/types'
import { ViewHeader } from '../views/view-header'
import { BetaPill } from './beta-pill'
import { ListDetail } from './list-detail'
import {
  EXPERIMENTAL_PURPOSES,
  ExperimentalTag,
  NewListSheet,
  PURPOSE_META,
  STARTER_PURPOSES,
  TEMPLATE_CARD_FOOTER,
} from './new-list-sheet'
import { useActiveRuns } from './use-active-runs'
import { startProspectingChat } from './start-event'
import {
  enrichmentSettled,
  hasIcpCard,
  sourceDomainErrorMessage,
} from './ui-helpers'
import {
  createList,
  errorCode,
  errorMessage,
  fetchLists,
  fetchSource,
  researchSource,
  saveCompanyDescription,
  type SourcePayload,
} from './api'

// ============================================================
// Empty state
// ============================================================

/**
 * "Learn about my company" — the door into Scout, the prospecting agent.
 *
 * ONE component for both empty states, because it is one act (hand the page's
 * context to the agent and let it drive), and the only thing that differs
 * between the two callers is what it already knows: a domain or nothing, a
 * source company or none. Both ride in the event detail so Scout's seeded first
 * turn can say "Domain: dial8.ai. Source company established: yes" rather than
 * re-asking the page a question the page can already answer.
 *
 * It DISPATCHES rather than navigating: chat stays in the tab the user is on
 * (the docked strip beside this page), which is the whole point — the list the
 * agent builds appears on the screen they are already looking at.
 *
 * Two visual weights, one behaviour:
 *
 *   - `variant: 'primary'` on the no-source card. The form beside it is the
 *     typing path and stays a real submit; this one is the GUIDED path, and it
 *     is the one that should read as "press this if you'd rather be asked".
 *   - `variant: 'quiet'` on the company card, where the company is already
 *     researched and the agent is an offer, not the next step.
 */
function LearnAboutMyCompanyButton({
  domain,
  sourceEstablished,
  variant,
}: {
  /** Whatever the page already knows — a typed/suggested domain, or null when
   *  there is nothing to hand over and the agent must ask. */
  domain: string | null
  sourceEstablished: boolean
  variant: 'primary' | 'quiet'
}) {
  const start = () => startProspectingChat({ domain, sourceEstablished })

  if (variant === 'quiet') {
    return (
      <button
        type="button"
        onClick={start}
        className="inline-flex items-center gap-1.5 pt-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Sparkles className="h-3 w-3" />
        Learn about my company
      </button>
    )
  }

  return (
    <Button size="sm" className="h-8" onClick={start}>
      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
      Learn about my company
    </Button>
  )
}

/**
 * The domain field, shared by the "We don't know your company yet" card and
 * the "Not your company?" correction on the company card.
 *
 * ONE component for both because they are the same act — naming the workspace's
 * company by its website — and the route treats them identically: a domain that
 * differs from the currently flagged row re-points the workspace. Two inputs
 * with two copies of the submit/enter/error wiring is how the correction path
 * silently drifts out of parity with the path everyone tests.
 *
 * The button label follows the input, not the caller: a PRE-FILLED field means
 * the user is confirming a guess we made from their email address, and
 * "Research my company" is the honest verb for pressing a button we filled in.
 * An empty field means they are telling us something we do not know, and "Use
 * this company" is the honest verb for that.
 */
function SourceDomainForm({
  value,
  onChange,
  onSubmit,
  submitting,
  error,
  prefilled,
  autoFocus,
  onCancel,
}: {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  submitting: boolean
  /** Inline, beside the field — never a toast. Every one of these codes is a
   *  correction the user makes by editing the field they are looking at. */
  error: string | null
  prefilled: boolean
  autoFocus?: boolean
  onCancel?: () => void
}) {
  return (
    <div className="w-full space-y-1.5">
      <label
        htmlFor="prospecting-source-domain"
        className="block text-left text-xs text-muted-foreground"
      >
        Your company&apos;s website
      </label>
      <div className="flex items-center gap-2">
        <Input
          id="prospecting-source-domain"
          autoFocus={autoFocus}
          value={value}
          placeholder="acme.com"
          aria-label="Your company's website"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // The same guard as the button: no second POST while one is in
            // flight, and no empty-domain POST.
            if (e.key === 'Enter' && !submitting && value.trim() !== '') onSubmit()
            if (e.key === 'Escape') onCancel?.()
          }}
          className="h-8 text-sm"
        />
        <Button
          size="sm"
          className="h-8 shrink-0"
          onClick={onSubmit}
          disabled={submitting || value.trim() === ''}
        >
          {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {prefilled ? 'Research my company' : 'Use this company'}
        </Button>
      </div>
      {error && <p className="text-left text-xs text-destructive">{error}</p>}
    </div>
  )
}

/**
 * "Researching dial8.ai · reading your site for what you sell and who buys it
 * — about a minute."
 *
 * It is a LINE, not a spinner over the page, because the enrichment is a
 * background job and the user can do something useful in the meantime (the
 * company card renders from the row the moment it exists; only the "You sell X
 * to Y" half waits).
 *
 * WHY IT SAYS ALL THAT. The production report was "it was loading but I wasn't
 * sure what it was loading" — a bare "Researching dial8.ai…" names the subject
 * and nothing else: not what is being read, not what will change on screen when
 * it finishes, not how long to wait. All three are one sentence, and all three
 * are what turn an indefinite spinner into a wait somebody is willing to sit
 * through.
 */
function ResearchingLine({ domain }: { domain: string }) {
  return (
    <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
      <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
      <span>
        Researching {domain} · reading your site for what you sell and who buys it — about a
        minute.
      </span>
    </p>
  )
}

/**
 * The timeout line: the poll gave up at 3 minutes and the enrichment is still
 * not terminal.
 *
 * It offers a REFRESH rather than a retry, because the job is still queued
 * server-side — re-POSTing would find the row `pending` and answer 'already',
 * i.e. do nothing while looking like an action. One re-read of GET /source is
 * the honest control.
 */
function StillResearchingLine({ onRefresh }: { onRefresh: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      Still researching — check back in a minute
      <button
        type="button"
        onClick={onRefresh}
        className="text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80"
      >
        Refresh
      </button>
    </p>
  )
}

/**
 * "We found dial8.ai but couldn't tell what you sell. Tell us in a sentence:"
 *
 * The replacement for "We know your company, but not yet what it sells", which
 * Liam read as confusing — it is a statement about our own failure with no way
 * out of it, shown at the exact moment the user is waiting to be asked
 * something. This asks.
 *
 * What it saves is `company.description`, which is the SECOND link in
 * `buildIcpDraft`'s `what_we_sell` chain (blob products_and_services →
 * description → industry). One sentence here therefore seeds every ICP draft on
 * the next GET /source, and lands on the company record in the CRM rather than
 * in a prospecting-only corner the user can never find again.
 */
function WhatWeSellPrompt({
  domain,
  onSave,
}: {
  domain: string
  onSave: (description: string) => Promise<void>
}) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = value.trim()
    if (!trimmed || saving) return
    setSaving(true)
    setError(null)
    try {
      await onSave(trimmed)
    } catch {
      setError('Could not save that just now')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="text-base leading-relaxed text-muted-foreground">
        We found <span className="font-medium text-foreground">{domain}</span> but couldn&apos;t
        tell what you sell. Tell us in a sentence:
      </p>
      <div className="flex items-center gap-2">
        <Input
          id="prospecting-what-we-sell"
          value={value}
          autoComplete="off"
          placeholder="e.g. an AI meeting-capture and CRM workspace"
          aria-label="What you sell"
          onChange={(e) => {
            setValue(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          className="h-8 text-sm"
        />
        <Button
          size="sm"
          className="h-8 shrink-0"
          onClick={() => void submit()}
          disabled={saving || value.trim() === ''}
        >
          {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Save
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/**
 * The Custom starter card — an inline box, not a straight jump to the sheet.
 *
 * "I clicked Investors and it opened the side panel — what was the point of
 * selecting it from there?" The three PRE-FILLED templates genuinely earn the
 * sheet: there is a seeded draft to review before spending anything. Custom
 * seeds NOTHING (`ICP_PURPOSE_TEMPLATES.custom` has a blank description), so
 * the sheet it opens is a form asking the one question this box asks in one
 * line. The full editor stays one link away, and the created list's ICP chip
 * still opens it — nothing is removed.
 */
function CustomStarterCard({
  onCreate,
  onOpenSheet,
}: {
  onCreate: (text: string) => Promise<void>
  onOpenSheet: () => void
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = value.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(trimmed)
    } catch {
      setError('Could not create that list')
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-border p-3 text-left">
      <span className="block text-sm font-medium">{PURPOSE_META.custom.title}</span>
      <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
        {PURPOSE_META.custom.blurb}
      </span>
      <div className="mt-2 flex items-center gap-2">
        <Input
          id="prospecting-custom-target"
          value={value}
          autoComplete="off"
          placeholder="e.g. companies with big sales teams"
          aria-label="Who to find"
          onChange={(e) => {
            setValue(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          className="h-8 text-sm"
        />
        <Button
          size="sm"
          className="h-8 shrink-0"
          onClick={() => void submit()}
          disabled={busy || value.trim() === ''}
        >
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Find
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[11px] leading-snug text-muted-foreground">
          {TEMPLATE_CARD_FOOTER}
        </span>
        <button
          type="button"
          onClick={onOpenSheet}
          className="text-[11px] text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
        >
          Open full editor
        </button>
      </div>
    </div>
  )
}

/**
 * The pre-filled company card + the four starter cards.
 *
 * The sentence is assembled from the SOURCE COMPANY's own enrichment — "You
 * sell X to Y. Who should we find?" — which is the whole reason the ICP card
 * fires. Its two halves come from the `buyers` draft, which is where
 * `buildIcpDraft` puts `what_we_sell` and the card's `targetCustomer`.
 */
function EmptyState({
  source,
  researching,
  researchingDomain,
  researchTimedOut,
  onRefresh,
  onSaveWhatWeSell,
  onCreateCustom,
  domain,
  onDomainChange,
  domainError,
  onSubmitDomain,
  establishedNonce,
  onResearch,
  onStart,
}: {
  source: SourcePayload | null
  researching: boolean
  /** Non-null while a POST has landed and the enrichment is still in flight. */
  researchingDomain: string | null
  /** The poll hit its 3-minute cap without the enrichment going terminal. */
  researchTimedOut: boolean
  /** Re-read GET /source once, from the timeout line's Refresh. */
  onRefresh: () => void
  /** PATCH the workspace company's description with what the user typed. */
  onSaveWhatWeSell: (description: string) => Promise<void>
  /** Create + open a custom list straight from the card's inline box. */
  onCreateCustom: (text: string) => Promise<void>
  domain: string
  onDomainChange: (next: string) => void
  domainError: string | null
  onSubmitDomain: () => void
  /**
   * Bumped by the parent on every SUCCESSFUL establish. The correction panel
   * watches it to close itself: without this the panel stays open showing the
   * domain the user just submitted, so a re-point that WORKED looks identical
   * to one that did nothing, and a second Enter re-POSTs it.
   */
  establishedNonce: number
  onResearch: () => void
  onStart: (purpose: ProspectListPurpose) => void
}) {
  const company = source?.source ?? null
  const buyersIcp = source?.icp_draft_by_purpose?.buyers?.icp ?? null
  const whatWeSell = buyersIcp?.source.what_we_sell?.trim() ?? ''
  const targetCustomer = buyersIcp?.target.description?.trim() ?? ''
  // The ICP card is what fills `target.description` from the web. With no card
  // the description falls back to a purpose template, which is a sentence we
  // wrote — not something to present as knowledge about their business.
  const hasCard = hasIcpCard(source)
  const [correcting, setCorrecting] = useState(false)

  // A successful establish closes the correction panel. The card behind it has
  // already re-rendered with the new company, and leaving the field open over
  // the top of it is what makes a working re-point read as a no-op.
  useEffect(() => {
    if (establishedNonce > 0) setCorrecting(false)
  }, [establishedNonce])

  // §10: "No source company" is REQUIRED, not optional — company enrichment
  // has hung in production before, and on exactly those workspaces the entire
  // pre-fill wedge evaporates.
  //
  // THE MISSING AFFORDANCE (the production bug this state shipped with): the
  // button alone did nothing on a workspace with zero companies, because there
  // was no company for the resolver to find and no way to name one. The input
  // IS the fix — a business signup gets it pre-filled from their own address
  // and presses one button; everyone else types a domain.
  if (!company) {
    const suggested = source?.suggested_domain ?? null
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-6 py-16 text-center">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Building2 className="h-4 w-4" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">We don&apos;t know your company yet</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Prospecting starts from what you sell and who already buys it. Research your
            company once and every list you make is pre-filled from it.
          </p>
        </div>
        <SourceDomainForm
          value={domain}
          onChange={onDomainChange}
          onSubmit={onSubmitDomain}
          submitting={researching}
          error={domainError}
          prefilled={Boolean(suggested) && domain.trim() === suggested}
        />
        {/* The guided path, beside the typing path. It hands Scout the
            SUGGESTED domain rather than whatever is in the field: the field is
            the user mid-edit, and a half-typed 'dial8.a' is worse than null —
            null makes the agent ask, a wrong domain makes it research the
            wrong company. */}
        <LearnAboutMyCompanyButton
          domain={suggested}
          sourceEstablished={false}
          variant="primary"
        />
        {researchingDomain && <ResearchingLine domain={researchingDomain} />}
        {!researchingDomain && researchTimedOut && (
          <StillResearchingLine onRefresh={onRefresh} />
        )}
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 px-6 py-14">
      {/* The pre-filled company card. */}
      <div className="space-y-2 rounded-lg border border-border p-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Building2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{company.name || company.domain}</span>
          {/* The correction affordance, from day one (§4): a WRONG source
              company silently mis-seeds every ICP in the workspace, and until
              now the only remedy named was "edit the company record in your
              CRM" — which does not clear the flag. This re-points it. */}
          <button
            type="button"
            onClick={() => setCorrecting((open) => !open)}
            aria-expanded={correcting}
            className="ml-auto shrink-0 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Not your company?
          </button>
        </div>
        {correcting && (
          <div className="pb-1">
            <SourceDomainForm
              value={domain}
              onChange={onDomainChange}
              onSubmit={onSubmitDomain}
              submitting={researching}
              error={domainError}
              prefilled={false}
              autoFocus
              onCancel={() => setCorrecting(false)}
            />
          </div>
        )}
        {/* ── The what-we-sell line, in three states ──

            The one it replaced ("We know your company, but not yet what it
            sells") was a single sentence covering two completely different
            situations: a job still running, and a job that finished and found
            nothing. The first needs patience, the second needs the user. Saying
            the same thing in both is what made it read as confusing. */}
        {whatWeSell ? (
          <p className="text-base leading-relaxed">
            You sell <span className="font-medium">{whatWeSell}</span>
            {hasCard && targetCustomer ? (
              <>
                {' '}
                to <span className="font-medium">{targetCustomer}</span>
              </>
            ) : null}
            .
          </p>
        ) : researchingDomain ? (
          // In flight: the researching line below already says what is
          // happening, so this half stays silent rather than announcing a gap
          // that is about to fill itself.
          null
        ) : (
          <WhatWeSellPrompt
            domain={company.domain || company.name || 'your company'}
            onSave={onSaveWhatWeSell}
          />
        )}
        <p className="text-base font-medium">Who should we find?</p>

        {/* THE ANSWER TO THAT QUESTION IS THE PRIMARY BUTTON.
            It used to be quiet, on the reasoning that a known company makes
            Scout an offer rather than the next step. That got the ordering
            backwards: the four cards below are TEMPLATES — they ask the user
            to already know which of investors/customers/partners they want and
            to phrase it — whereas "Who should we find?" is a question, and a
            conversation is the only thing on this screen that can answer a
            question. So the guided path is the default and the templates
            become the alternative ("or start one yourself", below the grid's
            own line). Nothing is removed: every card still works untouched. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
          <LearnAboutMyCompanyButton
            domain={company.domain ?? null}
            sourceEstablished
            variant="primary"
          />
          {/* Quiet refresh when the ICP card has not run — it is a $0.01 side
              search, so it is an affordance, not a banner. It POSTs with NO
              domain: the company already resolved, so this is the existing
              "research what we found" path. */}
          {!hasCard && !researchingDomain && !researchTimedOut && (
            <button
              type="button"
              onClick={onResearch}
              disabled={researching}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
            >
              {researching && <Loader2 className="h-3 w-3 animate-spin" />}
              Research my company
            </button>
          )}
        </div>
        {researchingDomain && <ResearchingLine domain={researchingDomain} />}
        {!researchingDomain && researchTimedOut && (
          <StillResearchingLine onRefresh={onRefresh} />
        )}
      </div>

      {/* ── The four starter cards ──
          Three of them open the sheet (they have a seeded draft to review, and
          the footer says so). Custom does not: it seeds nothing, so its sheet
          would be a form asking exactly what its inline box asks in one line.

          THE TRANSITIONAL LINE is what makes the grid read as the alternative
          rather than as a second, competing set of primary actions. Without it
          the card above ends on a filled button and the grid below starts with
          four more things to press, and the screen asks the user to choose
          between two paths it never named as paths. */}
      {/* Wrapped so the line belongs to the grid it introduces: the page's own
          `space-y-6` would otherwise float it midway between the card and the
          cards, reading as a heading for neither. */}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">or start one yourself</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {STARTER_PURPOSES.map((purpose) =>
            purpose === 'custom' ? (
              <CustomStarterCard
                key={purpose}
                onCreate={onCreateCustom}
                onOpenSheet={() => onStart('custom')}
              />
            ) : (
              <button
                key={purpose}
                type="button"
                onClick={() => onStart(purpose)}
                className="rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
              >
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-sm font-medium">
                    {PURPOSE_META[purpose].title}
                  </span>
                  {EXPERIMENTAL_PURPOSES.has(purpose) && <ExperimentalTag />}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                  {PURPOSE_META[purpose].blurb}
                </span>
                {/* Why a card leads to a sheet at all — the step reads as review,
                    not as being asked the same question twice. */}
                <span className="mt-1.5 block text-[11px] leading-snug text-muted-foreground">
                  {TEMPLATE_CARD_FOOTER}
                </span>
              </button>
            ),
          )}
        </div>
      </div>
    </div>
  )
}

// ============================================================
// View
// ============================================================

export function ProspectingView({
  listId,
  onOpenList,
  onListNameLoaded,
  onCloseDetail,
  onOpenSequence,
}: {
  /** From the tab location — non-null renders the detail page. */
  listId: string | null
  /** Push a detail history entry (recently-viewed label rides along). */
  onOpenList: (id: string, name: string) => void
  /** Deep links arrive with a placeholder name; called once the detail page
   *  knows the real one so the caller can refresh the history entry/label. */
  onListNameLoaded?: (id: string, name: string) => void
  /** Return to the index as a history step. */
  onCloseDetail: () => void
  /** Open a sequence's own page — the list detail's save/sequence banner links
   *  to the sequence its people were enrolled into, which is a real tab
   *  navigation away from Prospecting (C5). Passed straight through. */
  onOpenSequence?: (sequenceId: string, sequenceName: string | null) => void
}) {
  /**
   * The lists, read ONLY to decide between the empty state and the view.
   *
   * The index itself is now `UnifiedViewLayout`, which issues its own query
   * (filtered, sorted and saved-view-aware) — this read exists because that
   * decision cannot be made from inside the layout: the empty state is the
   * whole pre-fill wedge (§4) and it must replace the toolbar, not sit under
   * it. It is also what tells `onCreated` whether the page is about to switch
   * from the wedge to the list.
   *
   * The per-card `fetchRuns` probe is GONE with the cards. Each row's newest
   * run now rides on the views query as an embedded relation, and liveness
   * comes from the active-run poll below — one request for the whole page
   * instead of N.
   */
  const [lists, setLists] = useState<ProspectListWithCounts[] | null>(null)
  const [source, setSource] = useState<SourcePayload | null>(null)
  const [researching, setResearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The domain field, shared by the empty card and the correction affordance. */
  const [domain, setDomain] = useState('')
  /** Inline, beside the field — the 400 codes from POST /source. */
  const [domainError, setDomainError] = useState<string | null>(null)
  /**
   * The domain whose full enrichment is still in flight, or null.
   *
   * Separate from `researching` (which covers only the request itself): the
   * POST returns as soon as the company row exists and the Inngest event is
   * sent, and everything that makes the empty state worth seeing — what the
   * company sells, who buys it — lands tens of seconds later. Without this the
   * user presses the button, the card appears saying nothing useful, and
   * nothing ever visibly changes again.
   */
  const [researchingDomain, setResearchingDomain] = useState<string | null>(null)
  /**
   * The poll ran to its cap without the enrichment going terminal.
   *
   * A separate flag from `researchingDomain` because clearing that one alone
   * makes a timeout indistinguishable from a success: the spinner just
   * disappears and the "what you sell" line is still empty, which is the
   * production report ("it was loading but I wasn't sure what it was loading")
   * with the loading part removed. This is what renders "Still researching —
   * check back in a minute" with a Refresh.
   */
  const [researchTimedOut, setResearchTimedOut] = useState(false)
  /**
   * Incremented on every SUCCESSFUL establish, purely as a signal to the empty
   * state that its correction panel should close. A counter rather than a
   * boolean because two corrections in a row must both fire it.
   */
  const [establishedNonce, setEstablishedNonce] = useState(0)
  const [sheetPurpose, setSheetPurpose] = useState<ProspectListPurpose | null>(null)
  /**
   * The workspace's monthly prospecting ceiling.
   *
   * On the INDEX rather than only inside the run dialog because this is where
   * a user arrives before deciding whether to run anything at all — and
   * because the ceiling is spent by the whole workspace, so the first place it
   * should be visible is the one screen that belongs to no single list.
   * The read is fire-and-forget (see `useSpend`); a failure renders no line.
   */

  /**
   * Live runs across the whole workspace (§B5a).
   *
   * The `runs` map below is a ONE-SHOT probe — each list's newest run, fetched
   * once when the index mounts and never refreshed. That was fine when a run
   * could only start from inside a list. Scout now starts them from the chat
   * strip, so a user sitting on this index would watch nothing happen for four
   * minutes and then still see the PREVIOUS run's summary on the card.
   *
   * Gated on `!listId` because a list detail replaces this whole screen and
   * runs its own copy of the hook; two pollers for the same data on one screen
   * is one too many.
   */
  const activeRuns = useActiveRuns({ enabled: !listId })

  /**
   * Tell the mounted views list a list was created.
   *
   * `loadLists` refreshes the empty/non-empty DECISION this page owns; it does
   * not touch the layout's own query, which runs inside `UnifiedViewLayout`.
   * `dial8:entity-created` is the seam that list already listens on (with its
   * own coalescing), and it is the only way a list created from the sheet, the
   * Custom card or the agent shows up without a reload.
   *
   * Dispatched even when the page is about to navigate into the new list: the
   * user comes BACK here, and a stale index is exactly the report §B5a was
   * about one surface up.
   */
  const announceListCreated = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('dial8:entity-created', { detail: { entityType: 'prospect_list' } }),
    )
  }, [])

  const loadLists = useCallback(async () => {
    try {
      setLists(await fetchLists())
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'Could not load your lists'))
    }
  }, [])

  // The index and the source load in parallel: the source is what the empty
  // state and the sheet both need, and waiting for lists first would make the
  // first-ever visit — the one that matters — a two-step spinner.
  useEffect(() => {
    if (listId) return
    void loadLists()
    fetchSource()
      .then(setSource)
      .catch(() => setSource(null))
  }, [listId, loadLists])

  // A deleted list (the bulk action below, or the list's own settings menu)
  // announces itself on the same seam a created one does. The rows are the
  // layout's to drop; what THIS page owns is `lists`, which decides whether
  // the index or the empty state is showing — deleting the last list must
  // land on the empty state, not on a bare table.
  useEffect(() => {
    if (listId) return
    return onEntityDeleted((d) => {
      if (d.entityType === 'prospect_list') void loadLists()
    })
  }, [listId, loadLists])

  /**
   * Push the live-run ids into the row store (L4).
   *
   * The rows are mounted deep inside the shared views system, which hands a
   * row only its item and the view's display properties — so the page
   * publishes and the rows subscribe, the same seam `publishProspectSequenced`
   * uses one level down. Without this a row would only learn a run started
   * when its own query happened to refetch, which for a run Scout begins
   * beside this very screen is "never".
   *
   * CLEARED ON UNMOUNT. A stale id would light a telescope on a list whose run
   * finished while the user was on another tab.
   */
  const liveListIds = useMemo(
    () => new Set(activeRuns.runs.map((r) => r.list_id)),
    [activeRuns.runs],
  )
  //
  // A chat card publishes nothing: the store is the page's, one per app, and
  // the card writing or clearing it would wipe the real page's "Finding…"
  // (list-detail.tsx guards its stores the same way). Only a chat card gives
  // its rows their own target.
  const inChatCard = useProspectEntryActionTarget() !== null
  useEffect(() => {
    if (!inChatCard) publishProspectListLive(liveListIds)
  }, [liveListIds, inChatCard])
  useEffect(
    () =>
      inChatCard
        ? undefined
        : () => {
            publishProspectListLive(new Set())
          },
    [inChatCard],
  )

  /**
   * Pre-fill the field from `suggested_domain` — ONCE, and only while it is
   * untouched.
   *
   * `companyDomainFromEmail` of a business signup is almost always right, so
   * the honest default is to show it and let one press confirm it. The guard
   * is on the field being empty rather than on a "touched" flag because the
   * source reloads after every POST, and re-seeding a field the user had
   * already corrected would silently undo their correction.
   */
  const suggested = source?.suggested_domain ?? null
  useEffect(() => {
    if (suggested && domain === '') setDomain(suggested)
    // `domain` is deliberately absent: this seeds once, and re-running on
    // every keystroke would fight the user for the field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested])

  /**
   * Poll GET /source while an enrichment is in flight.
   *
   * Every 5s until BOTH halves are done, or 3 minutes pass — a bounded loop,
   * not a subscription: this runs on exactly one screen, at most once per
   * visit.
   *
   * BOTH HALVES, and this is the fix. The finish line used to be the ICP card
   * alone, but the card is a $0.012 side search that routinely lands in seconds
   * while the full company enrichment — the job that writes `description` and
   * `industry`, i.e. the entire "You sell X" half of the sentence — runs on for
   * another minute. Stopping on the card meant the spinner vanished with the
   * line still stale, and nothing on screen ever changed again. So the stop
   * condition is `hasIcpCard(next) && enrichmentSettled(next)`: the card landed
   * AND `enrichment_status` is terminal (enriched | failed | skipped).
   *
   * Three minutes rather than two because the wait is now genuinely two jobs
   * long, and giving up at two would re-create the same stale line by the
   * clock instead of by the condition. When the cap IS hit the line does not
   * silently vanish — `researchTimedOut` says so and offers a Refresh.
   */
  const pollDeadline = useRef<number>(0)
  useEffect(() => {
    if (!researchingDomain) return
    let cancelled = false
    pollDeadline.current = Date.now() + 3 * 60 * 1000
    const tick = () => {
      if (Date.now() > pollDeadline.current) {
        setResearchingDomain(null)
        setResearchTimedOut(true)
        return
      }
      void fetchSource()
        .then((next) => {
          if (cancelled) return
          setSource(next)
          // The card landing is NOT the finish line on its own — the row
          // exists the instant the POST returns, and the card can beat the
          // enrichment that fills what the card cannot.
          if (hasIcpCard(next) && enrichmentSettled(next)) {
            setResearchingDomain(null)
            setResearchTimedOut(false)
          }
        })
        .catch(() => {
          /* a dropped poll is not a failure; the next tick retries */
        })
    }
    const timer = setInterval(tick, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [researchingDomain])

  /** One re-read of GET /source — the timeout line's Refresh, and what the
   *  inline "what you sell" save re-seeds the drafts from. */
  const refreshSource = useCallback(async () => {
    try {
      const next = await fetchSource()
      setSource(next)
      if (hasIcpCard(next) && enrichmentSettled(next)) setResearchTimedOut(false)
    } catch {
      /* the card already renders from what we have; a failed refresh is a
         no-op, not an error state */
    }
  }, [])

  /**
   * Save what the company sells, in the user's own words, then re-read.
   *
   * The re-read is the point: `buildIcpDraft` reads `company.description` as
   * its second `what_we_sell` source, so the GET that follows comes back with
   * every purpose's draft re-seeded — the sentence on the card and the pre-fill
   * inside the sheet change together, from one PATCH.
   */
  const saveWhatWeSell = useCallback(
    async (description: string) => {
      const companyId = source?.source?.id
      if (!companyId) return
      await saveCompanyDescription(companyId, description)
      await refreshSource()
    },
    [source?.source?.id, refreshSource],
  )

  /**
   * Create a custom list from the card's inline box and open it.
   *
   * Same draft the sheet would have used (`icp_draft_by_purpose.custom`) with
   * `target.description` set to what was typed — so opening the list's ICP chip
   * afterwards shows exactly the object this created, seeded source fields and
   * all, rather than something the inline path invented.
   */
  const createCustomList = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const draft = source?.icp_draft_by_purpose?.custom?.icp
      const icp = draft
        ? { ...draft, target: { ...draft.target, description: trimmed } }
        : null
      if (!icp) return
      const list = await createList({
        // A list is found again by its name in a sidebar, so the name IS what
        // was asked for — capped, because 'e.g. companies with…' pasted from a
        // doc can run for paragraphs and a list label cannot.
        name: trimmed.slice(0, 60),
        purpose: 'custom',
        icp,
        source_company_id: source?.source?.id ?? null,
      })
      void loadLists()
      announceListCreated()
      onOpenList(list.id, list.name)
    },
    [source, loadLists, announceListCreated, onOpenList],
  )

  /**
   * POST /source, with or without a domain.
   *
   * WITHOUT one (`domainOverride` omitted) this is the original path: a
   * company already resolved and we are firing its ICP card.
   *
   * WITH one it is §4 step 4 — establish the company from the domain, kick the
   * full enrichment, re-point the workspace if it already had a different one.
   * The 400s land INLINE on the field rather than in the page-level error line,
   * because each of them is a correction made by editing that field.
   */
  const runResearch = async (domainOverride?: string) => {
    if (researching) return
    const wanted = domainOverride?.trim() ?? ''
    setResearching(true)
    setDomainError(null)
    // A fresh attempt clears a previous give-up: the timeout line and a live
    // researching line must never be on screen together.
    setResearchTimedOut(false)
    try {
      const next = await researchSource(wanted || undefined)
      setSource(next)
      // `established` is the route's own word for "the workspace company row
      // was created or re-pointed" — the only case the correction panel should
      // close on. A bare ICP-card refresh leaves it alone.
      if (next.established) setEstablishedNonce((n) => n + 1)
      // Only claim to be researching when the server says something started.
      // 'already' means the row was enriched or enriching before we asked, and
      // a line that never resolves is worse than no line at all.
      if (next.enrichment === 'started') {
        setResearchingDomain(wanted || next.source?.domain || null)
      } else {
        setResearchingDomain(null)
      }
    } catch (err) {
      const code = errorCode(err)
      if (wanted || code === 'NEEDS_DOMAIN' || code === 'PERSONAL_DOMAIN' || code === 'INVALID_DOMAIN') {
        setDomainError(
          sourceDomainErrorMessage(code, errorMessage(err, 'Could not research that company')),
        )
      } else {
        // A failed card is not a failed page: the templates still work off the
        // company's own columns, so this degrades quietly rather than blocking.
        setError('Could not research your company just now')
      }
    } finally {
      setResearching(false)
    }
  }

  // ── List detail ──
  if (listId) {
    return (
      <ListDetail
        key={listId}
        listId={listId}
        onBack={onCloseDetail}
        onNameLoaded={(name) => onListNameLoaded?.(listId, name)}
        onOpenSequence={onOpenSequence}
      />
    )
  }

  // ── Lists index ──
  const empty = lists !== null && lists.length === 0

  return (
    <div className="relative flex h-full flex-col">
      <ViewHeader
        // ViewHeader renders a plain string title as its own <h1>; passing a
        // node instead lets the beta pill ride immediately right of the word
        // rather than being pushed to the actions side, which is where a
        // disclaimer about the page would read as a control.
        title={
          <span className="inline-flex items-center gap-2 truncate text-sm font-semibold text-foreground">
            <PageTitle label="Prospecting" as="h1" />
            <BetaPill />
          </span>
        }
        actions={
          <>
            {/* Quiet, and to the LEFT of the new-list button: it is a fact
                about the workspace, not a control. */}
            {/* "1 run active" — the workspace's own state, said once, in the
                one place that belongs to no single list. Quiet and to the LEFT
                of the ceiling: it is a fact, not a control, and it is the
                honest answer to "I asked Scout to find companies and this page
                looks the same as before". */}
            {activeRuns.runs.length > 0 && (
              <span
                className="mr-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"
                title={activeRuns.runs.map((r) => r.list_name).join(', ')}
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500/70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500" />
                </span>
                <span className="tabular-nums">
                  {activeRuns.runs.length}{' '}
                  {activeRuns.runs.length === 1 ? 'run active' : 'runs active'}
                </span>
              </span>
            )}
            {!empty && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={() => setSheetPurpose('buyers')}
                title="New list"
                aria-label="New list"
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
          </>
        }
      />

      {/* The layout brings its OWN scroller (and its own virtualizer), so this
          wrapper must not scroll: nesting one scroll container inside another
          is what makes a virtualized list measure the wrong viewport. The
          empty state, which is plain content, gets the scroll it needs from
          its own branch below. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {lists === null ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : empty ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <EmptyState
              source={source}
              researching={researching}
              researchingDomain={researchingDomain}
              researchTimedOut={researchTimedOut}
              onRefresh={() => void refreshSource()}
              onSaveWhatWeSell={saveWhatWeSell}
              onCreateCustom={createCustomList}
              domain={domain}
              onDomainChange={(next) => {
                setDomain(next)
                if (domainError) setDomainError(null)
              }}
              domainError={domainError}
              onSubmitDomain={() => void runResearch(domain)}
              establishedNonce={establishedNonce}
              onResearch={() => void runResearch()}
              onStart={(purpose) => setSheetPurpose(purpose)}
            />
          </div>
        ) : (
          /* ── The index, on the views system ──
             The card grid this replaces could not be sorted, filtered or
             saved as a view, which is fine for three lists and unusable for
             thirty. Every one of those affordances comes free from the
             toolbar `UnifiedViewLayout` draws — the page's only job is to say
             which entity and what a click means.

             UNSCOPED (no `viewScope`): these are the workspace's lists, not
             the entries of one. The list detail mounts the SAME component
             scoped to a list, which is the "entries nested inside" half. */
          <div className="min-h-0 flex-1">
            <UnifiedViewLayout
              entityType="prospect_list"
              onItemSelect={(id, title) => onOpenList(id, title)}
            />
          </div>
        )}
        {/* A flex ROW of its own, not a sibling stacked under a `h-full`
            child: the layout above fills the wrapper, so an absolutely-sized
            error line rendered after it lands past the bottom edge and is
            never seen. Refetch, create and save failures all land here. */}
        {error && (
          <p className="shrink-0 px-6 pb-4 pt-2 text-xs text-muted-foreground">{error}</p>
        )}
      </div>

      <NewListSheet
        open={sheetPurpose !== null}
        source={source}
        initialPurpose={sheetPurpose ?? 'buyers'}
        onClose={() => setSheetPurpose(null)}
        onCreated={(list) => {
          setSheetPurpose(null)
          void loadLists()
          announceListCreated()
          onOpenList(list.id, list.name)
        }}
      />
    </div>
  )
}
