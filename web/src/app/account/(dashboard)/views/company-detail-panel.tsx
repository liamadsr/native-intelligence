'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import dynamic from 'next/dynamic'
import { usePanelSection } from './use-panel-section'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Building2,
  Factory,
  Globe,
  Link as LinkIcon,
  Mail,
  MapPin,
  Mic,
  Phone,
  Trash2,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CustomFieldsGroup } from '@/components/crm/custom-fields-group'
import { ReferencedIn } from '@/components/entity-links/referenced-in'
import { RecordHistory } from '@/components/entity-links/record-history'
import { ContentTransition } from './transitions'
import { EntityActionsMenu, PANEL_OMIT } from '@/components/entities/entity-actions-menu'
import { EntityTitleInput } from '@/components/views/entity-title-input'
import { usePropertiesVisible } from '@/components/views/use-properties-visible'
import { WindowProperties, WindowActions } from '@/components/views/window-properties'
import { UnifiedViewLayout } from '@/components/views/unified-view-layout'
import { PropertyGroup } from '@/components/views/property-group'
import {
  EnrichButton,
  EnrichedBadge,
  EnrichedFieldMark,
  EnrichError,
  EnrichmentSection,
  useEnrichment,
  type EnrichmentMetadata,
  type EnrichmentStatus,
} from '@/components/views/enrichment'
import { ListenBrief } from '@/components/read-aloud/listen-brief'
import { plainLine } from '@/lib/read-aloud/listen-briefs'
import { EnumPanelField } from '@/components/views/properties'
import { TextPropertyRow } from '@/components/views/properties/text-property-row'
import { CopyValueButton } from '@/components/views/copy-value-button'
import { CompanyDetailsTab } from './company-details-tab'
import type { ViewFilter } from '@/lib/views/types'
import { useEntityDetailSync } from '@/hooks/use-entity-sync'
import { emitEntityUpdated } from '@/lib/entity-events'
import { CompanyDeleteDialog } from '@/components/views/bulk-actions/company-delete-dialog'

// ============================================================
// Types
// ============================================================

interface CompanyDetail {
  id: string
  name: string
  domain: string | null
  website: string | null
  industry: string | null
  description: string | null
  logo_url: string | null
  employee_count_range: string | null
  annual_revenue_range?: string | null
  address: string | null
  phone: string | null
  contact_email: string | null
  city: string | null
  state: string | null
  country: string | null
  tags: string[]
  // Web enrichment (see @/components/views/enrichment). The job writes the
  // structured columns directly; everything without a column — plus the model's
  // summary and its sources — lands in metadata.enrichment.
  enrichment_status?: EnrichmentStatus | null
  enriched_at?: string | null
  metadata?: ({ enrichment?: EnrichmentMetadata } & Record<string, unknown>) | null
  contacts: Array<{
    id: string
    full_name: string
    email: string | null
    job_title: string | null
    relationship_type: string
    relationship_strength: string
    last_interaction_at: string | null
    avatar_url: string | null
  }>
  captures: Array<{
    id: string
    title: string
    ai_summary: string | null
    started_at: string | null
    status: string
  }>
}

// ============================================================
// Config
// ============================================================

// Mirrors the company `employee_count_range` enum in @/lib/views/types
// (filter definitions) and the HubSpot sync's bucketEmployeeCount.
const EMPLOYEE_COUNT_OPTIONS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+']

// Everything the enricher found that has no column of its own (funding,
// leadership, products, news…) is rendered by the Details tab — see
// company-details-tab.tsx and the catalog in @/lib/crm/company-details.

// ============================================================
// Component
// ============================================================

// The Agents tab (plan row 12): the agents that worked on this, loaded when opened.
const EntityActivitySection = dynamic(
  () => import('@/components/work/entity-activity-tab').then((m) => m.EntityActivitySection),
  { ssr: false },
)

// Overview = the editable record + activity; Details = every known fact as
// structured fields (the enrichment made first-class); People = the contacts;
// Agents = every agent interaction with it.
const COMPANY_SECTIONS = ['overview', 'details', 'people', 'deals', 'agents'] as const
type CompanySection = (typeof COMPANY_SECTIONS)[number]

interface CompanyDetailPanelProps {
  companyId: string
  /** Active inner tab, restored from navigation history. */
  section?: string
  /** Switch the inner tab — pushes a history step so Back returns to the prior tab. */
  onSectionChange?: (section: string) => void
  onClose: () => void
  onUpdate?: () => void
  onDeleted?: () => void
  onSelectContact?: (contactId: string, name: string, event?: React.MouseEvent) => void
  onOpenCapture?: (captureId: string, title: string, event?: React.MouseEvent) => void
  /** Open one of the company's deals (roadmap #8). */
  onOpenDeal?: (dealId: string, name: string, event?: React.MouseEvent) => void
}

export function CompanyDetailPanel({
  companyId,
  section,
  onSectionChange,
  onClose,
  onUpdate,
  onDeleted,
  onSelectContact,
  onOpenCapture,
  onOpenDeal,
}: CompanyDetailPanelProps) {
  const [company, setCompany] = useState<CompanyDetail | null>(null)
  // For the Listen brief's fallback line, read when it plays.
  const companyRef = useRef(company)
  companyRef.current = company
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  // The page-level inspector owns visibility; standalone panels use their width.
  const panelBodyRef = useRef<HTMLDivElement>(null)
  const propertiesOpen = usePropertiesVisible(panelBodyRef)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [activeTab, setActiveTab] = usePanelSection<CompanySection>(section, onSectionChange, 'overview', COMPANY_SECTIONS)

  const nameTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const descriptionTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Fetch company
  const fetchCompany = useCallback(async () => {
    setLoading(true)
    setCompany(null)
    const res = await fetch(`/api/account/companies/${companyId}`)
    if (res.ok) {
      const data = await res.json()
      setCompany(data.company)
    }
    setLoading(false)
  }, [companyId])

  // Quiet reload for background sync (remote update) — keeps the current
  // record on screen while refreshing instead of flashing "Loading".
  const reloadCompany = useCallback(async () => {
    const res = await fetch(`/api/account/companies/${companyId}`)
    if (!res.ok) return
    const data = await res.json()
    setCompany(data.company)
  }, [companyId])

  useEffect(() => {
    fetchCompany()
  }, [fetchCompany])

  // Live sync: refetch on any remote company update, close on remote delete.
  // onDeleted (tab-content's handleSimpleSidePanelDeleted) fully handles
  // navigation including the no-history fallback — onClose is only for a
  // parent that passes no onDeleted, never a follow-up.
  useEntityDetailSync('company', companyId, {
    refetch: reloadCompany,
    onDeleted: () => {
      if (onDeleted) onDeleted()
      else onClose()
    },
  })

  async function patchCompany(updates: Record<string, unknown>) {
    // Optimistic update — reflect the change immediately so fields feel instant.
    setCompany((prev) => (prev ? { ...prev, ...updates } : prev))
    setSaving(true)
    let res: Response | null = null
    try {
      res = await fetch(`/api/account/companies/${companyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
    } catch {
      // Network failure — handled below like a rejected save.
    }
    if (res?.ok) {
      const data = await res.json()
      setCompany((prev) => (prev ? { ...prev, ...data.company } : prev))
      // Fan the change out to every other surface + arm self-echo suppression so
      // reloadCompany (the detail-sync refetch) can't clobber an in-flight Name
      // or Description edit with this tab's own realtime echo.
      emitEntityUpdated({ entityType: 'company', id: companyId, fields: updates })
      onUpdate?.()
    } else {
      // The optimistic value never saved — put the server's record back.
      toast.error('Failed to save company')
      void reloadCompany()
    }
    setSaving(false)
  }

  function handleNameChange(value: string) {
    if (!company) return
    setCompany({ ...company, name: value })
    if (nameTimeoutRef.current) clearTimeout(nameTimeoutRef.current)
    nameTimeoutRef.current = setTimeout(() => {
      patchCompany({ name: value })
    }, 500)
  }

  function handleDescriptionChange(value: string) {
    if (!company) return
    setCompany({ ...company, description: value })
    if (descriptionTimeoutRef.current) clearTimeout(descriptionTimeoutRef.current)
    descriptionTimeoutRef.current = setTimeout(() => {
      patchCompany({ description: value || null })
    }, 500)
  }

  // Web enrichment. The server job pushes nothing on completion, so the hook
  // polls this panel's own detail GET while the row sits at 'pending' — which
  // also resumes automatically when the panel opens on an already-running job.
  const {
    enrich,
    busy: enriching,
    error: enrichError,
  } = useEnrichment<CompanyDetail>({
    endpoint: 'companies',
    responseKey: 'company',
    id: companyId,
    row: company,
    onRefreshed: (fresh) => {
      setCompany((prev) => (prev ? { ...prev, ...fresh } : prev))
      // Only fan out once the job is done — the optimistic 'pending' flip is a
      // local affordance, not a row change other surfaces need.
      if (fresh.enrichment_status && fresh.enrichment_status !== 'pending') {
        emitEntityUpdated({ entityType: 'company', id: companyId, fields: { ...fresh } })
        onUpdate?.()
      }
    },
  })

  // Scope filter for the People tab's embedded UnifiedViewLayout — restrict to
  // this company's contacts. company_id is a registered contact filter (see
  // FILTERABLE_FIELDS), so this scope and a user-added Company filter go
  // through the exact same query-engine path.
  const peopleScopeFilters = useMemo<ViewFilter[]>(
    () => [{ id: '__scope_company', field: 'company_id', operator: 'is', value: companyId }],
    [companyId],
  )

  return (
    <div className="relative flex h-full flex-col">
      {/* Listen mode: a few spoken sentences about this company as its page opens. */}
      <ListenBrief
        kind="company"
        id={companyId}
        fallback={() => {
          const c = companyRef.current
          return plainLine(c?.name, c?.industry)
        }}
      />

      {/* Sub-header toolbar */}
      <div className="flex h-10 shrink-0 items-center px-3">
        <div className="flex items-center gap-1">
          {COMPANY_SECTIONS.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'inline-flex shrink-0 items-center px-3 py-1 text-xs rounded-full border transition-colors whitespace-nowrap',
                activeTab === tab
                  ? 'bg-foreground text-background border-foreground font-medium'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground',
              )}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              {tab === 'people' && company && company.contacts.length > 0 && (
                <span className="ml-1.5 text-[10px] opacity-70">{company.contacts.length}</span>
              )}
            </button>
          ))}
        </div>
        <WindowActions className="ml-auto flex items-center gap-1">
          {saving && <span className="text-xs text-muted-foreground">Saving...</span>}
          {enrichError && <EnrichError message={enrichError} />}
          {/* Enrich from web — fills empty fields from public sources and files
                    the provenance under Enrichment in the properties sidebar. */}
          {company && <EnrichButton onClick={enrich} busy={enriching} />}
          {company && <EntityActionsMenu entity={{ type: 'company', id: companyId, label: company.name }} omit={PANEL_OMIT} />}
          {/* Delete — cascades to every person at the company, so the dialog
                    dry-runs the delete and shows the exact people count first. */}
          <PreferenceActionButton
            label="Delete company"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </PreferenceActionButton>
        </WindowActions>
      </div>

      <ContentTransition contentKey={companyId} className="flex min-h-0 flex-1 flex-col">
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-sm text-muted-foreground">Loading...</div>
          </div>
        ) : !company ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-sm text-muted-foreground">Company not found</div>
          </div>
        ) : (
          <div ref={panelBodyRef} className="flex flex-1 min-h-0 justify-center">
            {/* Left: tab content */}
            <div className={cn(
              'w-full min-w-0 min-h-0 flex flex-col',
              (activeTab === 'overview' || activeTab === 'details') && 'mx-auto max-w-[736px]',
            )}>
              {activeTab === 'overview' && (
                <ScrollArea className="h-full">
                  <div className="px-8 pb-28 space-y-5">
                    {/* Logo + Name */}
                    <div className="pt-6 pb-2">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                          {company.logo_url ? (
                            <img src={company.logo_url} alt="" className="h-full w-full rounded-full object-cover" />
                          ) : (
                            <Building2 className="h-5 w-5" />
                          )}
                        </div>
                        <EntityTitleInput
                          className="text-lg"
                          value={company.name}
                          onChange={handleNameChange}
                          placeholder="Unnamed company"
                        />
                        {/* Some of the fields below were filled from the web,
                            not typed by a person — say so up front. */}
                        <EnrichedBadge row={company} />
                      </div>
                    </div>

                    {/* Description */}
                    <div className="space-y-2">
                      <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                        Description
                        {/* The only enrichment-written column with a real
                            label — the sidebar fields are icon + placeholder,
                            so their marks sit at the end of the row instead. */}
                        <EnrichedFieldMark
                          enrichment={company.metadata?.enrichment}
                          field="description"
                        />
                      </Label>
                      <AutoGrowTextarea
                        key={companyId}
                        value={company.description || ''}
                        onChange={handleDescriptionChange}
                        placeholder="Add a description..."
                      />
                    </div>

                    {/* Stats */}
                    <div className="space-y-2">
                      <p className="text-sm font-medium">Stats</p>
                      <div className="space-y-1 px-2 text-xs text-muted-foreground">
                        <div className="flex items-center justify-between">
                          <span>People</span>
                          <span className="font-medium text-foreground">{company.contacts.length}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Meetings</span>
                          <span className="font-medium text-foreground">{company.captures.length}</span>
                        </div>
                      </div>
                    </div>

                    {/* Recent Captures */}
                    <div className="space-y-2">
                      <p className="text-sm font-medium">Recent Captures</p>
                      {company.captures.length === 0 ? (
                        <p className="px-2 text-xs text-muted-foreground">No captures yet.</p>
                      ) : (
                        <div className="space-y-1">
                          {company.captures.slice(0, 10).map((capture) => (
                            <button
                              key={capture.id}
                              onClick={(e) => onOpenCapture?.(capture.id, capture.title, e)}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
                            >
                              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted">
                                <Mic className="h-3 w-3 text-muted-foreground" />
                              </div>
                              <span className="min-w-0 flex-1 truncate">{capture.title}</span>
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {capture.started_at ? relativeTime(capture.started_at) : ''}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </ScrollArea>
              )}

              {activeTab === 'details' && (
                <ScrollArea className="h-full">
                  <CompanyDetailsTab company={company} enriching={enriching} />
                </ScrollArea>
              )}

              {activeTab === 'people' && (
                <UnifiedViewLayout
                  key={`company-people-${companyId}`}
                  entityType="contact"
                  onItemSelect={(id, title, event) => onSelectContact?.(id, title, event)}
                  scopeFilters={peopleScopeFilters}
                  viewScope={{ type: 'company', id: companyId }}
                />
              )}

              {activeTab === 'deals' && (
                // The company's deals, the same list/board as the Deals page,
                // scoped to company_id (a registered deal filter).
                <UnifiedViewLayout
                  key={`company-deals-${companyId}`}
                  entityType="deal"
                  onItemSelect={(id, title, event) => onOpenDeal?.(id, title || 'Deal', event)}
                  scopeFilters={peopleScopeFilters}
                  viewScope={{ type: 'company', id: companyId }}
                />
              )}

              {activeTab === 'agents' && (
                <div className="min-h-0 flex-1 overflow-y-auto px-5">
                  <EntityActivitySection entityType="company" entityId={companyId} />
                </div>
              )}
            </div>

            {/* Page-level properties inspector. */}
            <WindowProperties key={companyId} title={company.name || 'Company'} fallbackVisible={propertiesOpen}>
                    <div className="p-4 space-y-4">
                      <PropertyGroup title="Properties">
                        {/* Every text row is a TextPropertyRow: icon, inline
                            input, hover copy button, then the enrichment mark
                            for columns the web run can write. */}
                        <TextPropertyRow
                          icon={<Globe className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          value={company.domain}
                          onChange={(v) => setCompany({ ...company, domain: v })}
                          onCommit={(v) => patchCompany({ domain: v || null })}
                          placeholder="Domain"
                        />
                        <TextPropertyRow
                          icon={<LinkIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          value={company.website}
                          onChange={(v) => setCompany({ ...company, website: v })}
                          onCommit={(v) => patchCompany({ website: v || null })}
                          placeholder="Website"
                          adornment={
                            <EnrichedFieldMark enrichment={company.metadata?.enrichment} field="website" />
                          }
                        />
                        <TextPropertyRow
                          icon={<Mail className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          value={company.contact_email}
                          onChange={(v) => setCompany({ ...company, contact_email: v })}
                          onCommit={(v) => patchCompany({ contact_email: v || null })}
                          placeholder="Contact email"
                          adornment={
                            <EnrichedFieldMark enrichment={company.metadata?.enrichment} field="contact_email" />
                          }
                        />
                        <TextPropertyRow
                          icon={<Phone className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          value={company.phone}
                          onChange={(v) => setCompany({ ...company, phone: v })}
                          onCommit={(v) => patchCompany({ phone: v || null })}
                          placeholder="Phone"
                          adornment={
                            <EnrichedFieldMark enrichment={company.metadata?.enrichment} field="phone" />
                          }
                        />
                        <TextPropertyRow
                          icon={<Factory className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          value={company.industry}
                          onChange={(v) => setCompany({ ...company, industry: v })}
                          onCommit={(v) => patchCompany({ industry: v || null })}
                          placeholder="Industry"
                          adornment={
                            <EnrichedFieldMark enrichment={company.metadata?.enrichment} field="industry" />
                          }
                        />

                        {/* Employee count. EnumPanelField owns its own full-width
                            h-8 row, so the copy button and enrichment mark ride
                            alongside it in a flex wrapper rather than inside the
                            trigger — the shared picker keeps no adornment slot. */}
                        <div className="group/row flex items-center gap-1 pr-2">
                          <div className="min-w-0 flex-1">
                            <EnumPanelField
                              value={company.employee_count_range}
                              options={EMPLOYEE_COUNT_OPTIONS.map((value) => ({ value, label: value }))}
                              onChange={(v) => patchCompany({ employee_count_range: v })}
                              placeholder="Set employee count"
                              icon={<Users className="h-4 w-4 shrink-0 text-muted-foreground" />}
                            />
                          </div>
                          <CopyValueButton value={company.employee_count_range} label="Employee count" />
                          <EnrichedFieldMark
                            enrichment={company.metadata?.enrichment}
                            field="employee_count_range"
                          />
                        </div>

                        <TextPropertyRow
                          icon={<MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          value={company.address}
                          onChange={(v) => setCompany({ ...company, address: v })}
                          onCommit={(v) => patchCompany({ address: v || null })}
                          placeholder="Address"
                          adornment={
                            <EnrichedFieldMark enrichment={company.metadata?.enrichment} field="address" />
                          }
                        />
                        <TextPropertyRow
                          icon={<MapPin className="h-4 w-4 shrink-0 text-muted-foreground/50" />}
                          value={company.city}
                          onChange={(v) => setCompany({ ...company, city: v })}
                          onCommit={(v) => patchCompany({ city: v || null })}
                          placeholder="City"
                          adornment={
                            <EnrichedFieldMark enrichment={company.metadata?.enrichment} field="city" />
                          }
                        />
                        <TextPropertyRow
                          icon={<MapPin className="h-4 w-4 shrink-0 text-muted-foreground/50" />}
                          value={company.state}
                          onChange={(v) => setCompany({ ...company, state: v })}
                          onCommit={(v) => patchCompany({ state: v || null })}
                          placeholder="State"
                          adornment={
                            <EnrichedFieldMark enrichment={company.metadata?.enrichment} field="state" />
                          }
                        />
                        <TextPropertyRow
                          icon={<MapPin className="h-4 w-4 shrink-0 text-muted-foreground/50" />}
                          value={company.country}
                          onChange={(v) => setCompany({ ...company, country: v })}
                          onCommit={(v) => patchCompany({ country: v || null })}
                          placeholder="Country"
                          adornment={
                            <EnrichedFieldMark enrichment={company.metadata?.enrichment} field="country" />
                          }
                        />

                        {/* No tags editor — same call as the contact panel:
                            the `tags` column, API and filtering stay, but the
                            UI waits for CRM to move onto the shared Labels
                            system. */}
                      </PropertyGroup>

                      {/* Enrichment status + summary. The structured fields
                          and sources live on the Details tab, so this stays a
                          short pointer rather than a second copy of them. */}
                      <EnrichmentSection
                        enrichment={company.metadata?.enrichment}
                        onViewDetails={() => setActiveTab('details')}
                      />
                      {/* The workspace's own fields on this kind (hidden while it has none). */}
                      <CustomFieldsGroup entityType="company" recordId={companyId} />
                      <ReferencedIn entityType="company" entityId={companyId} />
                      <RecordHistory entityType="company" entityId={companyId} />
                    </div>
                  </WindowProperties>
          </div>
        )}
      </ContentTransition>

      {/* Delete confirmation — dry-runs the cascade so the user sees exactly
          how many people go with the company before confirming. */}
      <CompanyDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        companyIds={[companyId]}
        companyName={company?.name}
        onDeleted={() => {
          // onDeleted handles navigation fully; onClose is the fallback for a
          // parent that passes no onDeleted, not a follow-up (a second close
          // would push a stray list entry on top of the stepped-back history).
          if (onDeleted) onDeleted()
          else onClose()
        }}
      />
    </div>
  )
}

// ============================================================
// Helpers
// ============================================================

/**
 * Description editor: same visual treatment as the panel's inline fields, but
 * multi-line and height-autosized (the NoteEditor is a full markdown document
 * editor — too heavy for a single plain-text column).
 */
function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  // Autosize to the content. Reset to 'auto' first so the box can shrink when
  // text is deleted, not just grow.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      rows={2}
      className="w-full resize-none bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  )
}

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`
  return `${Math.floor(diffDays / 365)}y ago`
}
