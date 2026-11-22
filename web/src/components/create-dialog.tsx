'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { parseISO } from 'date-fns'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as VisuallyHidden from '@radix-ui/react-visually-hidden'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
  CommandGroup,
} from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useScopedLabels } from '@/lib/labels/use-scoped-labels'
import { groupLabelsByGroupName, type LabelScope } from '@/lib/labels/utils'
import {
  Circle,
  Flag,
  User,
  Folder,
  Tag,
  RefreshCw,
  MoreHorizontal,
  Paperclip,
  Users,
  Calendar as CalendarIcon,
  Gauge,
  Milestone,
  Plus,
  X,
  GitBranchPlus,
  Trash2,
  ChevronsUpDown,
  Check,
  Target,
  Contact,
  Building2,
  Mail,
  Phone,
  Briefcase,
  LinkIcon,
  Send,
  MapPin,
  Video,
  Workflow,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Switch } from '@/components/ui/switch'
import { DateTimePicker } from '@/components/ui/datetime-picker'
import { EmailRecipientInput } from '@/components/email/email-recipient-input'
import { EmailComposer } from '@/components/email/email-composer'
import { composeDraftKey } from '@/lib/email/compose-drafts'
import { cn } from '@/lib/utils'
import { useHotkeys, useModKeyLabel } from '@/lib/hotkeys'
import { OPEN_CREATE_EVENT, createKeyAllowed, type OpenCreateRequest } from '@/lib/create/open-create'
import {
  availableCreateTypes,
  createTypeDef,
  isCreateTypeId,
  type CreateQuickTypeId,
  type CreateTypeId,
} from '@/lib/create/create-types'
import { openPageCreate } from '@/lib/create/page-create'
import { containerApplies, containerLabel, contextDefaults, type CreateContext } from '@/lib/create/create-context'
import { composerKeyIntent } from '@/lib/create/create-keys'
import { CreateMenu } from '@/components/create/create-menu'
import { tableTemplates } from '@/lib/tables/templates'
import { openCard } from '@/lib/chat-cards/open-card'
import { pagesFor } from '@/lib/chat-cards/page-menu'
import { useIsWorkspaceGuest, useWorkspaceEdition } from '@/app/account/workspace-switcher'
import { useIsDesktop } from '@/components/desktop-titlebar'
import { EntityIcon } from '@/components/entities/entity-icon'
import { CreateTypePicker, type CreateTypeOption } from '@/components/create/create-type-picker'
import { QUICK_CREATE } from '@/components/create/quick-create'
import { useTeams } from '@/app/account/teams-context'
import { openTarget, type OpenTarget } from '@/lib/chat-cards/open-card'
import { useTeamCalls } from '@/components/team-calls/team-calls-provider'
import { toast } from 'sonner'
import { PRIORITY_OPTIONS } from '@/lib/views/property-options'
import {
  PropertyPill as SharedPropertyPill,
  type PropertyPillProps,
} from '@/components/views/properties'
import { uploadAttachment, AttachmentUploadError } from '@/lib/attachments/upload-client'
import { patchCalendarEventsCache } from '@/calendar/hooks/use-calendar-events'
import { calendarEventToIEvent } from '@/calendar/adapters'
import type { CalendarEvent } from '@/lib/integrations/calendar'
import { ATTACHMENT_ACCEPT_ATTR, isAllowedAttachmentFile } from '@/lib/attachments/constants'

// ── Entity Types ────────────────────────────────────────

// Every type the dialog makes is in lib/create/create-types.ts (Liam, 11-20:
// "it supports every kind of thing the app can create now"): the six forms
// below, quick types (components/create/quick-create.ts) and the types whose
// page opens on its own create flow (lib/create/page-create.ts).
type CreateEntityType = CreateTypeId

/** A type's glyph: its kind's identity (lib/entities/entity-identity.ts), as the palette and the pickers draw it. */
const typeIcon = (id: CreateTypeId): React.ReactNode => <EntityIcon kind={id} size="sm" strokeWidth={2} />

const typeLabel = (id: CreateTypeId) => createTypeDef(id).label
const isQuickType = (id: CreateTypeId): id is CreateQuickTypeId => createTypeDef(id).mode === 'quick'

/**
 * A type whose making needs its own page: that page, on its own create flow
 * (Liam, 11-20: open it there, not copied into the dialog). A deal is added on
 * the Deals board itself; a flow in the canvas editor (the flows card's
 * `editing: '__new__'`, as its New flow).
 */
function openPageType(id: CreateTypeId): void {
  switch (id) {
    case 'deal':
      openTarget({ type: 'page', slug: 'deals' }, { from: 'create' })
      return
    case 'flow':
      openCard({ kind: 'flows', title: 'Flows' }, { from: 'create', seed: { editing: '__new__' } })
      return
    case 'agent':
    case 'skill':
      openPageCreate(id, 'agents')
      return
    case 'sequence':
      openPageCreate('sequence', 'sequences')
      return
    case 'prospect_list':
      openPageCreate('prospect_list', 'prospecting')
      return
    case 'campaign':
      openPageCreate('campaign', 'campaigns')
      return
    case 'booking_link':
      openPageCreate('booking_link', 'availability')
      return
    case 'studio_video':
      openPageCreate('studio_video', 'studio')
      return
  }
}

/** ↵: create and open it; ⌘/Ctrl ↵: create and stay for another (lib/create/create-keys.ts). */
type CreateMode = 'open' | 'another'

/** Where a form type's new record opens, as the app opens it (null: nothing to open, an email sent). */
export function createdTarget(type: CreateTypeId, made: Record<string, unknown>): OpenTarget | null {
  const id = typeof made.id === 'string' ? made.id : null
  if (!id) return null
  const name = (k: string) => (typeof made[k] === 'string' && made[k] ? (made[k] as string) : null)
  switch (type) {
    case 'action':
      return { type: 'action', id, title: name('identifier') ?? name('title') }
    case 'project':
      return { type: 'project', id, title: name('name') }
    case 'initiative':
      return { type: 'initiative', id, title: name('name') }
    case 'contact':
      return { type: 'contact', id, title: name('full_name') }
    case 'event':
      return { type: 'calendar-event', id, title: name('title'), start: name('start_time') ?? name('start') }
    default:
      return null
  }
}

function openCreated(type: CreateTypeId, made: Record<string, unknown>): void {
  const target = createdTarget(type, made)
  if (target) openTarget(target, { from: 'create' })
}

// ── Shared Types ────────────────────────────────────────

interface WorkflowState {
  id: string
  name: string
  category: string
  color: string
  sort_order: number
  is_default?: boolean
}

interface TeamMember {
  id: string
  display_name: string
  avatar_url: string | null
}

interface ProjectOption {
  id: string
  name: string
}

interface LabelOption {
  id: string
  name: string
  color: string
}

interface CycleOption {
  id: string
  name: string
  number: number
  status: string
}

interface MilestoneOption {
  id: string
  name: string
  status: string
}

interface InitiativeOption {
  id: string
  name: string
  status: string
}

interface CompanyOption {
  id: string
  name: string
  domain: string | null
}

const PROJECT_STATUS_OPTIONS = [
  { value: 'planned', label: 'Planned' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'canceled', label: 'Canceled' },
]

const INITIATIVE_STATUS_OPTIONS = [
  { value: 'planned', label: 'Planned' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
]

const RELATIONSHIP_TYPE_OPTIONS = [
  { value: 'contact', label: 'Contact' },
  { value: 'lead', label: 'Lead' },
  { value: 'customer', label: 'Customer' },
  { value: 'partner', label: 'Partner' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'internal', label: 'Internal' },
]

// Extra properties that can be toggled on via the "..." menu
type ExtraProperty = 'due_date' | 'estimate' | 'milestone'

const ACTION_EXTRA_PROPERTY_DEFS: { key: ExtraProperty; label: string; icon: React.ReactNode }[] = [
  { key: 'due_date', label: 'Due date', icon: <CalendarIcon className="mr-2 h-3.5 w-3.5" /> },
  { key: 'estimate', label: 'Estimate', icon: <Gauge className="mr-2 h-3.5 w-3.5" /> },
  { key: 'milestone', label: 'Milestone', icon: <Milestone className="mr-2 h-3.5 w-3.5" /> },
]

// ── Sub-action types ────────────────────────────────────

interface PendingSubAction {
  id: string
  title: string
  description: string
  statusId: string | null
  priority: string
  assigneeIds: string[]
  projectId: string | null
  labelIds: string[]
}

// ── Main component ───────────────────────────────────────

interface CreateDialogProps {
  onCreated?: (entity: Record<string, unknown>) => void
}

export function CreateDialog({ onCreated }: CreateDialogProps) {
  const [open, setOpen] = useState(false)
  const modKey = useModKeyLabel()
  const [entityType, setEntityType] = useState<CreateEntityType>('action')
  const [creating, setCreating] = useState(false)
  // The Create menu (every type, C and the rail's +) or a type's composer
  // (a page's New button, a pick from the menu, C then a letter).
  const [stage, setStage] = useState<'menu' | 'compose'>('compose')
  const [menuOpenedAt, setMenuOpenedAt] = useState(0)
  // Where it was opened (lib/create/create-context.ts): "Create in <name>",
  // the record a task links back to. Cleared with the form.
  const [context, setContext] = useState<CreateContext | null>(null)
  // A table's starter (lib/tables/templates.ts); null: blank.
  const [tableTemplate, setTableTemplate] = useState<string | null>(null)
  // Who sees a new channel: one team, or (null) everyone in the workspace.
  const [channelTeamId, setChannelTeamId] = useState<string | null>(null)

  // ── Shared fields ──
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')

  // ── Action-specific fields ──
  const [teamId, setTeamId] = useState<string | null>(null)
  const [statusId, setStatusId] = useState<string | null>(null)
  const [priority, setPriority] = useState('none')
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [labelIds, setLabelIds] = useState<string[]>([])
  const [cycleId, setCycleId] = useState<string | null>(null)
  const [dueDate, setDueDate] = useState('')
  const [estimate, setEstimate] = useState('')
  const [milestoneId, setMilestoneId] = useState<string | null>(null)
  const [visibleExtras, setVisibleExtras] = useState<Set<ExtraProperty>>(new Set())

  // ── Project-specific fields ──
  const [projectStatus, setProjectStatus] = useState('planned')
  const [leadId, setLeadId] = useState<string | null>(null)
  const [initiativeId, setInitiativeId] = useState<string | null>(null)
  const [startDate, setStartDate] = useState('')
  const [targetDate, setTargetDate] = useState('')

  // ── Initiative-specific fields ──
  const [initiativeStatus, setInitiativeStatus] = useState('planned')
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [initiativeTargetDate, setInitiativeTargetDate] = useState('')
  const [initiativeProjectIds, setInitiativeProjectIds] = useState<string[]>([])

  // ── Contact-specific fields ──
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [jobTitle, setJobTitle] = useState('')
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companySearch, setCompanySearch] = useState('')
  const [relationshipType, setRelationshipType] = useState('contact')
  const [linkedinUrl, setLinkedinUrl] = useState('')

  // ── Email: Mail's own composer (components/email/email-composer.tsx)
  // keeps what is written; the dialog only picks the From mailbox. ──

  // ── Event-specific fields ──
  const [eventStart, setEventStart] = useState<Date | undefined>(undefined)
  const [eventEnd, setEventEnd] = useState<Date | undefined>(undefined)
  const [eventLocation, setEventLocation] = useState('')
  // "Add a meeting link" (phase 7): a meeting of ours as the event's location, only when asked for.
  const [eventMeetingLink, setEventMeetingLink] = useState(false)
  const meetingLinks = useTeamCalls().available
  const [eventIsAllDay, setEventIsAllDay] = useState(false)
  const [eventAttendees, setEventAttendees] = useState<string[]>([])
  const [eventAccountId, setEventAccountId] = useState<string | undefined>(undefined)
  const [calendarAccounts, setCalendarAccounts] = useState<{ id: string; email: string; provider: string }[]>([])
  // The New email "From" picker: mail accounts only (a calendar connection
  // cannot send), with its own pick so it never borrows the event's account.
  const [emailAccountId, setEmailAccountId] = useState<string | undefined>(undefined)
  const [emailAccounts, setEmailAccounts] = useState<{ id: string; email: string; provider: string }[]>([])

  // ── Sub-actions (action only) ──
  const [pendingSubActions, setPendingSubActions] = useState<PendingSubAction[]>([])
  const [showSubActionForm, setShowSubActionForm] = useState(false)
  // ── Pending file attachments (action only) ──
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [subTitle, setSubTitle] = useState('')
  const [subDescription, setSubDescription] = useState('')
  const [subStatusId, setSubStatusId] = useState<string | null>(null)
  const [subPriority, setSubPriority] = useState('none')
  const [subAssigneeIds, setSubAssigneeIds] = useState<string[]>([])
  const [subProjectId, setSubProjectId] = useState<string | null>(null)
  const [subLabelIds, setSubLabelIds] = useState<string[]>([])
  const [subCreateMore, setSubCreateMore] = useState(false)
  const subTitleRef = useRef<HTMLInputElement>(null)

  // ── Options data ──
  const { teams } = useTeams()
  const [workflowStates, setWorkflowStates] = useState<WorkflowState[]>([])
  const [members, setMembers] = useState<TeamMember[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const labelScope: LabelScope | undefined = entityType === 'action' ? 'action' : entityType === 'project' ? 'project' : entityType === 'initiative' ? 'initiative' : undefined
  const { labels: scopedLabels } = useScopedLabels(labelScope)
  const labels = useMemo(() => scopedLabels as unknown as LabelOption[], [scopedLabels])
  const [cycles, setCycles] = useState<CycleOption[]>([])
  const [milestones, setMilestones] = useState<MilestoneOption[]>([])
  const [initiatives, setInitiatives] = useState<InitiativeOption[]>([])
  const [companies, setCompanies] = useState<CompanyOption[]>([])

  const titleRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Quick types: the second field (a company's domain, a channel's topic) ──
  const [quickSecondary, setQuickSecondary] = useState('')

  // ── The types this workspace can create: a type shows while its page is on (create-types.ts) ──
  const edition = useWorkspaceEdition()
  const guest = useIsWorkspaceGuest()
  const desktop = useIsDesktop()
  const typeOptions = useMemo<CreateTypeOption[]>(
    () =>
      availableCreateTypes(pagesFor(edition, { desktop, guest }).map((p) => p.slug)).map((t) => ({
        ...t,
        icon: typeIcon(t.id),
      })),
    [edition, desktop, guest],
  )

  function pickType(id: CreateTypeId) {
    if (createTypeDef(id).mode === 'page') {
      // Its page, on its own create flow; this dialog steps aside (what was typed stays for next time).
      setOpen(false)
      openPageType(id)
      return
    }
    setEntityType(id)
    setStage('compose')
    applyContext(id, context)
    setTimeout(() => titleRef.current?.focus(), 50)
  }

  /**
   * What the place it was opened in gives this type (create-context.ts):
   * an action's project or team, a project's initiative, a contact's
   * company, a doc's project; and the prefills. The person can change each.
   */
  function applyContext(type: CreateTypeId, ctx: CreateContext | null) {
    if (!ctx) return
    const d = contextDefaults(type, ctx)
    if (d.projectId) setProjectId(d.projectId)
    if (d.teamId) setTeamId(d.teamId)
    if (d.initiativeId) setInitiativeId(d.initiativeId)
    if (d.companyId) setCompanyId(d.companyId)
    if (type === 'channel' && d.teamId) setChannelTeamId(d.teamId)
    // A list group's + (group-create.ts): the action starts in that group.
    if (type === 'action' && ctx.preset) {
      const p = ctx.preset
      if (p.teamId) setTeamId(p.teamId)
      if (p.statusId) setStatusId(p.statusId)
      if (p.priority) setPriority(p.priority)
      if (p.projectId) setProjectId(p.projectId)
      if (p.assigneeId) setAssigneeIds([p.assigneeId])
    }
    const prefill = ctx.title ?? ctx.source?.title
    if (prefill) {
      setTitle(prefill)
    }
    if (ctx.description) {
      setDescription(ctx.description)
    }
    if (type === 'table' && ctx.template !== undefined) setTableTemplate(ctx.template ?? null)
  }

  /** The Create menu: every type, type to filter, C then a letter (create-menu.tsx). */
  function openMenu(ctx: CreateContext | null = null) {
    resetForm()
    setContext(ctx)
    setStage('menu')
    setMenuOpenedAt(Date.now())
    setOpen(true)
  }

  /** A type's composer, preset to where it was opened (a page's New button). */
  function openComposer(type: CreateTypeId, ctx: CreateContext | null = null) {
    // Mail keeps an unsent email between opens (closing it keeps the draft).
    if (type !== 'email' || entityType !== 'email') resetForm()
    setContext(ctx)
    setEntityType(type)
    setStage('compose')
    applyContext(type, ctx)
    setOpen(true)
  }

  // Resolve effective team
  const effectiveTeamId = teamId || teams[0]?.id
  const currentTeam = teams.find((t) => t.id === effectiveTeamId)

  // ── Open triggers ──
  // The rail's + and the app-wide `c` (Liam, 11-20: back after 10-20's
  // removal, "so anything can be created from one place again") open it on
  // Action, or on the type a caller names (`open-create`, lib/create/open-create.ts).
  // Mail's New email (its button and its own `c` key) opens it on Email, and
  // `open-create-contact` on Contact, as before.
  const openRef = useRef(open)
  openRef.current = open
  const openMenuRef = useRef(openMenu)
  openMenuRef.current = openMenu
  const openComposerRef = useRef(openComposer)
  openComposerRef.current = openComposer
  useEffect(() => {
    function handleOpen(e: Event) {
      const detail = (e as CustomEvent<OpenCreateRequest | null>).detail
      const type = detail?.type
      const ctx = detail?.context ?? null
      if (type && isCreateTypeId(type) && createTypeDef(type).mode === 'page') {
        openPageType(type)
        return
      }
      if (type && isCreateTypeId(type)) openComposerRef.current(type, ctx)
      else openMenuRef.current(ctx)
    }
    function handleOpenEmail() {
      openComposerRef.current('email')
    }
    function handleOpenContact() {
      openComposerRef.current('contact')
    }
    document.addEventListener(OPEN_CREATE_EVENT, handleOpen)
    document.addEventListener('open-create-email', handleOpenEmail)
    document.addEventListener('open-create-contact', handleOpenContact)
    return () => {
      document.removeEventListener(OPEN_CREATE_EVENT, handleOpen)
      document.removeEventListener('open-create-email', handleOpenEmail)
      document.removeEventListener('open-create-contact', handleOpenContact)
    }
  }, [])

  // `c`, anywhere in the app, opens the Create menu (C then a letter: the
  // menu reads the letter, create-menu.tsx). Not while typing (the helper skips fields and
  // contenteditables), nor while another dialog or menu has the focus
  // (createKeyAllowed). Not prevented: Mail's own `c`, a window listener that
  // runs after this one and skips a prevented key, then opens it on Email, so
  // on Mail `c` is still New email. Nothing else in the app binds a bare `c`.
  useHotkeys([
    {
      key: 'c',
      preventDefault: false,
      handler: (e) => {
        if (openRef.current || !createKeyAllowed(e.target)) return
        openMenuRef.current()
      },
    },
  ])

  // ── Fetch shared options when dialog opens ──
  useEffect(() => {
    if (!open) return

    // Members (shared across types)
    fetch('/api/account/workspace')
      .then((r) => r.json())
      .then((d) => {
        setMembers(
          (d.members || []).map((m: TeamMember) => ({
            id: m.id,
            display_name: m.display_name,
            avatar_url: m.avatar_url,
          })),
        )
      })
      .catch(() => {})

    // Projects (shared across types)
    fetch('/api/account/projects')
      .then((r) => r.json())
      .then((d) => {
        setProjects(
          (d.projects || [])
            .filter((p: { name: string }) => p.name !== '__default__')
            .map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })),
        )
      })
      .catch(() => {})

    // Labels are now fetched via useScopedLabels hook

    // Initiatives (for project form)
    fetch('/api/account/initiatives')
      .then((r) => r.json())
      .then((d) => {
        setInitiatives(
          (d.initiatives || []).map((i: InitiativeOption) => ({ id: i.id, name: i.name, status: i.status })),
        )
      })
      .catch(() => {})

    // Companies (for contact form)
    fetch('/api/account/companies')
      .then((r) => r.json())
      .then((d) => {
        setCompanies(
          (d.companies || []).map((c: CompanyOption) => ({ id: c.id, name: c.name, domain: c.domain })),
        )
      })
      .catch(() => {})

    // Calendar accounts (for event form) and mail accounts (for email form)
    fetch('/api/oauth/status')
      .then((r) => r.json())
      .then((d) => {
        type StatusAccount = { id: string; account_email: string; provider: string; capability: string; is_enabled: boolean; is_primary?: boolean }
        const toOption = (a: StatusAccount) => ({ id: a.id, email: a.account_email, provider: a.provider })
        const all: StatusAccount[] = d.accounts || []
        const accts = all
          .filter((a) => (a.capability === 'calendar' || a.capability === 'both') && a.is_enabled)
          .map(toOption)
        setCalendarAccounts(accts)
        if (accts.length > 0 && !eventAccountId) setEventAccountId(accts[0].id)
        const mail = all.filter((a) => a.capability === 'email' && a.is_enabled)
        setEmailAccounts(mail.map(toOption))
        const firstMail = mail.find((a) => a.is_primary) ?? mail[0]
        if (firstMail && !emailAccountId) setEmailAccountId(firstMail.id)
      })
      .catch(() => {})
  }, [open])

  // ── Fetch action-specific options when team changes ──
  useEffect(() => {
    if (!open || !effectiveTeamId || entityType !== 'action') return

    // Workflow states
    fetch(`/api/account/workflow-states?team_id=${effectiveTeamId}`)
      .then((r) => r.json())
      .then((d) => {
        const states = d.states || []
        setWorkflowStates(states)
        const defaultState = states.find((s: WorkflowState) => s.category === 'backlog') || states.find((s: WorkflowState) => s.is_default) || states[0]
        if (defaultState && !statusId) setStatusId(defaultState.id)
      })
      .catch(() => {})

    // Cycles
    Promise.all([
      fetch(`/api/account/cycles?team_id=${effectiveTeamId}&status=active`).then((r) => r.json()),
      fetch(`/api/account/cycles?team_id=${effectiveTeamId}&status=upcoming`).then((r) => r.json()),
    ])
      .then(([active, upcoming]) => {
        const all = [...(active.cycles || []), ...(upcoming.cycles || [])]
        setCycles(all.map((c: CycleOption) => ({ id: c.id, name: c.name, number: c.number, status: c.status })))
      })
      .catch(() => {})
  }, [open, effectiveTeamId, entityType, statusId])

  // ── Fetch milestones when project changes (action only) ──
  useEffect(() => {
    if (!projectId) {
      setMilestones([])
      return
    }
    fetch(`/api/account/projects/${projectId}/milestones`)
      .then((r) => r.json())
      .then((d) => setMilestones(d.milestones || []))
      .catch(() => setMilestones([]))
  }, [projectId])

  // Focus title on open
  useEffect(() => {
    if (open) {
      setTimeout(() => titleRef.current?.focus(), 100)
    }
  }, [open])

  // Cmd+Enter to create while dialog is open
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      // ⌘/Ctrl ↵: create, and keep the composer for another (email: its composer's own Send).
      if (stage === 'compose' && entityType !== 'email' && composerKeyIntent(e, 'other') === 'create-another') {
        e.preventDefault()
        handleCreate('another')
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  })

  // ── Reset helpers ──

  function resetSubActionForm() {
    setSubTitle('')
    setSubDescription('')
    setSubStatusId(null)
    setSubPriority('none')
    setSubAssigneeIds([])
    setSubProjectId(null)
    setSubLabelIds([])
  }

  function resetForm() {
    setTitle('')
    setDescription('')
    setQuickSecondary('')
    setTableTemplate(null)
    setChannelTeamId(null)
    setContext(null)
    // Action
    setTeamId(null)
    setStatusId(null)
    setPriority('none')
    setAssigneeIds([])
    setProjectId(null)
    setLabelIds([])
    setCycleId(null)
    setDueDate('')
    setEstimate('')
    setMilestoneId(null)
    setVisibleExtras(new Set())
    setPendingSubActions([])
    setPendingFiles([])
    setShowSubActionForm(false)
    resetSubActionForm()
    setSubCreateMore(false)
    // Project
    setProjectStatus('planned')
    setLeadId(null)
    setInitiativeId(null)
    setStartDate('')
    setTargetDate('')
    // Initiative
    setInitiativeStatus('planned')
    setOwnerId(null)
    setInitiativeTargetDate('')
    setInitiativeProjectIds([])
    // Contact
    setFirstName('')
    setLastName('')
    setContactEmail('')
    setContactPhone('')
    setJobTitle('')
    setCompanyId(null)
    setCompanySearch('')
    setRelationshipType('contact')
    setLinkedinUrl('')
    // Event
    setEventStart(undefined)
    setEventEnd(undefined)
    setEventLocation('')
    setEventMeetingLink(false)
    setEventIsAllDay(false)
    setEventAttendees([])
    setEventAccountId(undefined)
  }

  // ── Sub-action handlers ──

  function handleAddSubAction() {
    if (!subTitle.trim()) return
    const newSub: PendingSubAction = {
      id: crypto.randomUUID(),
      title: subTitle.trim(),
      description: subDescription.trim(),
      statusId: subStatusId,
      priority: subPriority,
      assigneeIds: [...subAssigneeIds],
      projectId: subProjectId,
      labelIds: [...subLabelIds],
    }
    setPendingSubActions((prev) => [...prev, newSub])
    if (subCreateMore) {
      resetSubActionForm()
      setTimeout(() => subTitleRef.current?.focus(), 50)
    } else {
      resetSubActionForm()
      setShowSubActionForm(false)
    }
  }

  function removeSubAction(id: string) {
    setPendingSubActions((prev) => prev.filter((s) => s.id !== id))
  }

  // ── Create handlers ──

  async function handleCreateAction() {
    const body: Record<string, unknown> = {
      title: title.trim(),
      team_id: effectiveTeamId,
      priority,
      assignee_ids: assigneeIds.length > 0 ? assigneeIds : undefined,
      project_id: projectId || undefined,
      cycle_id: cycleId || undefined,
      milestone_id: milestoneId || undefined,
      estimate: estimate ? parseFloat(estimate) : undefined,
    }
    // The record it was made from or on (a deal, a company, an email, a
    // message): linked by the route, which checks the person can see it.
    const about = contextDefaults('action', context).about
    if (about) body.about = about

    const res = await fetch('/api/account/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) return null

    const data = await res.json()
    const action = data.action

    // Patch non-default status, description, due date
    const patches: Record<string, unknown> = {}
    if (statusId && workflowStates.length > 0) {
      const defaultState = workflowStates.find((s) => s.is_default) || workflowStates.find((s) => s.category === 'backlog')
      if (defaultState && statusId !== defaultState.id) patches.status_id = statusId
    }
    if (description.trim()) patches.description = description.trim()
    // The picked day's LOCAL midnight (new Date('YYYY-MM-DD') is UTC midnight,
    // the evening before west of UTC).
    if (dueDate) patches.due_at = parseISO(dueDate).toISOString()

    if (Object.keys(patches).length > 0) {
      const patchRes = await fetch(`/api/account/actions/${action.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patches),
      }).catch(() => null)
      if (!patchRes?.ok) toast.error('Action created, but its status, description or due date was not saved')
    }

    // Attach labels
    let labelsFailed = 0
    for (const labelId of labelIds) {
      const labelRes = await fetch(`/api/account/actions/${action.id}/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label_id: labelId }),
      }).catch(() => null)
      if (!labelRes?.ok) labelsFailed++
    }
    if (labelsFailed > 0) toast.error(`Action created, but ${labelsFailed} label${labelsFailed === 1 ? ' was' : 's were'} not saved`)

    // Create sub-actions
    let subActionsIncomplete = 0
    for (const sub of pendingSubActions) {
      const subBody: Record<string, unknown> = {
        title: sub.title,
        team_id: effectiveTeamId,
        parent_id: action.id,
        priority: sub.priority,
        assignee_ids: sub.assigneeIds.length > 0 ? sub.assigneeIds : undefined,
        project_id: sub.projectId || undefined,
      }
      const subRes = await fetch('/api/account/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subBody),
      })
      if (!subRes.ok) {
        subActionsIncomplete++
      } else {
        let subOk = true
        const subData = await subRes.json()
        const subAction = subData.action
        const subPatches: Record<string, unknown> = {}
        if (sub.statusId && workflowStates.length > 0) {
          const defaultState = workflowStates.find((s) => s.is_default) || workflowStates.find((s) => s.category === 'backlog')
          if (defaultState && sub.statusId !== defaultState.id) subPatches.status_id = sub.statusId
        }
        if (sub.description) subPatches.description = sub.description
        if (Object.keys(subPatches).length > 0) {
          const subPatchRes = await fetch(`/api/account/actions/${subAction.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(subPatches),
          }).catch(() => null)
          if (!subPatchRes?.ok) subOk = false
        }
        for (const labelId of sub.labelIds) {
          const subLabelRes = await fetch(`/api/account/actions/${subAction.id}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label_id: labelId }),
          }).catch(() => null)
          if (!subLabelRes?.ok) subOk = false
        }
        if (!subOk) subActionsIncomplete++
      }
    }
    if (subActionsIncomplete > 0) {
      toast.error(`Action created, but ${subActionsIncomplete} sub-action${subActionsIncomplete === 1 ? ' was' : 's were'} not fully saved`)
    }

    // Upload any pending file attachments. Sequential on purpose: display_order
    // is derived from a per-parent count on the server, so concurrent
    // registrations would all land on the same order.
    for (const file of pendingFiles) {
      try {
        await uploadAttachment({ file, actionId: action.id })
      } catch (err) {
        const message =
          err instanceof AttachmentUploadError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Upload failed. Please try again.'
        toast.error(`${file.name}: ${message}`)
      }
    }

    return action
  }

  async function handleCreateProject() {
    const body: Record<string, unknown> = {
      name: title.trim(),
      status: projectStatus,
      lead_id: leadId || undefined,
      initiative_id: initiativeId || undefined,
      start_date: startDate || undefined,
      target_date: targetDate || undefined,
    }
    if (description.trim()) body.description = description.trim()

    const res = await fetch('/api/account/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) return null
    const data = await res.json()
    return data.project
  }

  async function handleCreateInitiative() {
    const body: Record<string, unknown> = {
      name: title.trim(),
      status: initiativeStatus,
      owner_id: ownerId || undefined,
      target_date: initiativeTargetDate || undefined,
    }
    if (description.trim()) body.description = description.trim()

    const res = await fetch('/api/account/initiatives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) return null
    const data = await res.json()
    const initiative = data.initiative

    // Link selected projects to this initiative
    let linksFailed = 0
    for (const pid of initiativeProjectIds) {
      const linkRes = await fetch(`/api/account/projects/${pid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initiative_id: initiative.id }),
      }).catch(() => null)
      if (!linkRes?.ok) linksFailed++
    }
    if (linksFailed > 0) toast.error(`Initiative created, but ${linksFailed} project${linksFailed === 1 ? ' was' : 's were'} not linked`)

    return initiative
  }

  async function handleCreateContact() {
    const fullName = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ') || title.trim()

    // If user typed a new company name, create it first
    let resolvedCompanyId = companyId
    let companyFailed = false
    if (!resolvedCompanyId && companySearch.trim()) {
      companyFailed = true
      try {
        const companyRes = await fetch('/api/account/companies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: companySearch.trim() }),
        })
        if (companyRes.ok) {
          const companyData = await companyRes.json()
          resolvedCompanyId = companyData.company.id
          companyFailed = !resolvedCompanyId
        }
      } catch {
        // Continue without company if creation fails (reported once the contact exists)
      }
    }

    const body: Record<string, unknown> = {
      full_name: fullName,
    }
    if (firstName.trim()) body.first_name = firstName.trim()
    if (lastName.trim()) body.last_name = lastName.trim()
    if (contactEmail.trim()) body.email = contactEmail.trim().toLowerCase()
    if (contactPhone.trim()) body.phone = contactPhone.trim()
    if (jobTitle.trim()) body.job_title = jobTitle.trim()
    if (resolvedCompanyId) body.company_id = resolvedCompanyId
    if (relationshipType !== 'contact') body.relationship_type = relationshipType
    if (linkedinUrl.trim()) body.linkedin_url = linkedinUrl.trim()
    if (description.trim()) body.notes = description.trim()

    const res = await fetch('/api/account/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) return null
    const data = await res.json()
    if (companyFailed) toast.error(`Couldn’t create company “${companySearch.trim()}”; contact saved without it`)
    return data.contact
  }

  async function handleCreateEvent() {
    if (!title.trim() || !eventStart || !eventEnd) return null

    const body: Record<string, unknown> = {
      title: title.trim(),
      start: eventStart.toISOString(),
      end: eventEnd.toISOString(),
      isAllDay: eventIsAllDay,
    }
    if (description.trim()) body.description = description.trim()
    if (eventLocation.trim()) body.location = eventLocation.trim()
    if (eventMeetingLink && meetingLinks && !eventIsAllDay) body.meetingLink = true
    if (eventAttendees.length > 0) body.attendees = eventAttendees
    if (eventAccountId) body.accountId = eventAccountId

    const res = await fetch('/api/calendar/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) return null
    const data = await res.json()
    if (data.event) {
      // Fold into the shared calendar cache so an open calendar view/widget
      // shows the new event immediately instead of on its next poll.
      const newEvent = calendarEventToIEvent(data.event as CalendarEvent)
      patchCalendarEventsCache((prev) => [...prev, newEvent])
    }
    return data.event
  }

  // A quick type: its own route (quick-create.ts), then the new thing opened
  // as the app opens it, the dialog closed. With Create more: the dialog stays
  // for the next one, and the toast opens this one.
  async function handleCreateQuick(type: CreateQuickTypeId, mode: CreateMode) {
    const name = title.trim()
    const template = type === 'table' ? tableTemplate : null
    if (!name && !QUICK_CREATE[type].nameOptional?.({ template })) return
    setCreating(true)
    const label = typeLabel(type)
    try {
      const made = await QUICK_CREATE[type].run({
        name,
        secondary: quickSecondary.trim(),
        template,
        projectId: type === 'document' ? projectId : null,
        teamId: type === 'channel' ? channelTeamId : null,
      })
      const entity = { id: made.id, name: made.title, title: made.title }
      onCreated?.(entity)
      window.dispatchEvent(new CustomEvent('ni:entity-created', { detail: { entityType: type, entity } }))
      if (mode === 'another') {
        toast(`${label} created`, { description: made.title, action: { label: 'Open', onClick: () => { resetForm(); setOpen(false); made.open() } } })
        setTitle('')
        setQuickSecondary('')
        setTimeout(() => titleRef.current?.focus(), 50)
      } else {
        toast(`${label} created`, { description: made.title })
        resetForm()
        setOpen(false)
        made.open()
      }
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : `Could not create the ${label.toLowerCase()}`)
    } finally {
      setCreating(false)
    }
  }

  /**
   * ↵ (the button, the title's Enter): create, then open what was made.
   * ⌘/Ctrl ↵: create, and keep the composer for another, the place and the
   * picked properties kept (the title and description cleared).
   */
  async function handleCreate(mode: CreateMode = 'open') {
    if (creating) return

    // Validate based on entity type
    if (entityType === 'contact') {
      if (!title.trim() && !firstName.trim() && !contactEmail.trim()) return
    } else if (entityType === 'email') {
      // The composer sends it (its own Send).
      return
    } else if (entityType === 'event') {
      if (!title.trim() || !eventStart || !eventEnd) return
    } else if (isQuickType(entityType)) {
      if (!title.trim() && !QUICK_CREATE[entityType].nameOptional?.({ template: entityType === 'table' ? tableTemplate : null })) return
    } else {
      if (!title.trim()) return
    }

    if (isQuickType(entityType)) {
      await handleCreateQuick(entityType, mode)
      return
    }

    setCreating(true)

    try {
      let result: Record<string, unknown> | null = null

      switch (entityType) {
        case 'action':
          result = await handleCreateAction()
          break
        case 'project':
          result = await handleCreateProject()
          break
        case 'initiative':
          result = await handleCreateInitiative()
          break
        case 'contact':
          result = await handleCreateContact()
          break
        case 'event':
          result = await handleCreateEvent()
          break
      }

      if (!result) {
        const label = typeLabel(entityType)
        toast.error(`Could not create the ${label.toLowerCase()}`)
        setCreating(false)
        return
      }

      onCreated?.(result)

      // Notify list views to refresh (e.g. UnifiedViewLayout)
      window.dispatchEvent(new CustomEvent('ni:entity-created', {
        detail: { entityType, entity: result },
      }))

      const entityLabel = typeLabel(entityType)

      if (mode === 'another') {
        const displayTitle = entityType === 'contact'
          ? (result.full_name as string) || title.trim()
          : (result.title as string) || (result.name as string) || title.trim()
        const identifier = (result.identifier as string) || ''

        toast(`${entityLabel} created`, {
          description: identifier ? `${identifier} — ${displayTitle}` : displayTitle,
          action: createdTarget(entityType, result) ? {
            label: 'Open',
            onClick: () => {
              resetForm()
              setOpen(false)
              openCreated(entityType, result!)
            },
          } : undefined,
        })
        setTitle('')
        setDescription('')
        // Sub-actions and attachments belong to the action just created.
        setPendingSubActions([])
        setPendingFiles([])
        setShowSubActionForm(false)
        // Reset entity-specific title fields for contact
        if (entityType === 'contact') {
          setFirstName('')
          setLastName('')
          setContactEmail('')
        }
        setTimeout(() => titleRef.current?.focus(), 50)
      } else {
        toast(`${entityLabel} created`, {
          description: entityType === 'contact'
            ? (result.full_name as string) || ''
            : (result.identifier as string) ? `${result.identifier} — ${(result.title as string) || (result.name as string) || ''}` : (result.title as string) || (result.name as string) || '',
        })
        resetForm()
        setOpen(false)
        // ↵ opens what was made, as everything opens it (an email is sent: nothing to open).
        openCreated(entityType, result)
      }
    } catch {
      toast.error('Something went wrong. Please try again.')
    } finally {
      setCreating(false)
    }
  }

  // ── Derived display values ──
  const currentStatus = workflowStates.find((s) => s.id === statusId)
  const currentPriority = PRIORITY_OPTIONS.find((o) => o.value === priority) ?? PRIORITY_OPTIONS[0]
  const currentAssignees = members.filter((m) => assigneeIds.includes(m.id))
  const currentProject = projects.find((p) => p.id === projectId)
  const currentCycle = cycles.find((c) => c.id === cycleId)
  const currentMilestone = milestones.find((m) => m.id === milestoneId)
  const selectedLabels = labels.filter((l) => labelIds.includes(l.id))
  const currentLead = members.find((m) => m.id === leadId)
  const currentOwner = members.find((m) => m.id === ownerId)
  const currentInitiative = initiatives.find((i) => i.id === initiativeId)
  const currentCompany = companies.find((c) => c.id === companyId)

  const hiddenExtras = ACTION_EXTRA_PROPERTY_DEFS.filter((d) => !visibleExtras.has(d.key))
  const currentEntityOption = { label: typeLabel(entityType), icon: typeIcon(entityType) }

  // ── Title placeholder by entity type ──
  const pickerAccounts = entityType === 'email' ? emailAccounts : calendarAccounts
  const pickerAccountId = entityType === 'email' ? emailAccountId : eventAccountId
  const setPickerAccountId = entityType === 'email' ? setEmailAccountId : setEventAccountId

  const titlePlaceholder = isQuickType(entityType) ? QUICK_CREATE[entityType].namePlaceholder : entityType === 'contact' ? 'Contact name' : entityType === 'project' ? 'Project name' : entityType === 'initiative' ? 'Initiative name' : entityType === 'email' ? 'Subject' : entityType === 'event' ? 'Event title' : 'Action title'
  const descriptionPlaceholder = entityType === 'contact' ? 'Add notes...' : entityType === 'email' ? '' : 'Add description...'

  // ── Determine if create button should be enabled ──
  const canCreate = entityType === 'contact'
    ? (title.trim() || firstName.trim() || contactEmail.trim())
    : entityType === 'email'
    ? false
    : entityType === 'event'
    ? (title.trim() && eventStart && eventEnd)
    : isQuickType(entityType)
    ? (title.trim() || QUICK_CREATE[entityType].nameOptional?.({ template: entityType === 'table' ? tableTemplate : null }))
    : title.trim()

  // "Create in <name>": shown where the place links this type (create-context.ts).
  const shownContainer = context?.container && containerApplies(entityType, context) ? context.container : null
  const templates = entityType === 'table' ? tableTemplates() : []

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => {
      if (!v && entityType === 'email') {
        // Close but keep email draft state — user can reopen with C
        setOpen(false)
        return
      }
      if (!v) resetForm()
      setOpen(v)
    }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-create-dialog=""
          className="fixed left-[50%] top-[25%] z-50 w-full max-w-[680px] translate-x-[-50%] translate-y-0 overflow-hidden rounded-lg border bg-background shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=open]:slide-in-from-left-1/2"
        >
          <VisuallyHidden.Root><DialogPrimitive.Title>{stage === 'menu' ? 'Create' : `Create new ${currentEntityOption.label.toLowerCase()}`}</DialogPrimitive.Title></VisuallyHidden.Root>

          {stage === 'menu' ? (
            <CreateMenu options={typeOptions} onPick={pickType} openedAt={menuOpenedAt} container={context?.container ?? null} />
          ) : (
          <>
          {/* Header: entity type selector > team selector (action only) + close */}
          <div className="flex items-center gap-2 px-4 py-3">
            <div className="flex flex-1 items-center gap-1.5 text-sm">
              {/* Entity type selector (always first) — matches AccountFilterDropdown style */}
              {showSubActionForm ? (
                <>
                  <button
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => {
                      resetSubActionForm()
                      setShowSubActionForm(false)
                    }}
                  >
                    New {currentEntityOption.label.toLowerCase()}
                  </button>
                  <span className="text-muted-foreground">&rsaquo;</span>
                  <span className="text-muted-foreground">Sub-action</span>
                </>
              ) : (
                <CreateTypePicker options={typeOptions} value={entityType} onChange={pickType} />
              )}

              {/* "Create in <name>": the place it was opened in, linked (create-context.ts). × makes it without. */}
              {shownContainer && !showSubActionForm && (
                <span
                  data-create-container={shownContainer.kind}
                  className="inline-flex h-7 max-w-[220px] shrink-0 items-center gap-1 rounded-full border border-border bg-muted/40 pl-3 pr-1 text-xs text-foreground"
                >
                  <span className="truncate">{containerLabel(shownContainer)}</span>
                  <button
                    type="button"
                    aria-label="Make it without this place"
                    onClick={() => {
                      const d = contextDefaults(entityType, { container: shownContainer })
                      if (d.projectId && projectId === d.projectId) setProjectId(null)
                      if (d.teamId && teamId === d.teamId) setTeamId(null)
                      if (d.teamId && channelTeamId === d.teamId) setChannelTeamId(null)
                      if (d.initiativeId && initiativeId === d.initiativeId) setInitiativeId(null)
                      if (d.companyId && companyId === d.companyId) setCompanyId(null)
                      setContext((c) => (c ? { ...c, container: null } : c))
                    }}
                    className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}

              {/* Team selector (action) — appears to the right of entity type */}
              {entityType === 'action' && !showSubActionForm && (
                <>
                  <span className="text-muted-foreground">&rsaquo;</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-border px-3 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground dark:shadow-none">
                      <Users className="h-3 w-3 shrink-0" />
                      <span className="max-w-[100px] truncate">{currentTeam?.issue_prefix || 'Team'}</span>
                      <ChevronsUpDown className="h-3 w-3 opacity-50" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-48">
                      {teams.map((t) => (
                        <DropdownMenuItem
                          key={t.id}
                          onClick={() => {
                            setTeamId(t.id)
                            setStatusId(null)
                            setCycleId(null)
                          }}
                          className="gap-2"
                        >
                          <div className={cn(
                            'flex h-4 w-4 items-center justify-center rounded-sm border border-primary',
                            t.id === effectiveTeamId ? 'bg-primary text-primary-foreground' : 'opacity-50',
                          )}>
                            {t.id === effectiveTeamId && <Check className="h-3 w-3" />}
                          </div>
                          <span className="text-sm">{t.name}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}

              {/* Account selector (event + email) — appears to the right of entity type */}
              {(entityType === 'event' || entityType === 'email') && pickerAccounts.length > 0 && (
                <>
                  <span className="text-muted-foreground">&rsaquo;</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-border px-3 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground dark:shadow-none">
                      <Mail className="h-3 w-3 shrink-0" />
                      <span className="max-w-[140px] truncate">{pickerAccounts.find((a) => a.id === pickerAccountId)?.email || 'Account'}</span>
                      <ChevronsUpDown className="h-3 w-3 opacity-50" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-64">
                      {pickerAccounts.map((acct) => (
                        <DropdownMenuItem
                          key={acct.id}
                          onClick={() => setPickerAccountId(acct.id)}
                          className="gap-2"
                        >
                          <div className={cn(
                            'flex h-4 w-4 items-center justify-center rounded-sm border border-primary',
                            pickerAccountId === acct.id ? 'bg-primary text-primary-foreground' : 'opacity-50',
                          )}>
                            {pickerAccountId === acct.id && <Check className="h-3 w-3" />}
                          </div>
                          <div className="flex flex-col min-w-0">
                            <span className="text-sm truncate">{acct.email}</span>
                            <span className="text-[10px] text-muted-foreground capitalize">{acct.provider === 'google' ? 'Google' : 'Outlook'}</span>
                          </div>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>
            <DialogPrimitive.Close className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </DialogPrimitive.Close>
          </div>

          {/* ═══════ Body — varies by entity type ═══════ */}
          {entityType === 'email' ? (
            /* New email: Mail's own composer, the one Reply and Forward use
               (rich text, files, Save draft, Send later, Undo). It keeps what
               is written when the dialog closes; the header's picker is its
               From. `ph-no-capture` is on the composer itself. */
            <div className="border-t border-border/40">
              <EmailComposer
                mode="new"
                source={null}
                accountId={emailAccountId ?? null}
                fromAddress={emailAccounts.find((a) => a.id === emailAccountId)?.email ?? null}
                ownAddresses={new Set(emailAccounts.map((a) => a.email.toLowerCase()))}
                draftKey={composeDraftKey(null)}
                onSent={() => setOpen(false)}
                onSavedToMailbox={() => setOpen(false)}
                onReopen={() => document.dispatchEvent(new Event('open-create-email'))}
                onClose={() => setOpen(false)}
                onDiscard={() => {
                  resetForm()
                  setOpen(false)
                }}
                className="rounded-none bg-transparent shadow-none ring-0 backdrop-blur-none dark:bg-transparent"
              />
            </div>
          ) : (
            /* Standard title + description form */
            <>
              <div className="space-y-1 px-4 pt-4 pb-2">
                {entityType === 'contact' ? (
                  <div className="flex gap-3">
                    <input
                      ref={titleRef}
                      value={firstName}
                      onChange={(e) => {
                        setFirstName(e.target.value)
                        setTitle(e.target.value)
                      }}
                      onKeyDown={(e) => {
                        if (composerKeyIntent(e.nativeEvent, 'title') === 'create-open' && canCreate) {
                          e.preventDefault()
                          handleCreate('open')
                        }
                      }}
                      placeholder="First name"
                      className="w-full bg-transparent text-lg font-medium placeholder:text-muted-foreground/50 focus:outline-none"
                    />
                    <input
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      onKeyDown={(e) => {
                        if (composerKeyIntent(e.nativeEvent, 'title') === 'create-open' && canCreate) {
                          e.preventDefault()
                          handleCreate('open')
                        }
                      }}
                      placeholder="Last name"
                      className="w-full bg-transparent text-lg font-medium placeholder:text-muted-foreground/50 focus:outline-none"
                    />
                  </div>
                ) : (
                  <input
                    ref={titleRef}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (composerKeyIntent(e.nativeEvent, 'title') === 'create-open' && canCreate) {
                        e.preventDefault()
                        handleCreate('open')
                      }
                    }}
                    placeholder={titlePlaceholder}
                    className="w-full bg-transparent text-lg font-medium placeholder:text-muted-foreground/50 focus:outline-none"
                  />
                )}
                {isQuickType(entityType) ? (
                  QUICK_CREATE[entityType].secondaryPlaceholder ? (
                    <input
                      value={quickSecondary}
                      onChange={(e) => setQuickSecondary(e.target.value)}
                      onKeyDown={(e) => {
                        if (composerKeyIntent(e.nativeEvent, 'title') === 'create-open' && canCreate) {
                          e.preventDefault()
                          handleCreate('open')
                        }
                      }}
                      placeholder={QUICK_CREATE[entityType].secondaryPlaceholder}
                      data-create-secondary=""
                      className="w-full bg-transparent pb-2 text-sm text-muted-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                    />
                  ) : null
                ) : (
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={descriptionPlaceholder}
                    rows={3}
                    className="w-full resize-none bg-transparent text-sm text-muted-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                  />
                )}
              </div>
            </>
          )}

          {/* A table's starters (lib/tables/templates.ts), a choice in the composer: Blank, or one of them. */}
          {entityType === 'table' && templates.length > 0 && (
            <div className="px-4 pb-3" data-create-templates="">
              <p className="mb-1.5 text-[11px] text-muted-foreground">Start from</p>
              <div className="flex flex-wrap gap-1.5">
                {[{ id: null as string | null, name: 'Blank', description: 'A Name column and three empty rows' }, ...templates.map((t) => ({ id: t.id as string | null, name: t.name, description: t.description }))].map((t) => (
                  <button
                    key={t.id ?? 'blank'}
                    type="button"
                    data-template={t.id ?? 'blank'}
                    aria-pressed={tableTemplate === t.id}
                    title={t.description}
                    onClick={() => {
                      setTableTemplate(t.id)
                      titleRef.current?.focus()
                    }}
                    className={cn(
                      'inline-flex h-7 items-center rounded-full border px-3 text-xs transition-colors',
                      tableTemplate === t.id
                        ? 'border-foreground/40 bg-muted text-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
              {tableTemplate && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {templates.find((t) => t.id === tableTemplate)?.description} Leave the name empty to use the starter’s.
                </p>
              )}
            </div>
          )}

          {/* ═══════ Property pills — vary by entity type (hidden for email) ═══════ */}
          {entityType !== 'email' && (
          <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
            {entityType === 'action' && (
              <>
                {/* Status */}
                <PropertyPill
                  icon={<Circle className="h-3 w-3" style={{ color: currentStatus?.color || '#6b7280' }} fill={currentStatus?.color || '#6b7280'} />}
                  label={currentStatus?.name || 'Backlog'}
                >
                  {(close) => (
                    <Command>
                      <CommandInput placeholder="Set status..." />
                      <CommandList>
                        <CommandEmpty>No states found</CommandEmpty>
                        <CommandGroup>
                          {workflowStates.map((state) => (
                            <CommandItem key={state.id} value={state.name} onSelect={() => { setStatusId(state.id); close() }}>
                              <Circle className="mr-2 h-3 w-3" style={{ color: state.color }} fill={state.color} />
                              {state.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  )}
                </PropertyPill>

                {/* Priority */}
                <PropertyPill
                  icon={<Flag className={cn('h-3 w-3', currentPriority.color)} />}
                  label={priority === 'none' ? 'Priority' : currentPriority.label}
                  muted={priority === 'none'}
                >
                  {(close) => (
                    <Command>
                      <CommandInput placeholder="Set priority..." />
                      <CommandList>
                        <CommandGroup>
                          {PRIORITY_OPTIONS.map((opt) => (
                            <CommandItem key={opt.value} value={opt.label} onSelect={() => { setPriority(opt.value); close() }}>
                              <Flag className={cn('mr-2 h-3 w-3', opt.color)} />
                              {opt.label}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  )}
                </PropertyPill>

                {/* Assignees (multi-select) */}
                <PropertyPill
                  icon={
                    currentAssignees.length > 0 ? (
                      <div className="flex -space-x-1">
                        {currentAssignees.slice(0, 2).map((a) =>
                          a.avatar_url ? (
                            <img key={a.id} src={a.avatar_url} alt="" className="h-3.5 w-3.5 rounded-full ring-1 ring-background" />
                          ) : (
                            <div key={a.id} className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-muted ring-1 ring-background">
                              <User className="h-2 w-2 text-muted-foreground" />
                            </div>
                          )
                        )}
                      </div>
                    ) : (
                      <User className="h-3 w-3 text-muted-foreground" />
                    )
                  }
                  label={currentAssignees.length > 0 ? currentAssignees.map((a) => a.display_name).join(', ') : 'Assignee'}
                  muted={currentAssignees.length === 0}
                  keepOpen
                >
                  {() => (
                    <Command>
                      <CommandInput placeholder="Assign to..." />
                      <CommandList>
                        <CommandEmpty>No members found</CommandEmpty>
                        <CommandGroup>
                          {members.map((m) => {
                            const isSelected = assigneeIds.includes(m.id)
                            return (
                              <CommandItem
                                key={m.id}
                                value={m.display_name}
                                onSelect={() => {
                                  setAssigneeIds((prev) =>
                                    isSelected ? prev.filter((id) => id !== m.id) : [...prev, m.id]
                                  )
                                }}
                              >
                                <div className={cn(
                                  'mr-2 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                                  isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30'
                                )}>
                                  {isSelected && <Check className="h-2.5 w-2.5" />}
                                </div>
                                {m.avatar_url ? (
                                  <img src={m.avatar_url} alt="" className="mr-2 h-3.5 w-3.5 rounded-full" />
                                ) : (
                                  <User className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                                )}
                                {m.display_name}
                              </CommandItem>
                            )
                          })}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  )}
                </PropertyPill>

                {/* Project */}
                <ProjectPill
                  currentProject={currentProject}
                  projects={projects}
                  onSelect={(id) => {
                    // A milestone belongs to its project: drop it with the project.
                    if (id !== projectId) setMilestoneId(null)
                    setProjectId(id)
                  }}
                />

                {/* Labels */}
                <LabelsPill
                  selectedLabels={selectedLabels}
                  labels={labels}
                  labelIds={labelIds}
                  setLabelIds={setLabelIds}
                />

                {/* Cycle */}
                <PropertyPill
                  icon={<RefreshCw className="h-3 w-3 text-muted-foreground" />}
                  label={currentCycle?.name || 'Cycle'}
                  muted={!currentCycle}
                >
                  {(close) => (
                    <Command>
                      <CommandInput placeholder="Add to cycle..." />
                      <CommandList>
                        <CommandEmpty>No cycles found</CommandEmpty>
                        <CommandGroup>
                          <CommandItem value="none" onSelect={() => { setCycleId(null); close() }}>
                            <RefreshCw className="mr-2 h-3 w-3 text-muted-foreground" />
                            No cycle
                          </CommandItem>
                          {cycles.map((c) => (
                            <CommandItem key={c.id} value={c.name} onSelect={() => { setCycleId(c.id); close() }}>
                              <RefreshCw className="mr-2 h-3 w-3" />
                              {c.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  )}
                </PropertyPill>

                {/* Due date (extra) */}
                {visibleExtras.has('due_date') && (
                  <DatePill label="Due date" value={dueDate} onChange={setDueDate} />
                )}

                {/* Estimate (extra) */}
                {visibleExtras.has('estimate') && (
                  <PropertyPill
                    icon={<Gauge className="h-3 w-3 text-muted-foreground" />}
                    label={estimate ? `${estimate} pts` : 'Estimate'}
                    muted={!estimate}
                  >
                    {(close) => (
                      <div className="p-3 space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">Estimate (points)</p>
                        <Input type="number" min={0} step={0.5} value={estimate} onChange={(e) => setEstimate(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') close() }} className="h-8 text-sm" placeholder="0" />
                        <div className="flex gap-1.5">
                          {estimate && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setEstimate(''); close() }}>Clear</Button>}
                          <Button variant="default" size="sm" className="h-7 text-xs ml-auto" onClick={close}>Done</Button>
                        </div>
                      </div>
                    )}
                  </PropertyPill>
                )}

                {/* Milestone (extra) */}
                {visibleExtras.has('milestone') && (
                  <PropertyPill
                    icon={<Milestone className="h-3 w-3 text-muted-foreground" />}
                    label={currentMilestone?.name || 'Milestone'}
                    muted={!currentMilestone}
                  >
                    {(close) => (
                      <Command>
                        <CommandInput placeholder="Set milestone..." />
                        <CommandList>
                          {!projectId ? (
                            <CommandEmpty>Select a project first</CommandEmpty>
                          ) : milestones.length === 0 ? (
                            <CommandEmpty>No milestones found</CommandEmpty>
                          ) : (
                            <CommandGroup>
                              <CommandItem value="none" onSelect={() => { setMilestoneId(null); close() }}>
                                <Milestone className="mr-2 h-3 w-3 text-muted-foreground" />
                                No milestone
                              </CommandItem>
                              {milestones.map((m) => (
                                <CommandItem key={m.id} value={m.name} onSelect={() => { setMilestoneId(m.id); close() }}>
                                  <Milestone className="mr-2 h-3 w-3" />
                                  {m.name}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          )}
                        </CommandList>
                      </Command>
                    )}
                  </PropertyPill>
                )}

                {/* More properties menu */}
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="flex h-7 w-7 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:bg-muted">
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[220px] p-1" align="start">
                    {hiddenExtras.length > 0 && (
                      <>
                        <p className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">Add property</p>
                        {hiddenExtras.map((def) => (
                          <button
                            key={def.key}
                            className="flex w-full items-center rounded-2xl px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                            onClick={() => setVisibleExtras((prev) => new Set([...prev, def.key]))}
                          >
                            {def.icon}
                            {def.label}
                          </button>
                        ))}
                        <div className="my-1 h-px bg-border" />
                      </>
                    )}
                    <button
                      className="flex w-full items-center rounded-2xl px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                      onClick={() => {
                        setShowSubActionForm(true)
                        setTimeout(() => subTitleRef.current?.focus(), 100)
                      }}
                    >
                      <GitBranchPlus className="mr-2 h-3.5 w-3.5" />
                      Create sub-action
                    </button>
                  </PopoverContent>
                </Popover>
              </>
            )}

            {/* A channel's visibility: everyone, or one team (as team chat's own New channel had it). */}
            {entityType === 'channel' && teams.length > 0 && (
              <PropertyPill
                icon={<Users className="h-3 w-3 text-muted-foreground" />}
                label={channelTeamId ? `Only ${teams.find((t) => t.id === channelTeamId)?.name ?? 'the team'}` : 'Everyone in the workspace'}
              >
                {(close) => (
                  <Command>
                    <CommandInput placeholder="Who can see it..." />
                    <CommandList>
                      <CommandGroup>
                        <CommandItem value="Everyone in the workspace" onSelect={() => { setChannelTeamId(null); close() }}>
                          <Users className="mr-2 h-3 w-3" />
                          Everyone in the workspace
                          {!channelTeamId && <Check className="ml-auto h-3 w-3" />}
                        </CommandItem>
                        {teams.map((t) => (
                          <CommandItem key={t.id} value={`Only the ${t.name} team`} onSelect={() => { setChannelTeamId(t.id); close() }}>
                            <Users className="mr-2 h-3 w-3" />
                            Only the {t.name} team
                            {channelTeamId === t.id && <Check className="ml-auto h-3 w-3" />}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                )}
              </PropertyPill>
            )}

            {entityType === 'project' && (
              <>
                {/* Status */}
                <PropertyPill
                  icon={<Circle className="h-3 w-3 text-blue-500" fill="currentColor" />}
                  label={PROJECT_STATUS_OPTIONS.find((o) => o.value === projectStatus)?.label || 'Planned'}
                >
                  {(close) => (
                    <Command>
                      <CommandInput placeholder="Set status..." />
                      <CommandList>
                        <CommandGroup>
                          {PROJECT_STATUS_OPTIONS.map((opt) => (
                            <CommandItem key={opt.value} value={opt.label} onSelect={() => { setProjectStatus(opt.value); close() }}>
                              <Circle className="mr-2 h-3 w-3" />
                              {opt.label}
                              {projectStatus === opt.value && <span className="ml-auto text-xs text-primary">✓</span>}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  )}
                </PropertyPill>

                {/* Lead */}
                <MemberPill
                  currentMember={currentLead}
                  members={members}
                  label="Lead"
                  onSelect={setLeadId}
                />

                {/* Initiative */}
                <PropertyPill
                  icon={<Target className="h-3 w-3 text-muted-foreground" />}
                  label={currentInitiative?.name || 'Initiative'}
                  muted={!currentInitiative}
                >
                  {(close) => (
                    <Command>
                      <CommandInput placeholder="Set initiative..." />
                      <CommandList>
                        <CommandEmpty>No initiatives found</CommandEmpty>
                        <CommandGroup>
                          <CommandItem value="none" onSelect={() => { setInitiativeId(null); close() }}>
                            <Target className="mr-2 h-3 w-3 text-muted-foreground" />
                            No initiative
                          </CommandItem>
                          {initiatives.map((i) => (
                            <CommandItem key={i.id} value={i.name} onSelect={() => { setInitiativeId(i.id); close() }}>
                              <Target className="mr-2 h-3 w-3" />
                              {i.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  )}
                </PropertyPill>

                {/* Start date */}
                <DatePill label="Start date" value={startDate} onChange={setStartDate} />

                {/* Target date */}
                <DatePill label="Target date" value={targetDate} onChange={setTargetDate} />
              </>
            )}

            {entityType === 'initiative' && (
              <>
                {/* Status */}
                <PropertyPill
                  icon={<Circle className="h-3 w-3 text-purple-500" fill="currentColor" />}
                  label={INITIATIVE_STATUS_OPTIONS.find((o) => o.value === initiativeStatus)?.label || 'Planned'}
                >
                  {(close) => (
                    <Command>
                      <CommandInput placeholder="Set status..." />
                      <CommandList>
                        <CommandGroup>
                          {INITIATIVE_STATUS_OPTIONS.map((opt) => (
                            <CommandItem key={opt.value} value={opt.label} onSelect={() => { setInitiativeStatus(opt.value); close() }}>
                              <Circle className="mr-2 h-3 w-3" />
                              {opt.label}
                              {initiativeStatus === opt.value && <span className="ml-auto text-xs text-primary">✓</span>}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  )}
                </PropertyPill>

                {/* Owner */}
                <MemberPill
                  currentMember={currentOwner}
                  members={members}
                  label="Owner"
                  onSelect={setOwnerId}
                />

                {/* Projects */}
                <PropertyPill
                  icon={<Folder className="h-3 w-3 text-muted-foreground" />}
                  label={initiativeProjectIds.length > 0 ? `${initiativeProjectIds.length} project${initiativeProjectIds.length > 1 ? 's' : ''}` : 'Projects'}
                  muted={initiativeProjectIds.length === 0}
                  keepOpen
                >
                  {() => (
                    <Command>
                      <CommandInput placeholder="Add projects..." />
                      <CommandList>
                        <CommandEmpty>No projects found</CommandEmpty>
                        <CommandGroup>
                          {projects.map((p) => {
                            const selected = initiativeProjectIds.includes(p.id)
                            return (
                              <CommandItem
                                key={p.id}
                                value={p.name}
                                onSelect={() => {
                                  setInitiativeProjectIds((prev) =>
                                    selected ? prev.filter((id) => id !== p.id) : [...prev, p.id],
                                  )
                                }}
                              >
                                <Folder className={cn('mr-2 h-3 w-3', selected ? 'text-primary' : 'text-muted-foreground')} />
                                {p.name}
                                {selected && <span className="ml-auto text-xs text-primary">✓</span>}
                              </CommandItem>
                            )
                          })}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  )}
                </PropertyPill>

                {/* Target date */}
                <DatePill label="Target date" value={initiativeTargetDate} onChange={setInitiativeTargetDate} />
              </>
            )}

            {entityType === 'contact' && (
              <>
                {/* Relationship type */}
                <PropertyPill
                  icon={<Contact className="h-3 w-3 text-muted-foreground" />}
                  label={RELATIONSHIP_TYPE_OPTIONS.find((o) => o.value === relationshipType)?.label || 'Contact'}
                >
                  {(close) => (
                    <Command>
                      <CommandInput placeholder="Set relationship..." />
                      <CommandList>
                        <CommandGroup>
                          {RELATIONSHIP_TYPE_OPTIONS.map((opt) => (
                            <CommandItem key={opt.value} value={opt.label} onSelect={() => { setRelationshipType(opt.value); close() }}>
                              <Contact className="mr-2 h-3 w-3" />
                              {opt.label}
                              {relationshipType === opt.value && <span className="ml-auto text-xs text-primary">✓</span>}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  )}
                </PropertyPill>

                {/* Email */}
                <PropertyPill
                  icon={<Mail className="h-3 w-3 text-muted-foreground" />}
                  label={contactEmail || 'Email'}
                  muted={!contactEmail}
                >
                  {(close) => (
                    <div className="p-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Email</p>
                      <Input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') close() }} className="h-8 text-sm" placeholder="email@example.com" />
                      <div className="flex gap-1.5">
                        {contactEmail && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setContactEmail(''); close() }}>Clear</Button>}
                        <Button variant="default" size="sm" className="h-7 text-xs ml-auto" onClick={close}>Done</Button>
                      </div>
                    </div>
                  )}
                </PropertyPill>

                {/* Phone */}
                <PropertyPill
                  icon={<Phone className="h-3 w-3 text-muted-foreground" />}
                  label={contactPhone || 'Phone'}
                  muted={!contactPhone}
                >
                  {(close) => (
                    <div className="p-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Phone</p>
                      <Input type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') close() }} className="h-8 text-sm" placeholder="+1 (555) 000-0000" />
                      <div className="flex gap-1.5">
                        {contactPhone && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setContactPhone(''); close() }}>Clear</Button>}
                        <Button variant="default" size="sm" className="h-7 text-xs ml-auto" onClick={close}>Done</Button>
                      </div>
                    </div>
                  )}
                </PropertyPill>

                {/* Job title */}
                <PropertyPill
                  icon={<Briefcase className="h-3 w-3 text-muted-foreground" />}
                  label={jobTitle || 'Job title'}
                  muted={!jobTitle}
                >
                  {(close) => (
                    <div className="p-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Job title</p>
                      <Input type="text" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') close() }} className="h-8 text-sm" placeholder="e.g. Product Manager" />
                      <div className="flex gap-1.5">
                        {jobTitle && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setJobTitle(''); close() }}>Clear</Button>}
                        <Button variant="default" size="sm" className="h-7 text-xs ml-auto" onClick={close}>Done</Button>
                      </div>
                    </div>
                  )}
                </PropertyPill>

                {/* Company */}
                <PropertyPill
                  icon={<Building2 className="h-3 w-3 text-muted-foreground" />}
                  label={currentCompany?.name || companySearch || 'Company'}
                  muted={!currentCompany && !companySearch}
                >
                  {(close) => (
                    <div className="p-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Company</p>
                      <Input
                        value={companySearch}
                        onChange={(e) => {
                          setCompanySearch(e.target.value)
                          // Clear selected company when typing a new name
                          if (companyId) setCompanyId(null)
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter') close() }}
                        className="h-8 text-sm"
                        placeholder="Type or pick a company"
                      />
                      {companies.length > 0 && !companyId && (
                        <div className="max-h-[120px] overflow-y-auto -mx-1">
                          {companies
                            .filter((c) => !companySearch.trim() || c.name.toLowerCase().includes(companySearch.toLowerCase()))
                            .map((c) => (
                              <button
                                key={c.id}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-muted"
                                onClick={() => { setCompanyId(c.id); setCompanySearch(c.name); close() }}
                              >
                                <Building2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                                <span className="truncate">{c.name}</span>
                                {c.domain && <span className="ml-auto text-xs text-muted-foreground">{c.domain}</span>}
                              </button>
                            ))}
                        </div>
                      )}
                      <div className="flex gap-1.5">
                        {(companySearch || companyId) && (
                          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setCompanyId(null); setCompanySearch(''); close() }}>Clear</Button>
                        )}
                        <Button variant="default" size="sm" className="h-7 text-xs ml-auto" onClick={close}>Done</Button>
                      </div>
                    </div>
                  )}
                </PropertyPill>

                {/* LinkedIn */}
                <PropertyPill
                  icon={<LinkIcon className="h-3 w-3 text-muted-foreground" />}
                  label={linkedinUrl ? 'LinkedIn' : 'LinkedIn'}
                  muted={!linkedinUrl}
                >
                  {(close) => (
                    <div className="p-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">LinkedIn URL</p>
                      <Input type="url" value={linkedinUrl} onChange={(e) => setLinkedinUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') close() }} className="h-8 text-sm" placeholder="https://linkedin.com/in/..." />
                      <div className="flex gap-1.5">
                        {linkedinUrl && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setLinkedinUrl(''); close() }}>Clear</Button>}
                        <Button variant="default" size="sm" className="h-7 text-xs ml-auto" onClick={close}>Done</Button>
                      </div>
                    </div>
                  )}
                </PropertyPill>
              </>
            )}

            {entityType === 'event' && (
              <>
                {/* Start date/time */}
                <div className="flex items-center gap-1">
                  <DateTimePicker
                    value={eventStart}
                    onChange={(date) => {
                      setEventStart(date)
                      // Auto-set end to 1 hour after start if not set or before start
                      if (date && (!eventEnd || eventEnd <= date)) {
                        const end = new Date(date)
                        end.setHours(end.getHours() + 1)
                        setEventEnd(end)
                      }
                    }}
                    granularity={eventIsAllDay ? 'day' : 'minute'}
                    hourCycle={12}
                    displayFormat={{ hour12: eventIsAllDay ? 'MMM d, yyyy' : 'MMM d, hh:mm a', hour24: eventIsAllDay ? 'MMM d, yyyy' : 'MMM d, HH:mm' }}
                    placeholder="Start"
                    className={cn(
                      'h-7 rounded-full border border-border px-2.5 text-xs shadow-sm hover:bg-muted',
                      !eventStart && 'text-muted-foreground',
                    )}
                  />
                </div>

                {/* End date/time */}
                <div className="flex items-center gap-1">
                  <DateTimePicker
                    value={eventEnd}
                    onChange={setEventEnd}
                    granularity={eventIsAllDay ? 'day' : 'minute'}
                    hourCycle={12}
                    displayFormat={{ hour12: eventIsAllDay ? 'MMM d, yyyy' : 'MMM d, hh:mm a', hour24: eventIsAllDay ? 'MMM d, yyyy' : 'MMM d, HH:mm' }}
                    placeholder="End"
                    className={cn(
                      'h-7 rounded-full border border-border px-2.5 text-xs shadow-sm hover:bg-muted',
                      !eventEnd && 'text-muted-foreground',
                    )}
                  />
                </div>

                {/* All day toggle */}
                <button
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted',
                    eventIsAllDay ? 'text-foreground' : 'text-muted-foreground',
                  )}
                  onClick={() => setEventIsAllDay((v) => !v)}
                >
                  <CalendarIcon className="h-3 w-3" />
                  All day
                  {eventIsAllDay && <span className="text-primary">✓</span>}
                </button>

                {/* Location */}
                <PropertyPill
                  icon={<MapPin className="h-3 w-3 text-muted-foreground" />}
                  label={eventLocation || 'Location'}
                  muted={!eventLocation}
                >
                  {(close) => (
                    <div className="p-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Location</p>
                      <Input type="text" value={eventLocation} onChange={(e) => setEventLocation(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') close() }} className="h-8 text-sm" placeholder="Add a location" />
                      <div className="flex gap-1.5">
                        {eventLocation && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setEventLocation(''); close() }}>Clear</Button>}
                        <Button variant="default" size="sm" className="h-7 text-xs ml-auto" onClick={close}>Done</Button>
                      </div>
                    </div>
                  )}
                </PropertyPill>

                {/* A meeting link of ours (phase 7): only where calling is on, never added by itself. */}
                {meetingLinks && !eventIsAllDay && (
                  <button
                    type="button"
                    data-create-event-meeting-link={eventMeetingLink ? 'on' : 'off'}
                    aria-pressed={eventMeetingLink}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted',
                      eventMeetingLink ? 'text-foreground' : 'text-muted-foreground',
                    )}
                    onClick={() => setEventMeetingLink((v) => !v)}
                  >
                    <Video className="h-3 w-3" />
                    {eventMeetingLink ? 'Meeting link added' : 'Add a meeting link'}
                    {eventMeetingLink && <span className="text-primary">✓</span>}
                  </button>
                )}

                {/* Attendees */}
                <PropertyPill
                  icon={<Users className="h-3 w-3 text-muted-foreground" />}
                  label={eventAttendees.length > 0 ? `${eventAttendees.length} attendee${eventAttendees.length > 1 ? 's' : ''}` : 'Invite people'}
                  muted={eventAttendees.length === 0}
                  keepOpen
                >
                  {() => (
                    <div className="p-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Invite people</p>
                      <EmailRecipientInput values={eventAttendees} onChange={setEventAttendees} placeholder="Search contacts..." />
                    </div>
                  )}
                </PropertyPill>

              </>
            )}
          </div>
          )}

          {/* Sub-actions section (action only) */}
          {entityType === 'action' && (pendingSubActions.length > 0 || showSubActionForm) && (
            <div className="px-4 pt-1 pb-4">
              {pendingSubActions.length > 0 && (
                <div className="mb-2 space-y-1">
                  {pendingSubActions.map((sub) => {
                    const subStatus = workflowStates.find((s) => s.id === sub.statusId)
                    const subPriorityOpt = PRIORITY_OPTIONS.find((o) => o.value === sub.priority) ?? PRIORITY_OPTIONS[0]
                    const subAssignees = members.filter((m) => sub.assigneeIds.includes(m.id))
                    return (
                      <div key={sub.id} className="group flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5">
                        <Circle className="h-3 w-3 shrink-0" style={{ color: subStatus?.color || '#6b7280' }} fill={subStatus?.color || '#6b7280'} />
                        <span className="flex-1 truncate text-sm">{sub.title}</span>
                        <div className="flex items-center gap-1.5">
                          {sub.priority !== 'none' && <Flag className={cn('h-3 w-3', subPriorityOpt.color)} />}
                          {subAssignees.length > 0 && (
                            <div className="flex -space-x-1">
                              {subAssignees.slice(0, 2).map((a) =>
                                a.avatar_url ? (
                                  <img key={a.id} src={a.avatar_url} alt="" className="h-4 w-4 rounded-full ring-1 ring-background" />
                                ) : (
                                  <div key={a.id} className="flex h-4 w-4 items-center justify-center rounded-full bg-muted ring-1 ring-background">
                                    <User className="h-2.5 w-2.5 text-muted-foreground" />
                                  </div>
                                )
                              )}
                            </div>
                          )}
                          <button
                            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-all hover:bg-muted hover:text-destructive group-hover:opacity-100"
                            onClick={() => removeSubAction(sub.id)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {showSubActionForm && (
                <div className="rounded-lg border border-dashed border-border/80 bg-muted/30 p-3">
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">Create sub-action</div>
                  <input
                    ref={subTitleRef}
                    value={subTitle}
                    onChange={(e) => setSubTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && subTitle.trim()) {
                        e.preventDefault()
                        handleAddSubAction()
                      }
                    }}
                    placeholder="Action title"
                    className="w-full bg-transparent text-sm font-medium placeholder:text-muted-foreground/50 focus:outline-none"
                  />
                  <textarea
                    value={subDescription}
                    onChange={(e) => setSubDescription(e.target.value)}
                    placeholder="Add description..."
                    rows={2}
                    className="mt-1 w-full resize-none bg-transparent text-xs text-muted-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                  />

                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <PropertyPill
                      icon={<Circle className="h-2.5 w-2.5" style={{ color: workflowStates.find((s) => s.id === subStatusId)?.color || '#6b7280' }} fill={workflowStates.find((s) => s.id === subStatusId)?.color || '#6b7280'} />}
                      label={workflowStates.find((s) => s.id === subStatusId)?.name || 'Backlog'}
                      small
                    >
                      {(close) => (
                        <Command>
                          <CommandInput placeholder="Set status..." />
                          <CommandList>
                            <CommandEmpty>No states found</CommandEmpty>
                            <CommandGroup>
                              {workflowStates.map((state) => (
                                <CommandItem key={state.id} value={state.name} onSelect={() => { setSubStatusId(state.id); close() }}>
                                  <Circle className="mr-2 h-3 w-3" style={{ color: state.color }} fill={state.color} />
                                  {state.name}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      )}
                    </PropertyPill>

                    <PropertyPill
                      icon={<Flag className={cn('h-2.5 w-2.5', (PRIORITY_OPTIONS.find((o) => o.value === subPriority) ?? PRIORITY_OPTIONS[0]).color)} />}
                      label={subPriority === 'none' ? 'Priority' : (PRIORITY_OPTIONS.find((o) => o.value === subPriority)?.label || 'Priority')}
                      muted={subPriority === 'none'}
                      small
                    >
                      {(close) => (
                        <Command>
                          <CommandInput placeholder="Set priority..." />
                          <CommandList>
                            <CommandGroup>
                              {PRIORITY_OPTIONS.map((opt) => (
                                <CommandItem key={opt.value} value={opt.label} onSelect={() => { setSubPriority(opt.value); close() }}>
                                  <Flag className={cn('mr-2 h-3 w-3', opt.color)} />
                                  {opt.label}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      )}
                    </PropertyPill>

                    <PropertyPill
                      icon={
                        subAssigneeIds.length > 0 ? (
                          <div className="flex -space-x-0.5">
                            {members.filter((m) => subAssigneeIds.includes(m.id)).slice(0, 2).map((a) =>
                              a.avatar_url ? (
                                <img key={a.id} src={a.avatar_url} alt="" className="h-3 w-3 rounded-full ring-1 ring-background" />
                              ) : (
                                <div key={a.id} className="flex h-3 w-3 items-center justify-center rounded-full bg-muted ring-1 ring-background">
                                  <User className="h-2 w-2 text-muted-foreground" />
                                </div>
                              )
                            )}
                          </div>
                        ) : (
                          <User className="h-2.5 w-2.5 text-muted-foreground" />
                        )
                      }
                      label={subAssigneeIds.length > 0 ? members.filter((m) => subAssigneeIds.includes(m.id)).map((a) => a.display_name).join(', ') : 'Assignee'}
                      muted={subAssigneeIds.length === 0}
                      small
                      keepOpen
                    >
                      {() => (
                        <Command>
                          <CommandInput placeholder="Assign to..." />
                          <CommandList>
                            <CommandEmpty>No members found</CommandEmpty>
                            <CommandGroup>
                              {members.map((m) => {
                                const isSelected = subAssigneeIds.includes(m.id)
                                return (
                                  <CommandItem
                                    key={m.id}
                                    value={m.display_name}
                                    onSelect={() => {
                                      setSubAssigneeIds((prev) =>
                                        isSelected ? prev.filter((id) => id !== m.id) : [...prev, m.id]
                                      )
                                    }}
                                  >
                                    <div className={cn(
                                      'mr-2 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                                      isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30'
                                    )}>
                                      {isSelected && <Check className="h-2.5 w-2.5" />}
                                    </div>
                                    {m.avatar_url ? (
                                      <img src={m.avatar_url} alt="" className="mr-2 h-3.5 w-3.5 rounded-full" />
                                    ) : (
                                      <User className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                                    )}
                                    {m.display_name}
                                  </CommandItem>
                                )
                              })}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      )}
                    </PropertyPill>

                    <ProjectPill
                      currentProject={projects.find((p) => p.id === subProjectId) || null}
                      projects={projects}
                      onSelect={setSubProjectId}
                      small
                    />

                    <LabelsPill
                      selectedLabels={labels.filter((l) => subLabelIds.includes(l.id))}
                      labels={labels}
                      labelIds={subLabelIds}
                      setLabelIds={setSubLabelIds}
                      small
                    />
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <button className="flex h-6 w-6 items-center justify-center rounded-full border border-border/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                      <Paperclip className="h-3 w-3" />
                    </button>
                    <div className="flex items-center gap-2.5">
                      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
                        <Switch
                          checked={subCreateMore}
                          onCheckedChange={setSubCreateMore}
                          className="h-3.5 w-7 [&>span]:h-2.5 [&>span]:w-2.5 [&>span[data-state=checked]]:translate-x-3.5"
                        />
                        Create more
                      </label>
                      <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={() => { resetSubActionForm(); setShowSubActionForm(false) }}>
                        Cancel
                      </Button>
                      <Button variant="default" size="sm" className="h-7 px-3 text-xs" disabled={!subTitle.trim()} onClick={handleAddSubAction}>
                        Add sub-action
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {!showSubActionForm && pendingSubActions.length > 0 && (
                <button
                  className="mt-1 flex items-center gap-1.5 rounded-md px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => { setShowSubActionForm(true); setTimeout(() => subTitleRef.current?.focus(), 100) }}
                >
                  <Plus className="h-3 w-3" />
                  Add sub-action
                </button>
              )}
            </div>
          )}

          {/* Pending file attachments (action only) */}
          {entityType === 'action' && pendingFiles.length > 0 && (
            <div className="border-t border-border/40 px-4 py-2 flex flex-col gap-1">
              {pendingFiles.map((file, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Paperclip className="h-3 w-3 shrink-0" />
                  <span className="truncate flex-1">{file.name}</span>
                  <button
                    type="button"
                    className="shrink-0 rounded hover:text-foreground transition-colors"
                    onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Footer */}
          <div className={cn('flex items-center justify-between px-4 py-2', ((showSubActionForm && entityType === 'action') || entityType === 'email') && 'hidden')}>
            {isQuickType(entityType) ? (
              <span />
            ) : (
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-full border border-border/60 shadow-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={entityType === 'action' ? 'Attach files' : undefined}
                onClick={() => {
                  if (entityType === 'action') fileInputRef.current?.click()
                }}
              >
                <Paperclip className="h-3.5 w-3.5" />
              </button>
            )}
            <div className="flex items-center gap-3">
              {/* ⌘↵ makes this one and keeps the composer for the next (Create more, as a key). */}
              {entityType !== 'email' && (
                <button
                  type="button"
                  data-create-another=""
                  disabled={!canCreate || creating}
                  onClick={() => handleCreate('another')}
                  className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <span>Create another</span>
                  <span className="flex items-center gap-0.5">
                    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 text-[10px] font-medium">{modKey}</kbd>
                    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 text-[10px] font-medium">↵</kbd>
                  </span>
                </button>
              )}
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="default"
                      size="sm"
                      className="h-8 px-4"
                      disabled={!canCreate || creating}
                      onClick={() => handleCreate('open')}
                    >
                      {creating ? 'Creating...' : `Create ${currentEntityOption.label.toLowerCase()}`}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="flex items-center gap-2 bg-popover text-popover-foreground border shadow-md">
                    <span>Create and open it</span>
                    <span className="flex items-center gap-0.5">
                      <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 text-[10px] font-medium text-muted-foreground">↵</kbd>
                    </span>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
          </>
          )}
        {/* Hidden file input for action attachments */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || [])
            const accepted: File[] = []
            for (const file of files) {
              const check = isAllowedAttachmentFile(file)
              if (check.ok) {
                accepted.push(file)
              } else {
                toast.error(check.reason)
              }
            }
            if (accepted.length > 0) {
              setPendingFiles((prev) => [...prev, ...accepted])
            }
            // Reset so the same file can be selected again
            e.target.value = ''
          }}
        />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

// ── Reusable property pill sub-components ────────────────

/**
 * This dialog's binding of the shared pill. The `dialog` variant reproduces the
 * DOM this file used to build inline (padding-sized rather than fixed-height,
 * `small` for dense rows, 120px label, 220px popover, `keepOpen` for
 * multi-select fields) — see components/views/properties/property-pill.tsx.
 */
function PropertyPill(props: Omit<PropertyPillProps, 'variant'>) {
  return <SharedPropertyPill {...props} variant="dialog" />
}

function MemberPill({
  currentMember,
  members,
  label,
  onSelect,
  small,
}: {
  currentMember: TeamMember | null | undefined
  members: TeamMember[]
  label: string
  onSelect: (id: string | null) => void
  small?: boolean
}) {
  return (
    <PropertyPill
      icon={
        currentMember?.avatar_url
          ? <img src={currentMember.avatar_url} alt="" className={cn(small ? 'h-3 w-3' : 'h-3.5 w-3.5', 'rounded-full')} />
          : <User className={cn(small ? 'h-2.5 w-2.5' : 'h-3 w-3', 'text-muted-foreground')} />
      }
      label={currentMember?.display_name || label}
      muted={!currentMember}
      small={small}
    >
      {(close) => (
        <Command>
          <CommandInput placeholder={`Set ${label.toLowerCase()}...`} />
          <CommandList>
            <CommandEmpty>No members found</CommandEmpty>
            <CommandGroup>
              <CommandItem value="unassigned" onSelect={() => { onSelect(null); close() }}>
                <User className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                No {label.toLowerCase()}
              </CommandItem>
              {members.map((m) => (
                <CommandItem key={m.id} value={m.display_name} onSelect={() => { onSelect(m.id); close() }}>
                  {m.avatar_url
                    ? <img src={m.avatar_url} alt="" className="mr-2 h-3.5 w-3.5 rounded-full" />
                    : <User className="mr-2 h-3.5 w-3.5 text-muted-foreground" />}
                  {m.display_name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      )}
    </PropertyPill>
  )
}

function ProjectPill({
  currentProject,
  projects,
  onSelect,
  small,
}: {
  currentProject: ProjectOption | null | undefined
  projects: ProjectOption[]
  onSelect: (id: string | null) => void
  small?: boolean
}) {
  return (
    <PropertyPill
      icon={<Folder className={cn(small ? 'h-2.5 w-2.5' : 'h-3 w-3', 'text-muted-foreground')} />}
      label={currentProject?.name || 'Project'}
      muted={!currentProject}
      small={small}
    >
      {(close) => (
        <Command>
          <CommandInput placeholder="Set project..." />
          <CommandList>
            <CommandEmpty>No projects found</CommandEmpty>
            <CommandGroup>
              <CommandItem value="none" onSelect={() => { onSelect(null); close() }}>
                <Folder className="mr-2 h-3 w-3 text-muted-foreground" />
                No project
              </CommandItem>
              {projects.map((p) => (
                <CommandItem key={p.id} value={p.name} onSelect={() => { onSelect(p.id); close() }}>
                  <Folder className="mr-2 h-3 w-3" />
                  {p.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      )}
    </PropertyPill>
  )
}

function LabelsPill({
  selectedLabels,
  labels,
  labelIds,
  setLabelIds,
  small,
}: {
  selectedLabels: LabelOption[]
  labels: LabelOption[]
  labelIds: string[]
  setLabelIds: React.Dispatch<React.SetStateAction<string[]>>
  small?: boolean
}) {
  const grouped = groupLabelsByGroupName(labels as any)
  const hasNamedGroups = grouped.some((g) => g.groupName !== null)
  return (
    <PropertyPill
      icon={<Tag className={cn(small ? 'h-2.5 w-2.5' : 'h-3 w-3', 'text-muted-foreground')} />}
      label={selectedLabels.length > 0 ? selectedLabels.map((l) => l.name).join(', ') : 'Labels'}
      muted={selectedLabels.length === 0}
      keepOpen
      small={small}
    >
      {() => (
        <Command>
          <CommandInput placeholder="Add labels..." />
          <CommandList>
            <CommandEmpty>No labels found</CommandEmpty>
            {grouped.map((group) => (
              <CommandGroup
                key={group.groupName ?? '__ungrouped'}
                heading={hasNamedGroups ? (group.groupName ?? 'Other') : undefined}
              >
                {group.labels.map((label) => {
                  const selected = labelIds.includes(label.id)
                  return (
                    <CommandItem
                      key={label.id}
                      value={label.name}
                      onSelect={() => {
                        setLabelIds((prev) =>
                          selected ? prev.filter((id) => id !== label.id) : [...prev, label.id],
                        )
                      }}
                    >
                      <span
                        className={cn(
                          'mr-2 inline-block h-2.5 w-2.5 rounded-full border',
                          selected && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                        )}
                        style={{ backgroundColor: label.color }}
                      />
                      {label.name}
                      {selected && <span className="ml-auto text-xs text-primary">✓</span>}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      )}
    </PropertyPill>
  )
}

function DatePill({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  // `YYYY-MM-DD` as local midnight (new Date() reads it as UTC midnight).
  const dateValue = value ? parseISO(value) : undefined

  return (
    <div className="flex items-center gap-1">
      <DateTimePicker
        value={dateValue}
        onChange={(date) => {
          if (date) {
            // Store as YYYY-MM-DD string
            const y = date.getFullYear()
            const m = String(date.getMonth() + 1).padStart(2, '0')
            const d = String(date.getDate()).padStart(2, '0')
            onChange(`${y}-${m}-${d}`)
          } else {
            onChange('')
          }
        }}
        granularity="day"
        displayFormat={{ hour24: 'MMM d, yyyy', hour12: 'MMM d, yyyy' }}
        placeholder={label}
        className={cn(
          'h-7 rounded-full border border-border px-2.5 text-xs shadow-sm hover:bg-muted',
          !value && 'text-muted-foreground',
        )}
      />
      {value && (
        <button
          className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => onChange('')}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

