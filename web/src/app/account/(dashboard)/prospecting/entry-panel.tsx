'use client'

import { PreferenceActionButton, usePreferencesActions } from '@/components/views/preference-action'

/**
 * Entry detail BEFORE Save (§10, Page 4) — in the CRM's own shape.
 *
 * A candidate is not a CRM record until it is saved, so it has no
 * `CompanyDetailPanel` to open. What it gets instead is a panel built to the
 * SAME PLAN as that one (Liam, 2026-09-06: "make it look as similar as
 * possible to our CRM page, like how we display companies … reuse our details
 * panel on the side and show the details there"): the sub-header toolbar with
 * the tab pills on the left and the verbs on the right, a content column of
 * the CRM's width, and the properties sidebar beside it, width-driven exactly
 * as the CRM's is. Once the company is published, the CRM panel opens in this
 * same pop-up and nothing about the layout moves.
 *
 * WHAT GOES WHERE, and why nothing is printed twice — the old panel stacked
 * name, one-liner, "Fit", the research blob and a Details list in one scroll,
 * and the why-fit paragraph, the one-liner and the domain each appeared in
 * two of them:
 *
 *   - Overview: identity (favicon, name, the match-score chip), the
 *     description, the MATCH block (the verdict and the page behind it), the
 *     signals, and the people found here. The verdict lives here and only
 *     here.
 *   - Details: every research fact in the CRM's sections (About, Size &
 *     revenue, Funding, Leadership, Products & services, Technology,
 *     Signals), each with its copy button and source dot — the model is
 *     `buildProspectDetails`, a catalog over the same blob reader the CRM's
 *     Details tab uses.
 *   - People: the person entries found at this company, and Find people.
 *   - Sidebar: the short facts (domain, size, headquarters, founded, funding)
 *     as read-only property rows, then the Prospecting group (stage, how it
 *     was found) and the Research group (enriched when, how many sources,
 *     View details) — the twin of the CRM's Enrichment group.
 *
 * The panel draws NO HEADER OF ITS OWN: the list detail mounts it under the
 * shared `DetailBreadcrumbHeader`, which carries the crumb, the back button
 * and prev/next. Closing is that header's job and Escape's, so this takes no
 * `onClose`.
 *
 * A PERSON ENTRY IS THE SAME PLAN with the contact panel's furniture: an
 * initial in the avatar slot, an IDENTITY block where the company has its
 * Match block (fit is scored on the account; a per-person grade would be a
 * number nobody computed), job title / company / email / LinkedIn as the
 * sidebar's properties, and Save gated in the panel for a `needs_review`
 * person — the one place the evidence for that judgement is on screen.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  Briefcase,
  Building2,
  CalendarDays,
  CircleDashed,
  ExternalLink,
  Factory,
  Globe,
  Landmark,
  Link as LinkIcon,
  Loader2,
  Mail,
  MapPin,
  Search,
  Send,
  Sparkles,
  Telescope,
  UserRound,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { CopyValueButton } from '@/components/views/copy-value-button'
import { PropertyGroup } from '@/components/views/property-group'
import { usePropertiesVisible } from '@/components/views/use-properties-visible'
import { WindowProperties, WindowActions } from '@/components/views/window-properties'
import { cn } from '@/lib/utils'
import type { DetailField } from '@/lib/crm/enrichment-details'
import {
  buildProspectDetails,
  candidateOf,
  personRelevance,
  prospectFacts,
  researchValue,
  type ProspectDetailsModel,
} from '@/lib/prospecting/details'
import { entryEvidenceUrl, hostOf } from '@/lib/prospecting/evidence'
import { fitScoreWord } from '@/lib/prospecting/fit-display'
import {
  KNOWN_PEOPLE_PHRASES,
  foundOnlyKnownPeople,
  knownPeopleSummary,
  readPeopleSearch,
} from '@/lib/prospecting/people-search'
import type { ProspectListEntryRow, ProspectPeopleSearch } from '@/lib/prospecting/types'
import { ContentTransition } from '../views/transitions'
import {
  BlockField,
  DetailSectionView,
  DetailsEmptyState,
  DetailsStatusLine,
  SourceMark,
  SourcesList,
  UnverifiedGroup,
} from '../views/details-tab-parts'
import type { SequencedState } from './api'
import { DISMISS_REASON_LABELS } from './dismiss-reason-dialog'
import { FitScore } from './fit-score'
import { NO_EMAIL_REASON, sequencedLabel, sequencedTitle } from './ui-helpers'

// ============================================================
// Vocabulary
// ============================================================

/**
 * The person identity gate, in words (§7 Stage 4).
 *
 * `anchored` means at least one field survived `demoteUnrelatedPersonSources`
 * at high or medium against the company's own domain — i.e. a page on that
 * company's site says this person works there. `needs_review` is the Devin
 * Marsh case: a plausible person whose employer we could not confirm, which is
 * why those rows are excluded from bulk save and need a per-row look.
 */
const IDENTITY_STATE_LABELS: Record<string, string> = {
  anchored: 'Verified at this company',
  needs_review: 'Employer not confirmed',
  resolved: 'Resolved',
  unresolved: 'Unresolved',
}

/** Where this candidate came from, in words. `result_entity` rows were lifted
 *  free from Exa's `results[].entities[]` and were never synthesized against
 *  the ICP — which is exactly why their description is not a rationale. */
const FOUND_VIA_LABELS: Record<string, string> = {
  synthesized: 'Found by ICP search',
  result_entity: 'Lifted from a search result',
}

/** For comparing two sentences that may differ only in spacing or a stop. */
function normalise(text: string): string {
  return text.trim().replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase()
}

/**
 * The entry's stage, honestly. `STAGE_LABELS.saved` still reads "Saved to
 * CRM" for the index's stage bar, but since migration 259 Save is curation:
 * a saved entry is ON THE LIST and reaches the CRM only when the list is
 * published, and the sidebar must not claim otherwise.
 */
function stageText(entry: ProspectListEntryRow): string {
  switch (entry.stage) {
    case 'dismissed': {
      const reason = entry.dismissed_reason ? DISMISS_REASON_LABELS[entry.dismissed_reason] : null
      return reason ? `Dismissed · ${reason}` : 'Dismissed'
    }
    case 'saved':
      return entry.published_at ? 'In your CRM' : 'On the list'
    case 'shortlisted':
      return 'Shortlisted'
    default:
      return 'Discovered'
  }
}

// ============================================================
// Props
// ============================================================

export interface EntryPanelProps {
  entry: ProspectListEntryRow
  /** A save or dismiss is in flight — every verb disables together. */
  busy?: boolean
  /** No `onClose`: the panel draws no header. Closing is owned by the shared
   *  `DetailBreadcrumbHeader` the list detail mounts above it (and by Escape),
   *  which is the same back affordance every other detail page in the app has. */
  onSave: (options?: { confirmUnverified?: boolean }) => void
  onDismiss: () => void
  /** Companies only: run the full profile (and THE score) for this one
   *  company — the panel's twin of the row's Enrich button. */
  onProfile?: () => void
  /** Companies only: search for decision makers at this company — the row's
   *  Find people, reachable from the People tab and the toolbar. */
  onFindPeople?: () => void
  /** The profile run that will score this company is live right now. */
  profiling?: boolean
  /** The live people run is searching this company right now. */
  findingPeople?: boolean
  /** The person entries found at this company (their `parent_entry_id` is
   *  this entry). The page holds every entry on the list, so it passes them
   *  rather than the panel fetching its own. */
  people?: ProspectListEntryRow[]
  /** Open one of those people in this same pop-up. */
  onOpenPerson?: (person: ProspectListEntryRow) => void
  /** Any entry on the list by id — the "already in this list" note names
   *  the row a found person duplicates, and the account it sits under. */
  lookupEntry?: (id: string) => ProspectListEntryRow | undefined
  /** Open that row in this same pop-up. */
  onOpenEntry?: (entry: ProspectListEntryRow) => void
  /** Open the account this person hangs off. Absent (or the parent entry not
   *  loaded) simply renders the company as text — a link that goes nowhere is
   *  worse than a name. */
  onOpenParent?: (parentEntryId: string) => void
  /** The parent account's display name, when the page has it. Falls back to
   *  the denormalised `candidate.company_name`. */
  parentName?: string | null
  /** Save-then-enroll (§8). People only; a company has no contact to enroll. */
  onAddToSequence?: () => void
  /** This person's DERIVED sequence membership, when they are saved and in
   *  one. Never a column — see `ui-helpers.sequencedLabel`. */
  sequenced?: SequencedState | null
}

export function EntryPanel(props: EntryPanelProps) {
  // A person is a different panel: no match block (fit lives on the account),
  // an identity block instead, and a Save gated on the identity check rather
  // than on the entity kind. Dispatched here rather than at the call site so
  // the list detail keeps ONE overlay descriptor for "an unsaved entry".
  if (props.entry.kind === 'person') return <PersonPanel {...props} />
  return <CompanyEntryPanel {...props} />
}

// ============================================================
// The frame both panels share — the CRM panel's plan
// ============================================================

const TAB_LABELS: Record<string, string> = {
  overview: 'Overview',
  details: 'Details',
  people: 'People',
}

/**
 * Toolbar (tab pills + verbs), an optional notice band, then the body: the
 * content column at the CRM's 736px beside the 289px properties sidebar,
 * centred as a pair. The sidebar is width-driven, not toggled — up whenever
 * the pop-up is wide enough, gone when it is not — through the same hook the
 * CRM panels use, so the two surfaces step aside at the same width.
 */
function PanelFrame<T extends string>({
  tabs,
  activeTab,
  onTab,
  counts,
  verbs,
  notice,
  contentKey,
  sidebar,
  children,
}: {
  tabs: readonly T[]
  activeTab: T
  onTab: (tab: T) => void
  counts?: Partial<Record<T, number>>
  verbs: React.ReactNode
  notice?: React.ReactNode
  contentKey: string
  sidebar: React.ReactNode
  children: React.ReactNode
}) {
  const panelBodyRef = useRef<HTMLDivElement>(null)
  const propertiesOpen = usePropertiesVisible(panelBodyRef)

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Sub-header toolbar — the CRM panel's, pill for pill. */}
      <div data-prospect-toolbar className="flex h-10 shrink-0 items-center px-3">
        <div className="flex items-center gap-1">
          {tabs.map((tab) => {
            const count = counts?.[tab]
            return (
              <button
                key={tab}
                type="button"
                data-prospect-tab={tab}
                aria-pressed={activeTab === tab}
                onClick={() => onTab(tab)}
                className={cn(
                  'inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors',
                  activeTab === tab
                    ? 'border-foreground bg-foreground font-medium text-background'
                    : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {TAB_LABELS[tab] ?? tab}
                {typeof count === 'number' && count > 0 && (
                  <span className="ml-1.5 text-[10px] opacity-70">{count}</span>
                )}
              </button>
            )
          })}
        </div>
        <WindowActions className="ml-auto flex items-center gap-1">{verbs}</WindowActions>
      </div>

      {notice}

      <ContentTransition contentKey={contentKey} className="flex min-h-0 flex-1 flex-col">
        <div ref={panelBodyRef} className="flex min-h-0 flex-1 justify-center">
          {/* Left: tab content */}
          <div className="mx-auto flex min-h-0 w-full max-w-[736px] min-w-0 flex-col">
            {children}
          </div>

          {/* Page-level properties inspector. */}
          <WindowProperties key={contentKey} title="Prospect" fallbackVisible={propertiesOpen}>
                  <div data-prospect-sidebar className="space-y-4 p-4">{sidebar}</div>
                </WindowProperties>
        </div>
      </ContentTransition>
    </div>
  )
}

/** A thin rule between the research verbs and the decision verbs. */
function VerbDivider() {
  const inPreferences = usePreferencesActions()
  return <div aria-hidden className={inPreferences ? "my-1 h-px w-full bg-border" : "mx-1 h-5 w-px shrink-0 bg-border"} />
}

// ============================================================
// Sidebar rows
// ============================================================

/**
 * One read-only property row — the shape of the CRM's `TextPropertyRow`
 * (icon, value, hover copy button, provenance dot) without the input, since a
 * candidate's facts are read off the web and edited only once it is a record.
 * The dot is the Details tab's own `SourceMark`, so it links to the page.
 */
function FactRow({
  icon,
  value,
  display,
  href,
  label,
  field,
  ...rest
}: {
  icon: React.ReactNode
  /** The raw value — what the copy button copies. */
  value: string | null | undefined
  /** How it reads in the row, when not the raw value ("201-500 employees"). */
  display?: string
  /** Render the value as an external link. */
  href?: string
  /** Names the copy button ("Copy domain"). */
  label: string
  /** The field behind the value, for the provenance dot. */
  field?: DetailField | null
} & Record<`data-${string}`, string | undefined>) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null
  const shown = display ?? text
  return (
    <div {...rest} className="group/row flex h-8 items-center gap-2 px-2">
      {icon}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={shown}
          className="min-w-0 flex-1 truncate text-sm hover:underline"
        >
          {shown}
        </a>
      ) : (
        <span title={shown} className="min-w-0 flex-1 truncate text-sm">
          {shown}
        </span>
      )}
      <CopyValueButton value={text} label={label} />
      {field && <SourceMark field={field} />}
    </div>
  )
}

/** A row that states something rather than holding a value — no copy button. */
function InfoRow({
  icon,
  children,
  muted = true,
  ...rest
}: {
  icon: React.ReactNode
  children: React.ReactNode
  muted?: boolean
} & Record<`data-${string}`, string | undefined>) {
  return (
    <div
      {...rest}
      className={cn(
        'flex min-h-8 items-center gap-2 px-2 py-1 text-sm',
        muted && 'text-muted-foreground',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  )
}

const ROW_ICON = 'h-4 w-4 shrink-0 text-muted-foreground'

/**
 * The CRM sidebar's Enrichment group, for a candidate: when the profile ran,
 * how many pages it read, and the way to the Details tab. The status line is
 * the Details tab's own, so the two never disagree about the state.
 */
function ResearchGroup({
  model,
  enriching,
  subject,
  onViewDetails,
}: {
  model: ProspectDetailsModel
  enriching: boolean
  subject: string
  onViewDetails: () => void
}) {
  const hasAnything =
    model.fieldCount > 0 || model.unverified.length > 0 || model.sources.length > 0
  return (
    <PropertyGroup title="Research">
      <div className="space-y-2.5 px-2 pt-0.5">
        <DetailsStatusLine model={model} enriching={enriching} subject={subject} />
        {hasAnything && (
          <button
            type="button"
            onClick={onViewDetails}
            className="inline-flex items-center gap-1 text-xs text-foreground underline-offset-2 hover:underline"
          >
            View details
            <ArrowRight className="h-3 w-3" />
          </button>
        )}
      </div>
    </PropertyGroup>
  )
}

// ============================================================
// Company
// ============================================================

const COMPANY_TABS = ['overview', 'details', 'people'] as const
type CompanyTab = (typeof COMPANY_TABS)[number]

/**
 * The leading glyph: the company's own favicon in the CRM logo's 40px disc,
 * falling back to the CRM's Building2 for a domain-less candidate or a
 * favicon that will not load. Keyed off the domain so stepping to another
 * company retries rather than inheriting the previous one's failure.
 */
function CompanyGlyph({ domain }: { domain: string | null }) {
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const trimmed = domain?.trim() ?? ''
  const failed = trimmed !== '' && failedFor === trimmed
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
      {trimmed && !failed ? (
        <img
          data-prospect-favicon={trimmed}
          src={`https://www.google.com/s2/favicons?domain=${trimmed}&sz=64`}
          alt=""
          className="h-5 w-5 rounded-[4px]"
          onError={() => setFailedFor(trimmed)}
        />
      ) : (
        <Building2 className="h-5 w-5" />
      )}
    </div>
  )
}

function CompanyEntryPanel({
  entry,
  busy = false,
  onSave,
  onDismiss,
  onProfile,
  onFindPeople,
  profiling = false,
  findingPeople = false,
  people = [],
  onOpenPerson,
  lookupEntry,
  onOpenEntry,
}: EntryPanelProps) {
  const [tab, setTab] = useState<CompanyTab>('overview')
  const candidate = candidateOf(entry)
  const model = useMemo(() => buildProspectDetails(entry), [entry])
  const facts = useMemo(() => prospectFacts(entry), [entry])

  const displayName = candidate.name || candidate.domain || 'Unknown candidate'
  const domain = candidate.domain?.trim() || null
  const scope = domain || displayName
  const description = candidate.one_liner?.trim() || researchValue(entry.research, 'one_liner')
  const scored = typeof entry.fit_score === 'number'
  const saved = entry.stage === 'saved'
  const dismissed = entry.stage === 'dismissed'
  const unresolved = entry.identity_state === 'unresolved'
  /** The page that surfaced this company — the SHARED definition the list
   *  row uses when "Why" is on, so the two never disagree. */
  const evidenceUrl = entryEvidenceUrl(entry)
  const evidenceHost = evidenceUrl ? hostOf(evidenceUrl) : null
  const word = fitScoreWord(entry.fit_score)
  const signals = model.sections.find((s) => s.key === 'signals') ?? null
  /** The last people search found people and kept none of them — every hit
   *  was already known. The honest state, in place of "No people found yet". */
  const peopleSearch = readPeopleSearch(entry.candidate)
  const knownOnly = people.length === 0 && foundOnlyKnownPeople(peopleSearch)
  /** "Researching…" only while a run is about to score THIS company. */
  const researching = profiling && !scored && !dismissed && !unresolved
  const canAct = !dismissed && !unresolved
  /** Exa's entity id, as the harvest stores it — the library URL itself for
   *  a `result_entity` row, a bare id for older rows. Either way, one link. */
  const exaHref = candidate.exa_entity_id
    ? /^https?:\/\//i.test(candidate.exa_entity_id)
      ? candidate.exa_entity_id
      : `https://exa.ai/library/organization/${candidate.exa_entity_id}`
    : null
  const hasFacts =
    Boolean(facts.domain) ||
    Boolean(facts.website || facts.industry || facts.employees || facts.headquarters) ||
    Boolean(facts.founded || facts.fundingStage || facts.totalRaised)

  const verbs = (
    <>
      {onFindPeople && canAct && (
        <PreferenceActionButton
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={onFindPeople}
          disabled={busy || findingPeople}
          title="Find decision makers at this company"
        >
          {findingPeople ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Users className="h-3.5 w-3.5" />
          )}
          {findingPeople ? 'Finding people…' : 'Find people'}
        </PreferenceActionButton>
      )}
      {/* The panel's twin of the row's Enrich button, shown until the
          company has a score. A dismissed or domain-less company has
          nothing to enrich for (the card anchors on the domain). */}
      {onProfile && !scored && canAct && (
        <PreferenceActionButton
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={onProfile}
          disabled={busy || researching}
          title="Run the full profile for this company and score it"
        >
          {researching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {researching ? 'Enriching…' : 'Enrich'}
        </PreferenceActionButton>
      )}
      {((onFindPeople && canAct) || (onProfile && !scored && canAct)) && <VerbDivider />}
      <PreferenceActionButton
        variant="ghost"
        size="sm"
        className="h-7 text-xs"
        onClick={onDismiss}
        disabled={busy || dismissed}
      >
        {dismissed ? 'Dismissed' : 'Dismiss'}
      </PreferenceActionButton>
      <PreferenceActionButton
        size="sm"
        className="h-7 text-xs"
        onClick={() => onSave()}
        disabled={busy || saved || unresolved}
        title={
          saved
            ? entry.published_at
              ? 'On the list and in your CRM'
              : 'On the list — reaches your CRM when the list is published'
            : 'Keep this company (and the people found at it) on the list'
        }
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {/* SAVE keeps the company on the list; the CRM row appears when the
            list is published (migration 259). */}
        {saved ? (entry.published_at ? 'In your CRM' : 'On the list') : 'Save to list'}
      </PreferenceActionButton>
    </>
  )

  const sidebar = (
    <>
      <PropertyGroup title="Properties">
        {hasFacts ? (
          <>
            <FactRow
              icon={<Globe className={ROW_ICON} />}
              value={facts.domain}
              href={facts.domain ? `https://${facts.domain}` : undefined}
              label="Domain"
            />
            <FactRow
              icon={<LinkIcon className={ROW_ICON} />}
              value={facts.website?.value}
              href={
                facts.website
                  ? /^https?:\/\//i.test(facts.website.value)
                    ? facts.website.value
                    : `https://${facts.website.value}`
                  : undefined
              }
              label="Website"
              field={facts.website}
            />
            <FactRow
              icon={<Factory className={ROW_ICON} />}
              value={facts.industry?.value}
              label="Industry"
              field={facts.industry}
            />
            {/* The headcount the slim row stopped showing — it lives here,
                beside the other facts, rather than as a chip in the header. */}
            <FactRow
              data-prospect-employees=""
              icon={<Users className={ROW_ICON} />}
              value={facts.employees?.value}
              display={facts.employees ? `${facts.employees.value} employees` : undefined}
              label="Employee count"
              field={facts.employees}
            />
            <FactRow
              icon={<MapPin className={ROW_ICON} />}
              value={facts.headquarters?.value}
              label="Headquarters"
              field={facts.headquarters}
            />
            <FactRow
              icon={<CalendarDays className={ROW_ICON} />}
              value={facts.founded?.value}
              display={facts.founded ? `Founded ${facts.founded.value}` : undefined}
              label="Founded year"
              field={facts.founded}
            />
            <FactRow
              icon={<Landmark className={ROW_ICON} />}
              value={facts.fundingStage?.value}
              label="Funding stage"
              field={facts.fundingStage}
            />
            <FactRow
              icon={<Banknote className={ROW_ICON} />}
              value={facts.totalRaised?.value}
              display={facts.totalRaised ? `${facts.totalRaised.value} raised` : undefined}
              label="Total raised"
              field={facts.totalRaised}
            />
          </>
        ) : (
          <p className="px-2 text-xs text-muted-foreground">Nothing known yet.</p>
        )}
      </PropertyGroup>

      {/* Per-list facts that never reach the CRM record: where this
          candidate stands on the list and how it got here. */}
      <PropertyGroup title="Prospecting">
        <InfoRow icon={<Telescope className={ROW_ICON} />} muted={false}>
          {stageText(entry)}
        </InfoRow>
        {(candidate.found_via || entry.discovery_angle) && (
          <InfoRow icon={<Search className={ROW_ICON} />}>
            {candidate.found_via
              ? (FOUND_VIA_LABELS[candidate.found_via] ?? candidate.found_via)
              : 'Found'}
            {entry.discovery_angle ? ` · ${entry.discovery_angle}` : ''}
          </InfoRow>
        )}
        {exaHref && (
          <InfoRow icon={<ExternalLink className={ROW_ICON} />}>
            <a
              href={exaHref}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground hover:underline"
              title="This candidate on Exa"
            >
              View on Exa
            </a>
          </InfoRow>
        )}
      </PropertyGroup>

      <ResearchGroup
        model={model}
        enriching={researching}
        subject={scope}
        onViewDetails={() => setTab('details')}
      />
    </>
  )

  return (
    <PanelFrame
      tabs={COMPANY_TABS}
      activeTab={tab}
      onTab={setTab}
      counts={{ people: people.length }}
      verbs={verbs}
      contentKey={entry.id}
      sidebar={sidebar}
    >
      {tab === 'overview' && (
        <ScrollArea className="h-full">
          <div className="space-y-5 px-8 pb-10">
            {/* Favicon + name + the verdict, where the CRM puts its logo,
                name and Enriched badge. */}
            <div className="pb-2 pt-6">
              <div className="flex items-center gap-3">
                <CompanyGlyph domain={domain} />
                <div className="group/row flex min-w-0 flex-1 items-center gap-1">
                  <h1 className="min-w-0 truncate text-lg font-semibold">{displayName}</h1>
                  <CopyValueButton value={displayName} label="name" />
                </div>
                <FitScore score={entry.fit_score} />
              </div>
              {/* No domain line under the name: the domain is the first row
                  of the Properties sidebar, as it is on the CRM company
                  panel, and printing it here too was the same link twice
                  (Liam, 2026-09-07: "let's remove this one"). */}
            </div>

            {/* Description — the company's own blurb, never a rationale. */}
            {description && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Description</Label>
                <p className="px-2 text-sm leading-relaxed">{description}</p>
              </div>
            )}
            {unresolved && (
              <p className="px-2 text-xs leading-relaxed text-muted-foreground">
                We could not resolve a website for this candidate, so there is nothing to
                research or save yet.
              </p>
            )}

            {/* ── Match ──
                The full profile's verdict: the paragraph behind the score in
                the header, and the page that surfaced the company. Until the
                company is enriched there is no score (discovery does not
                score; fit.ts), only discovery's why-match sentence, and the
                block says so instead of guessing. */}
            <section className="space-y-2">
              <div className="flex items-baseline gap-2">
                <p className="text-sm font-medium">Match</p>
                {word && <span className="text-xs text-muted-foreground">{word}</span>}
              </div>
              <div className="space-y-1.5 px-2">
                {entry.fit_rationale ? (
                  <p className="text-sm leading-relaxed">{entry.fit_rationale}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {scored ? 'No rationale was recorded for this score.' : 'Not scored yet.'}
                  </p>
                )}
                {evidenceUrl && (
                  <a
                    data-prospect-citation
                    href={evidenceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {/* The honest wording: this is the page that surfaced the
                        company (or its own site, after the profile), not a
                        citation for any single claim. */}
                    Surfaced by {evidenceHost ?? evidenceUrl}
                    <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                  </a>
                )}
                {!scored && !dismissed && (
                  <p data-prospect-enrich-hint className="text-xs text-muted-foreground">
                    {researching
                      ? 'Enriching now — the score lands when the profile finishes.'
                      : 'Enrich this company to get its full profile and a score.'}
                  </p>
                )}
              </div>
            </section>

            {/* Signals — the one research section a seller reads first, so
                it is on the overview as well as under Details. */}
            {signals && <DetailSectionView section={signals} />}

            {/* People found here — the CRM's Recent Captures slot. */}
            <section className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-medium">
                  People
                  {people.length > 0 && (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      {people.length}
                    </span>
                  )}
                </p>
                {people.length > 5 && (
                  <button
                    type="button"
                    onClick={() => setTab('people')}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    View all
                  </button>
                )}
              </div>
              {people.length === 0 ? (
                findingPeople ? (
                  <p className="px-2 text-xs text-muted-foreground">Searching for people…</p>
                ) : knownOnly && peopleSearch ? (
                  <KnownPeopleNote
                    search={peopleSearch}
                    lookupEntry={lookupEntry}
                    onOpenEntry={onOpenEntry}
                  />
                ) : (
                  <p className="px-2 text-xs text-muted-foreground">No people found yet.</p>
                )
              ) : (
                <div className="space-y-0.5">
                  {people.slice(0, 5).map((person) => (
                    <PersonRow key={person.id} person={person} onOpen={onOpenPerson} />
                  ))}
                </div>
              )}
            </section>
          </div>
        </ScrollArea>
      )}

      {tab === 'details' && (
        <ScrollArea className="h-full">
          <ProspectDetailsTab model={model} enriching={researching} scope={scope} />
        </ScrollArea>
      )}

      {tab === 'people' && (
        <ScrollArea className="h-full">
          <div className="space-y-4 px-8 pb-10 pt-6">
            {people.length === 0 ? (
              <div className="flex items-start gap-3 rounded-lg border border-dashed border-border p-5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Users className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-medium">
                    {findingPeople
                      ? 'Searching for people…'
                      : knownOnly && peopleSearch
                        ? knownPeopleSummary(peopleSearch)
                        : 'No people found yet'}
                  </p>
                  {!findingPeople && knownOnly && peopleSearch ? (
                    <>
                      <KnownPeopleNote
                        search={peopleSearch}
                        lookupEntry={lookupEntry}
                        onOpenEntry={onOpenEntry}
                        bare
                      />
                      {onFindPeople && canAct && (
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          Searching again finds the same people, and costs the same.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {findingPeople
                        ? `Looking for decision makers at ${displayName} now — they appear here as they are found.`
                        : onFindPeople && canAct
                          ? `Find the decision makers at ${displayName}, anchored to its own site.`
                          : `Nobody has been searched for at ${displayName}.`}
                    </p>
                  )}
                  {onFindPeople && canAct && !findingPeople && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 h-7 gap-1.5 text-xs"
                      onClick={onFindPeople}
                      disabled={busy}
                    >
                      <Users className="h-3.5 w-3.5" />
                      Find people
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-0.5">
                {people.map((person) => (
                  <PersonRow key={person.id} person={person} onOpen={onOpenPerson} />
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      )}
    </PanelFrame>
  )
}

/**
 * The company's Details tab — the CRM's, over the candidate's research:
 * status line, then every fact in its section with the copy button and the
 * source dot, then the Unverified quarantine and the sources.
 */
function ProspectDetailsTab({
  model,
  enriching,
  scope,
}: {
  model: ProspectDetailsModel
  enriching: boolean
  scope: string
}) {
  const hasAnything = model.fieldCount > 0 || model.unverified.length > 0
  return (
    <div className="space-y-7 px-8 pb-10 pt-6">
      <DetailsStatusLine model={model} enriching={enriching} subject={scope} />
      {!hasAnything ? (
        <DetailsEmptyState
          foundNothing={model.status === 'enriched'}
          sources={model.sources}
          fills="size, headquarters, funding, leadership, products and signals"
          scope={scope}
        />
      ) : (
        <>
          {model.sections.map((section) => (
            <DetailSectionView key={section.key} section={section} />
          ))}
          <UnverifiedGroup fields={model.unverified} scope={scope} />
          <SourcesList sources={model.sources} />
        </>
      )}
    </div>
  )
}

/**
 * "1 found, already in this list" — what the last people search saw, when it
 * kept nobody. Each known person is named with the rule that turned them
 * away and, when the duplicate is on this list, the account it sits under,
 * as a link that opens it. This is the state that read as "No people found
 * yet" while the real firm's partners sat under a ghost row of the same name.
 */
function KnownPeopleNote({
  search,
  lookupEntry,
  onOpenEntry,
  bare = false,
}: {
  search: ProspectPeopleSearch
  lookupEntry?: (id: string) => ProspectListEntryRow | undefined
  onOpenEntry?: (entry: ProspectListEntryRow) => void
  /** Without the summary line — the People tab's empty state already leads
   *  with it. */
  bare?: boolean
}) {
  return (
    <div
      data-prospect-people-known
      className={cn('space-y-1 text-xs text-muted-foreground', !bare && 'px-2')}
    >
      {!bare && (
        <p>
          {knownPeopleSummary(search)}
          {search.capped > 0 ? `, ${search.capped} more than you asked for` : ''}.
        </p>
      )}
      <ul className="space-y-0.5">
        {search.known.map((known, i) => {
          const ref = known.ref_id && lookupEntry ? lookupEntry(known.ref_id) : undefined
          const parent =
            ref?.parent_entry_id && lookupEntry ? lookupEntry(ref.parent_entry_id) : undefined
          const parentCandidate = parent ? candidateOf(parent) : null
          const name = known.name ?? (ref ? candidateOf(ref).name : null) ?? 'Someone'
          const where = parentCandidate
            ? ` under ${parentCandidate.name ?? parentCandidate.domain ?? 'another row'}${
                parentCandidate.domain && parentCandidate.name ? ` (${parentCandidate.domain})` : ''
              }`
            : ''
          return (
            <li key={`${known.ref_id ?? known.name ?? 'k'}-${i}`} className="flex flex-wrap items-baseline gap-x-1">
              {ref && onOpenEntry ? (
                <button
                  type="button"
                  data-prospect-known-person={ref.id}
                  onClick={() => onOpenEntry(ref)}
                  className="text-foreground hover:underline"
                >
                  {name}
                </button>
              ) : (
                <span className="text-foreground">{name}</span>
              )}
              <span>
                · {KNOWN_PEOPLE_PHRASES[known.by]}
                {where}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** One person found at the company — name, title, the email dot, the stage. */
function PersonRow({
  person,
  onOpen,
}: {
  person: ProspectListEntryRow
  onOpen?: (person: ProspectListEntryRow) => void
}) {
  const candidate = candidateOf(person)
  const name = candidate.name?.trim() || candidate.title?.trim() || person.candidate_key
  const email = candidate.email?.trim() ?? ''
  const needsReview = person.identity_state === 'needs_review'
  return (
    <button
      type="button"
      data-prospect-person-row={person.id}
      onClick={() => onOpen?.(person)}
      disabled={!onOpen}
      className="group/row flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{name}</span>
        {candidate.title && (
          <span className="block truncate text-xs text-muted-foreground">{candidate.title}</span>
        )}
      </span>
      {email && (
        <span
          aria-hidden="true"
          title={email}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
        />
      )}
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {person.stage === 'dismissed'
          ? 'Dismissed'
          : needsReview
            ? 'Needs review'
            : person.stage === 'saved'
              ? person.published_at
                ? 'In your CRM'
                : 'On the list'
              : 'Verified'}
      </span>
    </button>
  )
}

// ============================================================
// Person
// ============================================================

const PERSON_TABS = ['overview', 'details'] as const
type PersonTab = (typeof PERSON_TABS)[number]

/**
 * A discovered PERSON, before Save — the contact panel's plan.
 *
 * WHAT REPLACES THE MATCH BLOCK: an identity block. Fit is scored on the
 * ACCOUNT, not on the person — a grade beside someone's name would be a
 * number nobody computed — so the question this panel has to answer is the
 * one the people stage actually risks getting wrong: is this the right person
 * at the right company? `identity_state` is that answer, and the line under
 * it names the mechanism: anchored via the company's own domain, or needs
 * review because nothing on that domain confirmed it.
 *
 * SAVE IS LIVE, AND GATED HERE. Save keeps an unverified person on the list
 * like anyone else; it is PUBLISH that holds them back (the list publish
 * skips `needs_review`). So on a saved, unpublished, unverified person the
 * toolbar offers "Publish anyway", the first click states what could not be
 * confirmed in a band under the toolbar — beside the Identity block that is
 * the evidence — and the second click carries `confirmUnverified` for THIS
 * ONE id. Bulk save has no such affordance on purpose.
 *
 * ADD TO SEQUENCE is Save-then-enroll (§8) and is disabled with the reason on
 * it when there is no email — which is most discovered people, and is why the
 * email state is a property row rather than a footnote.
 */
function PersonPanel({
  entry,
  busy = false,
  onSave,
  onDismiss,
  onOpenParent,
  parentName,
  onAddToSequence,
  sequenced,
}: EntryPanelProps) {
  const [tab, setTab] = useState<PersonTab>('overview')
  /** The two-click gate for an unconfirmed employer — see the header. */
  const [confirming, setConfirming] = useState(false)
  // The panel is reused as prev/next steps between people: an armed confirm
  // belongs to the person it was armed on, never the next one.
  useEffect(() => {
    setConfirming(false)
  }, [entry.id])
  const candidate = candidateOf(entry)
  const model = useMemo(() => buildProspectDetails(entry), [entry])
  const relevance = useMemo(() => personRelevance(entry), [entry])

  // Never empty, and title before key: an unnamed person with a job title is
  // legible; a linkedin slug as a heading is not.
  const displayName =
    candidate.name?.trim() || candidate.title?.trim() || entry.candidate_key || 'Unknown person'
  const company = parentName?.trim() || candidate.company_name?.trim() || candidate.domain || ''
  const title = candidate.title?.trim() || researchValue(entry.research, 'job_title')
  const seniority = candidate.seniority?.trim() || researchValue(entry.research, 'seniority')
  const scope = candidate.domain || displayName
  const dismissed = entry.stage === 'dismissed'
  const saved = entry.stage === 'saved'
  /** In the CRM group already (migration 259) — saved AND published. */
  const published = Boolean(entry.published_at)
  const needsReview = entry.identity_state === 'needs_review'
  const linkedin = (candidate.linkedin_url?.trim() || researchValue(entry.research, 'linkedin_url')) ?? ''
  const linkedinHref = linkedin
    ? linkedin.startsWith('http')
      ? linkedin
      : `https://${linkedin}`
    : ''
  const email = candidate.email?.trim() ?? ''
  const hasDetails =
    model.fieldCount > 0 || model.unverified.length > 0 || model.sources.length > 0
  /** The people card writes the same sentence as the one-liner AND as
   *  `why_relevant` for most people; when they match, the Relevance block —
   *  which carries the source — is the one copy. */
  const description = candidate.one_liner?.trim() || null
  const showDescription =
    description !== null &&
    !(relevance && normalise(relevance.value) === normalise(description))

  /** The parent account, as a link when the page can open it. A person
   *  entry's `company_id` is NULL by construction, so this is the ONLY route
   *  from a person back to the account that produced them. */
  const companyNode = company ? (
    entry.parent_entry_id && onOpenParent ? (
      <button
        type="button"
        onClick={() => onOpenParent(entry.parent_entry_id as string)}
        className="min-w-0 truncate text-left hover:text-foreground hover:underline"
      >
        {company}
      </button>
    ) : (
      <span className="min-w-0 truncate">{company}</span>
    )
  ) : null

  const verbs = (
    <>
      {/* Publish-then-enroll. Hidden once they are already in a sequence
          (re-enrolling is a Sequences-page decision, not a triage one) and
          disabled with the reason when there is no address to send to. */}
      {onAddToSequence && !sequenced && (
        <PreferenceActionButton
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          disabled={busy || dismissed || !email}
          title={email ? 'Publish to your CRM, then add to a sequence' : NO_EMAIL_REASON}
          onClick={onAddToSequence}
        >
          <Send className="h-3.5 w-3.5" />
          Add to sequence
        </PreferenceActionButton>
      )}
      {/* THE NAMESAKE GATE'S ESCAPE HATCH — asked once someone has looked at
          the Identity block: publish this one anyway? */}
      {needsReview && saved && !published && !confirming && (
        <PreferenceActionButton
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={busy}
          title="The list publish held this person back — write them to your CRM anyway"
          onClick={() => setConfirming(true)}
        >
          Publish anyway
        </PreferenceActionButton>
      )}
      {(onAddToSequence && !sequenced) || (needsReview && saved && !published && !confirming) ? (
        <VerbDivider />
      ) : null}
      <PreferenceActionButton
        variant="ghost"
        size="sm"
        className="h-7 text-xs"
        onClick={onDismiss}
        disabled={busy || dismissed}
      >
        {dismissed ? 'Dismissed' : 'Dismiss'}
      </PreferenceActionButton>
      <PreferenceActionButton
        size="sm"
        className="h-7 text-xs"
        disabled={busy || saved || dismissed}
        title={
          saved
            ? published
              ? 'On the list and in your CRM'
              : 'On the list — reaches your CRM when the list is published'
            : 'Keep this person (and their company) on the list'
        }
        onClick={() => onSave()}
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {saved ? (published ? 'In your CRM' : 'On the list') : 'Save to list'}
      </PreferenceActionButton>
    </>
  )

  /** THE CONFIRM LINE, as a band under the toolbar rather than a dialog: the
   *  evidence for the judgement is the Identity block directly beneath, and
   *  a modal would cover the one thing the user needs to read to answer. */
  const notice = confirming && needsReview && saved && !published ? (
    <div
      data-unverified-confirm
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-amber-500/[0.06] px-5 py-2"
    >
      <p className="min-w-0 flex-1 text-xs leading-snug">
        {`This person could not be verified at ${company || 'this company'}. Publish anyway?`}
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setConfirming(false)}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => {
            setConfirming(false)
            onSave({ confirmUnverified: true })
          }}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Publish anyway
        </Button>
      </div>
    </div>
  ) : null

  const sidebar = (
    <>
      <PropertyGroup title="Properties">
        <FactRow icon={<Briefcase className={ROW_ICON} />} value={title} label="Job title" />
        {company && (
          <div className="group/row flex h-8 items-center gap-2 px-2 text-sm">
            <Building2 className={ROW_ICON} />
            {companyNode}
            <CopyValueButton value={company} label="Company" />
          </div>
        )}
        <FactRow icon={<UserRound className={ROW_ICON} />} value={seniority} label="Seniority" />
        {/* Contact routes, and the honest absence of one. Most discovered
            people have LinkedIn and no email, and that is what decides
            whether they can be sequenced later. */}
        {email ? (
          <FactRow
            data-prospect-email=""
            icon={<Mail className={ROW_ICON} />}
            value={email}
            href={`mailto:${email}`}
            label="Email"
          />
        ) : (
          <InfoRow data-prospect-no-email="" icon={<Mail className={ROW_ICON} />}>
            <span className="italic text-muted-foreground/70">No email found</span>
          </InfoRow>
        )}
        {linkedinHref && (
          <div className="group/row flex h-8 items-center gap-2 px-2">
            <ExternalLink className={ROW_ICON} />
            <a
              data-prospect-linkedin
              href={linkedinHref}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate text-sm hover:underline"
              title={linkedin}
            >
              LinkedIn
            </a>
            <CopyValueButton value={linkedinHref} label="LinkedIn URL" />
          </div>
        )}
      </PropertyGroup>

      <PropertyGroup title="Prospecting">
        <InfoRow icon={<Telescope className={ROW_ICON} />} muted={false}>
          {stageText(entry)}
        </InfoRow>
        {candidate.found_via && (
          <InfoRow icon={<Search className={ROW_ICON} />}>
            {FOUND_VIA_LABELS[candidate.found_via] ?? candidate.found_via}
          </InfoRow>
        )}
        {/* DERIVED from `sequence_enrollment` at read time (§8) — there is no
            `stage='contacted'` and nothing cached on the entry, so this cannot
            claim a membership that a sequence edit elsewhere has ended. */}
        {sequenced && (
          <InfoRow icon={<Send className={ROW_ICON} />}>
            <span
              data-prospect-sequenced={sequenced.status}
              title={sequencedTitle(sequenced)}
              className={cn(
                'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px]',
                sequenced.status === 'active'
                  ? 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400'
                  : 'border-border/60 bg-muted/40 text-muted-foreground',
              )}
            >
              {sequencedLabel(sequenced)}
            </span>
          </InfoRow>
        )}
      </PropertyGroup>
    </>
  )

  return (
    <PanelFrame
      tabs={PERSON_TABS}
      activeTab={tab}
      onTab={setTab}
      verbs={verbs}
      notice={notice}
      contentKey={entry.id}
      sidebar={sidebar}
    >
      {tab === 'overview' && (
        <ScrollArea className="h-full">
          <div className="space-y-5 px-8 pb-10">
            {/* Avatar + name + the identity chip, where the contact panel
                puts its avatar, name and Enriched badge. */}
            <div className="pb-2 pt-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base font-medium text-primary">
                  {displayName.charAt(0).toUpperCase()}
                </div>
                <div className="group/row flex min-w-0 flex-1 items-center gap-1">
                  <h1 className="min-w-0 truncate text-lg font-semibold">{displayName}</h1>
                  <CopyValueButton value={displayName} label="name" />
                </div>
                <span
                  data-prospect-identity={entry.identity_state}
                  className={cn(
                    'inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium',
                    needsReview
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                  )}
                >
                  {needsReview ? (
                    <CircleDashed className="h-3 w-3" />
                  ) : (
                    <BadgeCheck className="h-3 w-3" />
                  )}
                  {needsReview ? 'Needs review' : 'Verified'}
                </span>
              </div>
              {(title || company) && (
                <div className="mt-1.5 flex min-w-0 items-center gap-1.5 pl-[52px] text-xs text-muted-foreground">
                  {title && <span className="min-w-0 truncate">{title}</span>}
                  {title && companyNode && <span>·</span>}
                  {companyNode}
                </div>
              )}
            </div>

            {showDescription && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Description</Label>
                <p className="px-2 text-sm leading-relaxed">{description}</p>
              </div>
            )}

            {/* ── Identity ──
                What the match block is for a company, this is for a person:
                the one judgement the stage can get wrong, stated with the
                mechanism behind it rather than as a bare chip. */}
            <section className="space-y-2">
              <p className="text-sm font-medium">Identity</p>
              <div className="flex items-start gap-2 px-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                    needsReview ? 'bg-amber-500' : 'bg-emerald-500',
                  )}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className={cn('text-sm', needsReview && 'text-muted-foreground')}>
                    {IDENTITY_STATE_LABELS[entry.identity_state] ?? entry.identity_state}
                  </p>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {needsReview
                      ? `Nothing on ${candidate.domain || 'the company site'} confirmed this person works there, so they are held back from bulk save. Check the sources under Details before publishing.`
                      : `Confirmed from ${candidate.domain || 'the company site'} — the search was restricted to that domain, so a namesake elsewhere could not land here.`}
                  </p>
                </div>
              </div>
            </section>

            {/* Why this person matters — the people card's own sentence,
                with its source dot. */}
            {relevance && (
              <section className="space-y-1.5">
                <p className="text-sm font-medium">Relevance</p>
                <BlockField field={relevance} />
              </section>
            )}
          </div>
        </ScrollArea>
      )}

      {tab === 'details' && (
        <ScrollArea className="h-full">
          <div className="space-y-7 px-8 pb-10 pt-6">
            {!hasDetails ? (
              <p className="text-sm text-muted-foreground">Nothing beyond the profile itself.</p>
            ) : (
              <>
                {model.sections.map((section) => (
                  <DetailSectionView key={section.key} section={section} />
                ))}
                <UnverifiedGroup fields={model.unverified} scope={scope} />
                <SourcesList sources={model.sources} />
              </>
            )}
          </div>
        </ScrollArea>
      )}
    </PanelFrame>
  )
}
