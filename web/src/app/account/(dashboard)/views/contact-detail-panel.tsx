'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

import dynamic from 'next/dynamic'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { usePanelSection } from './use-panel-section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
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
import {
  Building2,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Globe,
  ListTodo,
  Loader2,
  Mail,
  MapPin,
  Mic,
  Phone,
  Plus,
  Share2,
  Sparkles,
  Trash2,
  User,
  Users,
  X,
} from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CustomFieldsGroup } from '@/components/crm/custom-fields-group'
import { ReferencedIn } from '@/components/entity-links/referenced-in'
import { RecordHistory } from '@/components/entity-links/record-history'
import { useCurrentMemberId } from '@/app/account/workspace-switcher'
import { ContentTransition } from './transitions'
import { NoteEditor } from './note-editor-lazy'
import { Comments } from '../components/comments'
import { EntityActionsMenu, PANEL_OMIT } from '@/components/entities/entity-actions-menu'
import { EmailThreadDetail } from '@/components/email/email-thread-detail'
import { ContactShareDialog } from '../components/contact-share-dialog'
import { ContactDuplicatesDialog } from '../components/contact-duplicates-dialog'
import { EntityTitleInput } from '@/components/views/entity-title-input'
import { usePropertiesVisible } from '@/components/views/use-properties-visible'
import { WindowProperties, WindowActions } from '@/components/views/window-properties'
import { UnifiedViewLayout } from '@/components/views/unified-view-layout'
import { PropertyGroup } from '@/components/views/property-group'
import { TextPropertyRow } from '@/components/views/properties/text-property-row'
import { CopyValueButton } from '@/components/views/copy-value-button'
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
import { HubspotHoldBadge } from '@/components/views/hubspot-hold'
import { ContactDetailsTab } from './contact-details-tab'
import {
  EnumPanelField,
  CompanyPanelField,
  type CompanyOption as PickerCompanyOption,
} from '@/components/views/properties'
import { NO_MATCH_FILTER_VALUE, type ViewFilter } from '@/lib/views/types'
import { useEntityDetailSync, useEntityListSync } from '@/hooks/use-entity-sync'
import { AddToSequenceDialog } from '@/components/sequences/add-to-sequence-dialog'
import {
  fetchContactEnrollments,
  type ContactEnrollment,
} from '../sequences/api'
import { emitEntityUpdated } from '@/lib/entity-events'
import { startFindContactEmail } from '../prospecting/start-event'

// ============================================================
// Types
// ============================================================

interface ContactDetail {
  id: string
  full_name: string
  first_name: string | null
  last_name: string | null
  email: string | null
  secondary_emails: string[]
  phone: string | null
  job_title: string | null
  department: string | null
  linkedin_url: string | null
  avatar_url: string | null
  relationship_type: string
  relationship_strength: string
  last_interaction_at: string | null
  interaction_count: number
  next_followup_at: string | null
  visibility: 'private' | 'team' | 'workspace'
  member_id: string | null
  created_by_member_id: string | null
  notes: string | null
  tags: string[]
  // Web enrichment (see @/components/views/enrichment). The job writes the
  // structured columns directly; everything without a column — plus the model's
  // summary and its sources — lands in metadata.enrichment.
  enrichment_status?: EnrichmentStatus | null
  enriched_at?: string | null
  metadata?: ({ enrichment?: EnrichmentMetadata } & Record<string, unknown>) | null
  company: { id: string; name: string; domain: string | null; industry: string | null } | null
  interactions: Array<{
    id: string
    interaction_type: string
    title: string | null
    occurred_at: string
    reference_type: string | null
    reference_id: string | null
  }>
  captures: Array<{
    id: string
    title: string
    ai_summary: string | null
    started_at: string | null
    ended_at: string | null
    status: string
  }>
  email_threads: Array<{
    id: string
    provider_thread_id: string
    subject: string | null
    snippet: string | null
    last_message_at: string | null
    needs_reply: boolean
  }>
  open_actions: Array<{
    id: string
    title: string
    identifier: string
    priority: string
    due_at: string | null
  }>
  actions: Array<{
    id: string
    title: string
    identifier: string
    priority: string
    due_at: string | null
    status_name: string | null
    status_category: string | null
    status_color: string | null
  }>
}

interface CompanyOption {
  id: string
  name: string
}

// One claim linked to this contact, from the knowledge graph
// (GET /api/account/knowledge/entity-context?type=contact).
interface EntityClaim {
  id: string
  text: string
  type: string
  confirmation: string
  status: string
  event_at: string | null
  created_at: string
  excerpt: { excerpt: string; source_type: string } | null
}

// Compact label per claim type for the badge.
const CLAIM_TYPE_LABEL: Record<string, string> = {
  fact: 'Fact',
  open_question: 'Question',
  inference: 'Inference',
  decision_summary: 'Decision',
}

// ============================================================
// Config
// ============================================================

const INTERACTION_ICONS: Record<string, typeof Mic> = {
  capture: Mic,
  email_sent: Mail,
  email_received: Mail,
  action_assigned: ListTodo,
  action_completed: ListTodo,
  note_added: Globe,
}

/** How long the "Finding…" state waits for an address before giving up. The
 *  skill runs a handful of web searches and possibly an inbox scan; two minutes
 *  covers a slow run without stranding the button on a search that found
 *  nothing (which writes nothing, so nothing would ever clear it). */
const FIND_EMAIL_TIMEOUT_MS = 120_000

const STRENGTH_CONFIG: Record<string, { label: string; dot: string }> = {
  strong: { label: 'Strong', dot: 'bg-emerald-500' },
  warm: { label: 'Warm', dot: 'bg-amber-500' },
  neutral: { label: 'Neutral', dot: 'bg-gray-400' },
  cold: { label: 'Cold', dot: 'bg-blue-500' },
  stale: { label: 'Stale', dot: 'bg-red-500' },
}

const TYPE_CONFIG: Record<string, string> = {
  contact: 'Contact',
  lead: 'Lead',
  customer: 'Customer',
  partner: 'Partner',
  vendor: 'Vendor',
  internal: 'Internal',
  candidate: 'Candidate',
}

// Everything the enricher found that has no column of its own (seniority,
// location, expertise, previous roles, education…) is rendered by the Details
// tab — see contact-details-tab.tsx and the catalog in @/lib/crm/contact-details.

// ============================================================
// Component
// ============================================================

// The Agents tab (plan row 10): the agents that worked on this, loaded when opened.
const EntityActivitySection = dynamic(
  () => import('@/components/work/entity-activity-tab').then((m) => m.EntityActivitySection),
  { ssr: false },
)

// Overview = the editable record, notes and activity; Details = every known
// fact as structured fields (the enrichment made first-class); then the
// per-entity lists.
const CONTACT_SECTIONS = ['overview', 'details', 'actions', 'captures', 'sequences', 'deals', 'agents'] as const
type ContactSection = (typeof CONTACT_SECTIONS)[number]

interface ContactDetailPanelProps {
  contactId: string
  /** Active inner tab, restored from navigation history. */
  section?: string
  /** Switch the inner tab — pushes a history step so Back returns to the prior tab. */
  onSectionChange?: (section: string) => void
  onClose: () => void
  onUpdate?: () => void
  onDeleted?: () => void
  onOpenCapture?: (captureId: string, title: string, event?: React.MouseEvent) => void
  onSelectAction?: (actionId: string, title: string, event?: React.MouseEvent) => void
  /** Open a sequence's detail page (sequences are bespoke pages — the host
   *  navigates to a `{ kind: 'sequence' }` location, not a detail panel). */
  onOpenSequence?: (sequenceId: string, name: string, event?: React.MouseEvent) => void
  /** Open one of the contact's deals (roadmap #8). */
  onOpenDeal?: (dealId: string, name: string, event?: React.MouseEvent) => void
}

export function ContactDetailPanel({
  contactId,
  section,
  onSectionChange,
  onClose,
  onUpdate,
  onDeleted,
  onOpenCapture,
  onSelectAction,
  onOpenSequence,
  onOpenDeal,
}: ContactDetailPanelProps) {
  const [contact, setContact] = useState<ContactDetail | null>(null)
  // For the Listen brief's fallback line, read when it plays.
  const contactRef = useRef(contact)
  contactRef.current = contact
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  // The page-level inspector owns visibility; standalone panels use their width.
  const panelBodyRef = useRef<HTMLDivElement>(null)
  const propertiesOpen = usePropertiesVisible(panelBodyRef)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [duplicatesOpen, setDuplicatesOpen] = useState(false)
  const [activeTab, setActiveTab] = usePanelSection<ContactSection>(section, onSectionChange, 'overview', CONTACT_SECTIONS)
  // Known synchronously from the workspace-switcher context — passed to
  // Comments so it doesn't refetch the workspace payload on every mount.
  const currentMemberId = useCurrentMemberId()

  // Related data for pickers
  const [companies, setCompanies] = useState<CompanyOption[]>([])
  const [newSecondaryEmail, setNewSecondaryEmail] = useState('')
  /**
   * "Find email" is in flight — the chat strip is working on it.
   *
   * There is no request to await: the click dispatches a window event and the
   * answer comes back as a realtime contact update. So this is cleared by the
   * arrival of an email (the effect below), never by a response — and it has a
   * timeout, because a search that finds nothing writes nothing and would
   * otherwise leave the row spinning forever.
   */
  const [findingEmail, setFindingEmail] = useState(false)
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)

  // Knowledge: claims linked to this contact (commitments & facts).
  const [claims, setClaims] = useState<EntityClaim[]>([])

  // Sequences: this contact's enrollments (active + history).
  const [enrollments, setEnrollments] = useState<ContactEnrollment[] | null>(null)
  const [addToSequenceOpen, setAddToSequenceOpen] = useState(false)

  const notesTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const nameTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Animate properties sidebar mount/unmount

  // Fetch contact
  const fetchContact = useCallback(async () => {
    setLoading(true)
    setContact(null)
    const res = await fetch(`/api/account/contacts/${contactId}`)
    if (res.ok) {
      const data = await res.json()
      setContact(data.contact)
    }
    setLoading(false)
  }, [contactId])

  // Quiet reload for background sync (remote update, contact_interaction) — keeps
  // the current record on screen while refreshing instead of flashing "Loading".
  const reloadContact = useCallback(async () => {
    const res = await fetch(`/api/account/contacts/${contactId}`)
    if (!res.ok) return
    const data = await res.json()
    setContact(data.contact)
  }, [contactId])

  useEffect(() => {
    fetchContact()
  }, [fetchContact])

  // Fetch knowledge-graph claims linked to this contact. Best-effort — the
  // section simply stays hidden if the request fails or returns nothing.
  const refetchClaims = useCallback(() => {
    fetch(`/api/account/knowledge/entity-context?type=contact&id=${contactId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.claims) setClaims(d.claims as EntityClaim[])
      })
      .catch(() => {})
  }, [contactId])

  useEffect(() => {
    setClaims([])
    refetchClaims()
  }, [contactId, refetchClaims])

  // Sequence enrollments — feeds the tab's count badge and the "Add to
  // sequence" gate (one active sequence per contact is a hard engine rule).
  // The tab's LIST is the embedded views experience below; best-effort here.
  const refetchEnrollments = useCallback(() => {
    fetchContactEnrollments(contactId)
      .then(setEnrollments)
      .catch(() => setEnrollments([]))
  }, [contactId])

  useEffect(() => {
    setEnrollments(null)
    refetchEnrollments()
  }, [contactId, refetchEnrollments])

  // Live-update the Sequences tab on enrollment events scoped to this contact
  // (deletes carry only the pk — let those through): refresh the badge/CTA
  // data, and re-dispatch as a `sequence` entity-created event — the seam the
  // embedded UnifiedViewLayout already refetches on (same bridge as
  // SequencesView; enrollment rows never touch the sequence row itself, so
  // without it the embed's membership and enrollment cells would go stale).
  const syncSequenceData = useCallback(() => {
    refetchEnrollments()
    window.dispatchEvent(
      new CustomEvent('dial8:entity-created', { detail: { entityType: 'sequence' } }),
    )
  }, [refetchEnrollments])

  useEntityListSync(['sequence_enrollment'], syncSequenceData, {
    match: (d) => d.fields?.contact_id == null || d.fields.contact_id === contactId,
  })

  // Live sync: refetch on any remote contact update, close on remote delete.
  useEntityDetailSync('contact', contactId, {
    refetch: reloadContact,
    onDeleted: () => {
      onDeleted?.()
      onClose()
    },
  })

  // Knowledge section: refetch claims when a claim changes, or when an
  // entity_link touching this contact is added/removed (a new claim about the
  // contact arrives as a claim INSERT + an entity_link INSERT). entity_link
  // events are scoped to this contact; claim events pass through (the raw claim
  // row carries no contact linkage) and the refetch confirms relevance.
  useEntityListSync(['claim', 'entity_link'], refetchClaims, {
    match: (d) => {
      if (d.entityType === 'claim') return true
      const f = d.fields
      if (!f) return true
      return f.source_id === contactId || f.target_id === contactId
    },
  })

  // Activity feed lives inside the contact payload (contact.interactions), so a
  // new interaction for this contact is picked up by a full reload.
  useEntityListSync(['contact_interaction'], reloadContact, {
    match: (d) => !d.fields || d.fields.contact_id === contactId,
  })

  // Fetch companies for picker
  useEffect(() => {
    fetch('/api/account/companies')
      .then((r) => r.json())
      .then((d) => {
        setCompanies(
          (d.companies || []).map((c: { id: string; name: string }) => ({
            id: c.id,
            name: c.name,
          })),
        )
      })
      .catch(() => {})
  }, [])

  // The two ways "Finding…" ends. An address arriving is the success case —
  // useEntityDetailSync refetches the row when the skill's update_contact lands
  // (contact is REPLICA IDENTITY FULL), so the spinner resolves on its own. The
  // timer is the other case: a search that finds nothing writes nothing, and a
  // permanently spinning button is worse than one that quietly comes back.
  const contactEmail = contact?.email
  useEffect(() => {
    if (!findingEmail) return
    if (contactEmail?.trim()) {
      setFindingEmail(false)
      return
    }
    const t = setTimeout(() => setFindingEmail(false), FIND_EMAIL_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [findingEmail, contactEmail])

  const handleFindEmail = useCallback(() => {
    if (!contact) return
    setFindingEmail(true)
    startFindContactEmail({
      contactId: contact.id,
      contactName: contact.full_name,
      jobTitle: contact.job_title,
      companyName: contact.company?.name ?? null,
      companyDomain: contact.company?.domain ?? null,
      linkedinUrl: contact.linkedin_url,
    })
  }, [contact])

  async function patchContact(updates: Record<string, unknown>) {
    // Optimistic update — reflect the change immediately so fields feel instant.
    setContact((prev) => (prev ? { ...prev, ...updates } : prev))
    setSaving(true)
    let res: Response | null = null
    try {
      res = await fetch(`/api/account/contacts/${contactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
    } catch {
      // Network failure — handled below like a rejected save.
    }
    if (res?.ok) {
      const data = await res.json()
      setContact((prev) => (prev ? { ...prev, ...data.contact } : prev))
      // Fan the change out to every other surface + arm self-echo suppression so
      // reloadContact (the detail-sync refetch) can't clobber an in-flight Notes
      // or Name edit with this tab's own realtime echo.
      emitEntityUpdated({ entityType: 'contact', id: contactId, fields: updates })
      onUpdate?.()
    } else {
      // The optimistic value never saved — put the server's record back.
      toast.error('Failed to save contact')
      void reloadContact()
    }
    setSaving(false)
  }

  function handleNameChange(value: string) {
    if (!contact) return
    setContact({ ...contact, full_name: value })
    if (nameTimeoutRef.current) clearTimeout(nameTimeoutRef.current)
    nameTimeoutRef.current = setTimeout(() => {
      patchContact({ full_name: value })
    }, 500)
  }

  function handleNotesChange(value: string) {
    if (!contact) return
    if (notesTimeoutRef.current) clearTimeout(notesTimeoutRef.current)
    notesTimeoutRef.current = setTimeout(() => {
      patchContact({ notes: value })
    }, 500)
  }

  function handleFollowupSelect(date: Date | undefined) {
    patchContact({ next_followup_at: date ? date.toISOString() : null })
  }

  async function handleDelete() {
    setDeleting(true)
    const res = await fetch(`/api/account/contacts/${contactId}`, { method: 'DELETE' })
    if (res.ok) {
      onDeleted?.()
      onClose()
    }
    setDeleting(false)
    setDeleteConfirm(false)
  }

  // Web enrichment. The server job pushes nothing on completion, so the hook
  // polls this panel's own detail GET while the row sits at 'pending' — which
  // also resumes automatically when the panel opens on an already-running job.
  const {
    enrich,
    busy: enriching,
    error: enrichError,
  } = useEnrichment<ContactDetail>({
    endpoint: 'contacts',
    responseKey: 'contact',
    id: contactId,
    row: contact,
    onRefreshed: (fresh) => {
      setContact((prev) => (prev ? { ...prev, ...fresh } : prev))
      // Only fan out once the job is done — the optimistic 'pending' flip is a
      // local affordance, not a row change other surfaces need.
      if (fresh.enrichment_status && fresh.enrichment_status !== 'pending') {
        emitEntityUpdated({ entityType: 'contact', id: contactId, fields: { ...fresh } })
        onUpdate?.()
      }
    },
  })

  // The Details tab reads the linked company by name; the relation isn't a
  // text column, so hand it over as one alongside the row.
  const detailsContact = useMemo(
    () => (contact ? { ...contact, company_name: contact.company?.name ?? null } : null),
    [contact],
  )

  const followupDate = contact?.next_followup_at ? new Date(contact.next_followup_at) : undefined

  // Inject the contact's current company so it renders immediately, even before
  // the companies lookup list finishes loading.
  const currentCompany = contact?.company
  const companyOptions = useMemo<PickerCompanyOption[]>(() => {
    const list: PickerCompanyOption[] = companies.map((c) => ({ id: c.id, name: c.name, domain: null, logo_url: null }))
    if (currentCompany && !list.some((c) => c.id === currentCompany.id)) {
      list.unshift({ id: currentCompany.id, name: currentCompany.name, domain: currentCompany.domain, logo_url: null })
    }
    return list
  }, [companies, currentCompany])

  // Scope filters for UnifiedViewLayout tabs — restrict to this contact's data
  const captureIds = useMemo(() => (contact?.captures ?? []).map(c => c.id), [contact?.captures])

  const captureScopeFilters = useMemo<ViewFilter[]>(() => {
    if (captureIds.length === 0) return [{ id: '__scope_contact', field: 'id', operator: 'is', value: NO_MATCH_FILTER_VALUE }]
    return [{ id: '__scope_contact', field: 'id', operator: 'is_any_of', value: captureIds }]
  }, [captureIds])

  // Actions related to this contact: assigned to them (if workspace member)
  // AND/OR extracted from captures they participated in.
  // The contact API pre-computes this union, so we use the resulting IDs.
  const actionIds = useMemo(() => (contact?.actions ?? []).map(a => a.id), [contact?.actions])
  const actionScopeFilters = useMemo<ViewFilter[]>(() => {
    if (actionIds.length > 0) {
      return [{ id: '__scope_contact', field: 'id', operator: 'is_any_of', value: actionIds }]
    }
    // No pre-fetched actions — fall back to live query by assignee or capture source
    if (contact?.member_id) {
      return [{ id: '__scope_contact', field: 'assignee_id', operator: 'is', value: contact.member_id }]
    }
    if (captureIds.length > 0) {
      return [{ id: '__scope_contact', field: 'source_capture_id', operator: 'is_any_of', value: captureIds }]
    }
    return [{ id: '__scope_contact', field: 'id', operator: 'is', value: NO_MATCH_FILTER_VALUE }]
  }, [actionIds, captureIds, contact?.member_id])

  // Sequences with an enrollment for this contact. `enrolled_contact_id` is an
  // internal query-engine scope field (EXISTS on sequence_enrollment), hidden
  // from the filter picker like the id-based scopes above — and it also tells
  // the views/query route to merge this contact's own enrollment status onto
  // each row (the 'enrollment' display property).
  const sequenceScopeFilters = useMemo<ViewFilter[]>(
    () => [{ id: '__scope_contact', field: 'enrolled_contact_id', operator: 'is', value: contactId }],
    [contactId],
  )

  // The deals this contact is on (roadmap #8): `contact_ids` is an array
  // column, so `includes` is a `@>` predicate.
  const dealScopeFilters = useMemo<ViewFilter[]>(
    () => [{ id: '__scope_contact', field: 'contact_ids', operator: 'includes', value: [contactId] }],
    [contactId],
  )

  // Badge = distinct sequences (what the embedded list shows), not raw
  // enrollment rows — a contact re-enrolled twice in one sequence is one row.
  const sequenceCount = useMemo(
    () => new Set((enrollments ?? []).map((e) => e.sequence_id)).size,
    [enrollments],
  )
  const hasActiveEnrollment = (enrollments ?? []).some((e) => e.status === 'active')

  return (
    <div className="relative flex h-full flex-col">
      {/* Listen mode: a few spoken sentences about this person as their page opens. */}
      <ListenBrief
        kind="contact"
        id={contactId}
        fallback={() => {
          const c = contactRef.current
          return plainLine(c?.full_name, c?.job_title, c?.company?.name)
        }}
      />

      {/* Sub-header toolbar */}
      <div className="flex h-10 shrink-0 items-center px-3">
        <div className="flex items-center gap-1">
          {CONTACT_SECTIONS.map(tab => (
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
              {tab === 'actions' && contact && contact.actions.length > 0 && (
                <span className="ml-1.5 text-[10px] opacity-70">{contact.actions.length}</span>
              )}
              {tab === 'captures' && contact && contact.captures.length > 0 && (
                <span className="ml-1.5 text-[10px] opacity-70">{contact.captures.length}</span>
              )}
              {tab === 'sequences' && sequenceCount > 0 && (
                <span className="ml-1.5 text-[10px] opacity-70">{sequenceCount}</span>
              )}
            </button>
          ))}
        </div>
        <WindowActions className="ml-auto flex items-center gap-1">
          {/* Sequences tab CTA — lives in the panel's toolbar (the embed body
                    below is the shared views experience and carries no bespoke
                    chrome). Enrolling is only offered when nothing is active — one
                    active sequence per contact is a hard engine rule. */}
          {activeTab === 'sequences' && enrollments !== null && !hasActiveEnrollment && (
            <PreferenceActionButton
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => setAddToSequenceOpen(true)}
            >
              <Plus className="h-3 w-3" />
              Add to sequence
            </PreferenceActionButton>
          )}
          {saving && <span className="text-xs text-muted-foreground">Saving...</span>}
          {enrichError && <EnrichError message={enrichError} />}
          {/* Enrich from web — fills empty fields from public sources and files
                    the provenance under Enrichment in the properties sidebar. */}
          {contact && <EnrichButton onClick={enrich} busy={enriching} />}
          {contact && <EntityActionsMenu entity={{ type: 'contact', id: contactId, label: contact.full_name }} omit={PANEL_OMIT} />}
          {/* Find & merge duplicates */}
          {contact && (
            <PreferenceActionButton
              label="Find duplicates"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground"
              onClick={() => setDuplicatesOpen(true)}
              title="Find duplicates"
            >
              <Users className="h-3.5 w-3.5" />
            </PreferenceActionButton>
          )}
          {/* Share */}
          {contact && (
            <ContactShareDialog
              contactId={contactId}
              contactName={contact.full_name}
              visibility={contact.visibility || 'workspace'}
              onVisibilityChange={(v) => {
                setContact((prev) => (prev ? { ...prev, visibility: v } : prev))
                onUpdate?.()
              }}
              trigger={
                <PreferenceActionButton
                  label="Share"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground"
                >
                  <Share2 className="h-3.5 w-3.5" />
                </PreferenceActionButton>
              }
            />
          )}
          {/* Delete */}
          <PreferenceActionButton
            label="Delete contact"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500"
            onClick={() => setDeleteConfirm(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </PreferenceActionButton>
        </WindowActions>
      </div>

      <ContentTransition contentKey={contactId} className="flex min-h-0 flex-1 flex-col">
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-sm text-muted-foreground">Loading...</div>
          </div>
        ) : !contact ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-sm text-muted-foreground">Contact not found</div>
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
                    {/* Avatar + Name */}
                    <div className="pt-6 pb-2">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base font-medium text-primary">
                          {contact.avatar_url ? (
                            <img src={contact.avatar_url} alt="" className="h-full w-full rounded-full object-cover" />
                          ) : (
                            contact.full_name.charAt(0).toUpperCase()
                          )}
                        </div>
                        <EntityTitleInput
                          className="text-lg"
                          value={contact.full_name}
                          onChange={handleNameChange}
                          placeholder="Unnamed contact"
                        />
                        {/* Some of the fields below were filled from the web,
                            not typed by a person — say so up front. */}
                        <EnrichedBadge row={contact} />
                        {/* Created by an unattended run and held from HubSpot
                            until a person releases it (Sequence step 2). */}
                        <HubspotHoldBadge contactId={contact.id} metadata={contact.metadata} onReleased={() => void reloadContact()} />
                      </div>
                    </div>

                    {/* Notes */}
                    <div className="space-y-2">
                      <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                        Notes
                      </Label>
                      <NoteEditor
                        key={contactId}
                        initialContent={contact.notes || ''}
                        onUpdate={handleNotesChange}
                        placeholder="Add notes..."
                      />
                    </div>

                    {/* Recent Activity */}
                    <div className="space-y-2">
                      <p className="text-sm font-medium">Recent Activity</p>
                      {contact.interactions.length === 0 ? (
                        <p className="px-2 text-xs text-muted-foreground">No activity yet.</p>
                      ) : (
                        <div className="space-y-1">
                          {contact.interactions.slice(0, 10).map((interaction) => {
                            const Icon = INTERACTION_ICONS[interaction.interaction_type] || Globe
                            return (
                              <div key={interaction.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs">
                                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted">
                                  <Icon className="h-3 w-3 text-muted-foreground" />
                                </div>
                                <span className="min-w-0 flex-1 truncate">{interaction.title || interaction.interaction_type}</span>
                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                  {relativeTime(interaction.occurred_at)}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    {/* Stats — moved out of the sidebar to sit with Recent
                        Activity: both summarise this contact's history rather
                        than being fields you set. */}
                    <div className="space-y-2">
                      <p className="text-sm font-medium">Stats</p>
                      <div className="space-y-1 px-2 text-xs text-muted-foreground">
                        <div className="flex items-center justify-between">
                          <span>Interactions</span>
                          <span className="font-medium text-foreground">{contact.interaction_count}</span>
                        </div>
                        {contact.last_interaction_at && (
                          <div className="flex items-center justify-between">
                            <span>Last interaction</span>
                            <span className="font-medium text-foreground">{relativeTime(contact.last_interaction_at)}</span>
                          </div>
                        )}
                        <div className="flex items-center justify-between">
                          <span>Meetings</span>
                          <span className="font-medium text-foreground">{contact.captures.length}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Email threads</span>
                          <span className="font-medium text-foreground">{contact.email_threads.length}</span>
                        </div>
                      </div>
                    </div>

                    {/* Knowledge — claims linked to this contact (commitments
                        & facts, incl. non-member commitments filed as
                        about-edges). Omitted entirely when empty. */}
                    {claims.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Knowledge</p>
                        <div className="space-y-1.5">
                          {claims.map((claim) => (
                            <div
                              key={claim.id}
                              className="rounded-md border px-2.5 py-2 text-xs"
                            >
                              <div className="flex items-start gap-2">
                                <span className="min-w-0 flex-1 leading-snug">{claim.text}</span>
                                <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
                                  {relativeTime(claim.event_at || claim.created_at)}
                                </span>
                              </div>
                              <div className="mt-1.5 flex items-center gap-1.5">
                                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                                  {CLAIM_TYPE_LABEL[claim.type] || claim.type}
                                </Badge>
                                {claim.confirmation === 'confirmed' ? (
                                  <span className="text-[10px] text-emerald-600 dark:text-emerald-400">Confirmed</span>
                                ) : claim.confirmation === 'suggested' ? (
                                  <span className="text-[10px] text-muted-foreground">Suggested</span>
                                ) : null}
                              </div>
                              {claim.excerpt && (
                                <p className="mt-1.5 border-l-2 border-border pl-2 text-[11px] italic text-muted-foreground line-clamp-2">
                                  &ldquo;{claim.excerpt.excerpt}&rdquo;
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Email Threads */}
                    {contact.email_threads.length > 0 && (
                      // `ph-no-capture`: thread subjects; session replay blocks them.
                      <div className="ph-no-capture space-y-2">
                        <p className="text-sm font-medium">Emails ({contact.email_threads.length})</p>
                        <div className="space-y-1">
                          {contact.email_threads.map((thread) => (
                            <button
                              key={thread.id}
                              onClick={() => setOpenThreadId(thread.provider_thread_id)}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
                            >
                              <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1 truncate">{thread.subject || '(No subject)'}</span>
                              {thread.needs_reply && (
                                <Badge variant="destructive" className="text-[10px] px-1.5 py-0">Reply</Badge>
                              )}
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {thread.last_message_at ? relativeTime(thread.last_message_at) : ''}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Comments */}
                    <div className="space-y-3">
                      <p className="text-sm font-medium">Comments</p>
                      <Comments commentableType="contact" commentableId={contact.id} currentMemberId={currentMemberId} />
                    </div>
                  </div>
                </ScrollArea>
              )}

              {activeTab === 'details' && detailsContact && (
                <ScrollArea className="h-full">
                  <ContactDetailsTab contact={detailsContact} enriching={enriching} />
                </ScrollArea>
              )}

              {activeTab === 'actions' && (
                <UnifiedViewLayout
                  key={`contact-actions-${contactId}`}
                  entityType="action"
                  onItemSelect={(id, title, event) => onSelectAction?.(id, title, event)}
                  scopeFilters={actionScopeFilters}
                  viewScope={{ type: 'contact', id: contactId }}
                />
              )}

              {activeTab === 'captures' && (
                <UnifiedViewLayout
                  key={`contact-captures-${contactId}`}
                  entityType="capture"
                  onItemSelect={(id, title, event) => onOpenCapture?.(id, title ?? '', event)}
                  scopeFilters={captureScopeFilters}
                  viewScope={{ type: 'contact', id: contactId }}
                />
              )}

              {activeTab === 'sequences' && (
                <UnifiedViewLayout
                  key={`contact-sequences-${contactId}`}
                  entityType="sequence"
                  onItemSelect={(id, title, event) => onOpenSequence?.(id, title || 'Sequence', event)}
                  scopeFilters={sequenceScopeFilters}
                  viewScope={{ type: 'contact', id: contactId }}
                />
              )}

              {activeTab === 'deals' && (
                <UnifiedViewLayout
                  key={`contact-deals-${contactId}`}
                  entityType="deal"
                  onItemSelect={(id, title, event) => onOpenDeal?.(id, title || 'Deal', event)}
                  scopeFilters={dealScopeFilters}
                  viewScope={{ type: 'contact', id: contactId }}
                />
              )}

              {activeTab === 'agents' && (
                <div className="min-h-0 flex-1 overflow-y-auto px-5">
                  <EntityActivitySection entityType="contact" entityId={contactId} />
                </div>
              )}
            </div>

            {/* Page-level properties inspector. */}
            <WindowProperties key={contactId} title={contact.full_name || 'Contact'} fallbackVisible={propertiesOpen}>
                    <div className="p-4 space-y-4">
                      {/* One Properties group — relationship, details, company
                          and follow-up were each their own titled card. */}
                      <PropertyGroup title="Properties">
                        {/* Type */}
                        <EnumPanelField
                          value={contact.relationship_type}
                          options={Object.entries(TYPE_CONFIG).map(([value, label]) => ({ value, label }))}
                          onChange={(v) => patchContact({ relationship_type: v })}
                          placeholder="Set type"
                          icon={<User className="h-4 w-4 shrink-0 text-muted-foreground" />}
                        />

                        {/* Strength */}
                        <EnumPanelField
                          value={contact.relationship_strength}
                          options={Object.entries(STRENGTH_CONFIG).map(([value, cfg]) => ({ value, label: cfg.label, dot: cfg.dot }))}
                          onChange={(v) => patchContact({ relationship_strength: v })}
                          placeholder="Set strength"
                        />
                        {/* Text rows share TextPropertyRow: icon, inline
                            input, hover copy button, enrichment mark. */}
                        <TextPropertyRow
                          icon={<MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          value={contact.job_title}
                          onChange={(v) => setContact({ ...contact, job_title: v })}
                          onCommit={(v) => patchContact({ job_title: v || null })}
                          placeholder="Job title"
                          adornment={
                            <EnrichedFieldMark enrichment={contact.metadata?.enrichment} field="job_title" />
                          }
                        />
                        <TextPropertyRow
                          icon={<Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          value={contact.department}
                          onChange={(v) => setContact({ ...contact, department: v })}
                          onCommit={(v) => patchContact({ department: v || null })}
                          placeholder="Department"
                          adornment={
                            <EnrichedFieldMark enrichment={contact.metadata?.enrichment} field="department" />
                          }
                        />
                        {/* The email row carries the one affordance the other
                            rows don't: when it's EMPTY, a "Find email" button
                            that hands the contact to the find-email skill in
                            the chat strip. */}
                        <TextPropertyRow
                          icon={<Mail className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          value={contact.email}
                          onChange={(v) => setContact({ ...contact, email: v })}
                          onCommit={(v) => patchContact({ email: v || null })}
                          placeholder="Email"
                          adornment={
                            contact.email?.trim() ? null : (
                              <FindEmailButton busy={findingEmail} onClick={handleFindEmail} />
                            )
                          }
                        />

                        {/* Secondary Emails */}
                        {contact.secondary_emails.map((se, i) => (
                          <div key={i} className="group/row flex h-8 items-center gap-2 px-2">
                            <Mail className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{se}</span>
                            <CopyValueButton value={se} label="Email" />
                            <button
                              className="shrink-0 text-muted-foreground hover:text-foreground"
                              onClick={() => {
                                const updated = contact.secondary_emails.filter((_, j) => j !== i)
                                setContact({ ...contact, secondary_emails: updated })
                                patchContact({ secondary_emails: updated })
                              }}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                        <div className="flex h-8 items-center gap-2 px-2">
                          <Plus className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                          <input
                            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                            value={newSecondaryEmail}
                            onChange={(e) => setNewSecondaryEmail(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && newSecondaryEmail.trim()) {
                                const updated = [...contact.secondary_emails, newSecondaryEmail.trim().toLowerCase()]
                                setContact({ ...contact, secondary_emails: updated })
                                patchContact({ secondary_emails: updated })
                                setNewSecondaryEmail('')
                              }
                            }}
                            placeholder="Add email..."
                          />
                        </div>

                        <TextPropertyRow
                          icon={<Phone className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          value={contact.phone}
                          onChange={(v) => setContact({ ...contact, phone: v })}
                          onCommit={(v) => patchContact({ phone: v || null })}
                          placeholder="Phone"
                        />
                        <TextPropertyRow
                          icon={<ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          value={contact.linkedin_url}
                          onChange={(v) => setContact({ ...contact, linkedin_url: v })}
                          onCommit={(v) => patchContact({ linkedin_url: v || null })}
                          placeholder="LinkedIn URL"
                          adornment={
                            <EnrichedFieldMark enrichment={contact.metadata?.enrichment} field="linkedin_url" />
                          }
                        />
                        <CompanyPanelField
                          value={contact.company?.id ?? null}
                          companies={companyOptions}
                          onChange={(v) => {
                            // Optimistically update the displayed company — the picker
                            // reads contact.company, not company_id.
                            const co = companies.find((c) => c.id === v)
                            setContact((prev) => prev ? {
                              ...prev,
                              company: co ? { id: co.id, name: co.name, domain: null, industry: null } : null,
                            } : prev)
                            patchContact({ company_id: v })
                          }}
                          placeholder="Set company"
                        />
                        <Popover>
                          <PopoverTrigger asChild>
                            <button className={cn(
                              'flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-muted/50',
                              !followupDate && 'text-muted-foreground',
                            )}>
                              <CalendarIcon className="h-4 w-4 shrink-0" />
                              <span>{followupDate ? formatDateForPicker(followupDate) : 'Set follow-up date'}</span>
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="start">
                            <Calendar mode="single" selected={followupDate} onSelect={handleFollowupSelect} initialFocus />
                            {followupDate && (
                              <div className="border-t p-2">
                                <Button variant="ghost" size="sm" className="w-full text-xs text-muted-foreground" onClick={() => patchContact({ next_followup_at: null })}>
                                  Remove date
                                </Button>
                              </div>
                            )}
                          </PopoverContent>
                        </Popover>

                        {/* Free-text tags used to be edited here. The UI is gone
                            pending CRM moving onto the shared Labels system; the
                            `tags` column, its API, filtering and AI tools all
                            stay, so the existing values are preserved for that
                            migration. */}
                      </PropertyGroup>

                      {/* Enrichment status + a pointer to the Details tab,
                          which holds the structured fields and sources.
                          showSummary=false: the enricher writes the bio
                          paragraph into contact.notes, so the Notes editor
                          already shows it. */}
                      <EnrichmentSection
                        enrichment={contact.metadata?.enrichment}
                        showSummary={false}
                        onViewDetails={() => setActiveTab('details')}
                      />
                      {/* The workspace's own fields on this kind (hidden while it has none). */}
                      <CustomFieldsGroup entityType="contact" recordId={contactId} />
                      <ReferencedIn entityType="contact" entityId={contactId} />
                      <RecordHistory entityType="contact" entityId={contactId} />
                    </div>
                  </WindowProperties>
          </div>
        )}
      </ContentTransition>

      {/* Add to sequence (Sequences tab CTA). onEnrolled refreshes the badge
          AND bridges to the embedded list — the realtime enrollment event
          also arrives, but this makes the row show up without the round-trip. */}
      <AddToSequenceDialog
        contactIds={[contactId]}
        open={addToSequenceOpen}
        onOpenChange={setAddToSequenceOpen}
        onEnrolled={syncSequenceData}
      />

      {/* Possible duplicates */}
      {contact && (
        <ContactDuplicatesDialog
          open={duplicatesOpen}
          onOpenChange={setDuplicatesOpen}
          contactId={contactId}
          contactName={contact.full_name}
          onMerged={() => {
            fetchContact()
            onUpdate?.()
          }}
        />
      )}

      {/* Delete confirmation */}
      <AlertDialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete contact</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{contact?.full_name}&rdquo; and all associated interaction records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Email thread side panel */}
      {openThreadId && (
        <>
          {/* Backdrop — click to close */}
          <div
            className="absolute inset-0 z-20"
            onClick={() => setOpenThreadId(null)}
          />
          {/* Panel */}
          <div className="absolute inset-y-2 right-2 z-30 flex w-[min(480px,calc(100%-16px))] flex-col rounded-lg border bg-background shadow-xl animate-in slide-in-from-right-4 fade-in duration-150">
            <EmailThreadDetail
              threadId={openThreadId}
              onClose={() => setOpenThreadId(null)}
              onPrev={(() => {
                if (!contact) return undefined
                const idx = contact.email_threads.findIndex((t) => t.provider_thread_id === openThreadId)
                return idx > 0 ? () => setOpenThreadId(contact.email_threads[idx - 1].provider_thread_id) : undefined
              })()}
              onNext={(() => {
                if (!contact) return undefined
                const idx = contact.email_threads.findIndex((t) => t.provider_thread_id === openThreadId)
                return idx >= 0 && idx < contact.email_threads.length - 1
                  ? () => setOpenThreadId(contact.email_threads[idx + 1].provider_thread_id)
                  : undefined
              })()}
            />
          </div>
        </>
      )}
    </div>
  )
}

// ============================================================
// Helpers
// ============================================================

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

function formatDateForPicker(date: Date): string {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = new Date(today.getTime() + 86400000)
  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  if (dateOnly.getTime() === today.getTime()) return 'Today'
  if (dateOnly.getTime() === tomorrow.getTime()) return 'Tomorrow'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ============================================================
// Find email — the button on an empty email row
// ============================================================

/**
 * The affordance on the email row when there is no address (Liam, 2026-09-10:
 * "a button on the email field if it's missing that says Find email").
 *
 * It renders in TextPropertyRow's `adornment` slot, where EnrichedFieldMark
 * sits on the other rows — same 8px-dense row, same ghost-button idiom as
 * EnrichButton in @/components/views/enrichment, so the two web-research
 * affordances in this panel read as one thing. Unlike EnrichButton it keeps its
 * label: a bare sparkle on an empty field is a mystery, and this row is the one
 * place the user is being offered something specific.
 *
 * It dispatches and forgets. The work happens in the chat strip beside the
 * panel (the find-email skill), and the answer arrives back here as a realtime
 * contact update — which is what clears `busy`, not a response to this click.
 */
function FindEmailButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 shrink-0 gap-1 px-1.5 text-xs text-muted-foreground"
      onClick={onClick}
      disabled={busy}
      title="Find this contact's work email"
    >
      {busy ? (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          Finding…
        </>
      ) : (
        <>
          <Sparkles className="h-3 w-3" />
          Find email
        </>
      )}
    </Button>
  )
}
