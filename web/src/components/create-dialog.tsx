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
import { plainTextToHtml } from '@/lib/email/plain-text-to-html'
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
  Loader2,
  MapPin,
  Video,
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
import { SendLaterButton } from '@/components/email/send-later-button'
import { scheduleSend } from '@/lib/email/send-later'
import { cn } from '@/lib/utils'
import { useModKeyLabel } from '@/lib/hotkeys'
import { useTeams } from '@/app/account/teams-context'
import { openTarget } from '@/lib/chat-cards/open-card'
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

type CreateEntityType = 'action' | 'project' | 'initiative' | 'contact' | 'email' | 'event'

const ENTITY_TYPE_OPTIONS: { value: CreateEntityType; label: string; icon: React.ReactNode }[] = [
  { value: 'action', label: 'Action', icon: <Circle className="h-3.5 w-3.5" /> },
  { value: 'project', label: 'Project', icon: <Folder className="h-3.5 w-3.5" /> },
  { value: 'initiative', label: 'Initiative', icon: <Target className="h-3.5 w-3.5" /> },
  { value: 'contact', label: 'Contact', icon: <Contact className="h-3.5 w-3.5" /> },
  { value: 'email', label: 'Email', icon: <Mail className="h-3.5 w-3.5" /> },
  { value: 'event', label: 'Event', icon: <CalendarIcon className="h-3.5 w-3.5" /> },
]

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
  const [createMore, setCreateMore] = useState(false)

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

  // ── Email-specific fields ──
  const [emailTo, setEmailTo] = useState<string[]>([])
  const [emailCc, setEmailCc] = useState<string[]>([])
  const [emailBcc, setEmailBcc] = useState<string[]>([])
  const [emailSubject, setEmailSubject] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [showCcBcc, setShowCcBcc] = useState(false)
  const [emailSending, setEmailSending] = useState(false)

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

  // Resolve effective team
  const effectiveTeamId = teamId || teams[0]?.id
  const currentTeam = teams.find((t) => t.id === effectiveTeamId)

  // ── Open triggers: custom events ──
  // Mail's New email (its button and its `c` key) opens the dialog on Email.
  // There is no app-wide Create button or `c` shortcut any more (removed
  // 2026-10-20, Liam): the agent creates things on request.
  useEffect(() => {
    function handleOpenEmail() {
      setEntityType('email')
      setOpen(true)
    }
    function handleOpenContact() {
      setEntityType('contact')
      setOpen(true)
    }
    document.addEventListener('open-create-email', handleOpenEmail)
    document.addEventListener('open-create-contact', handleOpenContact)
    return () => {
      document.removeEventListener('open-create-email', handleOpenEmail)
      document.removeEventListener('open-create-contact', handleOpenContact)
    }
  }, [])

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
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        handleCreate()
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
    // Email
    setEmailTo([])
    setEmailCc([])
    setEmailBcc([])
    setEmailSubject('')
    setEmailBody('')
    setShowCcBcc(false)
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

  async function handleSendEmail() {
    if (emailTo.length === 0) return null
    setEmailSending(true)

    try {
      const res = await fetch('/api/account/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: emailTo,
          cc: emailCc.length > 0 ? emailCc : undefined,
          bcc: emailBcc.length > 0 ? emailBcc : undefined,
          subject: emailSubject,
          body_html: plainTextToHtml(emailBody),
          body_text: emailBody,
          account_id: emailAccountId,
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Could not send the email')
      }
      const data = await res.json()
      return { id: data.message_id, subject: emailSubject, ...data }
    } finally {
      setEmailSending(false)
    }
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

  async function handleSaveEmailDraft() {
    if (emailTo.length === 0) return
    try {
      const res = await fetch('/api/account/email/save-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: emailTo,
          cc: emailCc.length > 0 ? emailCc : undefined,
          bcc: emailBcc.length > 0 ? emailBcc : undefined,
          subject: emailSubject,
          body_html: plainTextToHtml(emailBody),
          account_id: emailAccountId,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(data.error || 'Failed to save draft')
        return
      }
      toast('Draft saved')
      // Trigger email sync so draft appears in drafts folder
      fetch('/api/account/email/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).catch(() => {})
      resetForm()
      setOpen(false)
    } catch {
      toast.error('Failed to save draft')
    }
  }

  function handleCancelEmail() {
    resetForm()
    setOpen(false)
  }

  // Send later: the message is saved as a draft in the picked mailbox and sent
  // at `at` (src/lib/email/send-later.ts). Scheduled, the composer closes and
  // the toast says when, with Undo (a normal draft again).
  async function handleScheduleEmail(at: Date) {
    if (emailTo.length === 0 || !emailAccountId) return
    const row = await scheduleSend(
      {
        account_id: emailAccountId,
        to: emailTo,
        cc: emailCc.length > 0 ? emailCc : undefined,
        bcc: emailBcc.length > 0 ? emailBcc : undefined,
        subject: emailSubject,
        body_html: plainTextToHtml(emailBody),
      },
      at,
    )
    if (!row) return
    resetForm()
    setOpen(false)
  }

  async function handleCreate() {
    if (creating) return

    // Validate based on entity type
    if (entityType === 'contact') {
      if (!title.trim() && !firstName.trim() && !contactEmail.trim()) return
    } else if (entityType === 'email') {
      if (emailTo.length === 0) return
    } else if (entityType === 'event') {
      if (!title.trim() || !eventStart || !eventEnd) return
    } else {
      if (!title.trim()) return
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
        case 'email':
          result = await handleSendEmail()
          break
        case 'event':
          result = await handleCreateEvent()
          break
      }

      if (!result) {
        const label = ENTITY_TYPE_OPTIONS.find((o) => o.value === entityType)?.label || 'item'
        toast.error(`Could not create the ${label.toLowerCase()}`)
        setCreating(false)
        return
      }

      onCreated?.(result)

      // Notify list views to refresh (e.g. UnifiedViewLayout)
      window.dispatchEvent(new CustomEvent('ni:entity-created', {
        detail: { entityType, entity: result },
      }))

      const entityLabel = ENTITY_TYPE_OPTIONS.find((o) => o.value === entityType)?.label || 'Item'

      if (createMore) {
        const displayTitle = entityType === 'contact'
          ? (result.full_name as string) || title.trim()
          : (result.title as string) || (result.name as string) || title.trim()
        const identifier = (result.identifier as string) || ''

        toast(`${entityLabel} created`, {
          description: identifier ? `${identifier} — ${displayTitle}` : displayTitle,
          action: entityType === 'action' ? {
            label: `View ${entityLabel.toLowerCase()}`,
            onClick: () => {
              resetForm()
              setOpen(false)
              openTarget({ type: 'action', id: result!.id as string, title: identifier || displayTitle }, { from: 'create' })
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
      }
    } catch (err) {
      toast.error(
        entityType === 'email' && err instanceof Error ? err.message : 'Something went wrong. Please try again.',
      )
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
  const currentEntityOption = ENTITY_TYPE_OPTIONS.find((o) => o.value === entityType)!

  // ── Title placeholder by entity type ──
  const pickerAccounts = entityType === 'email' ? emailAccounts : calendarAccounts
  const pickerAccountId = entityType === 'email' ? emailAccountId : eventAccountId
  const setPickerAccountId = entityType === 'email' ? setEmailAccountId : setEventAccountId

  const titlePlaceholder = entityType === 'contact' ? 'Contact name' : entityType === 'project' ? 'Project name' : entityType === 'initiative' ? 'Initiative name' : entityType === 'email' ? 'Subject' : entityType === 'event' ? 'Event title' : 'Action title'
  const descriptionPlaceholder = entityType === 'contact' ? 'Add notes...' : entityType === 'email' ? '' : 'Add description...'

  // ── Determine if create button should be enabled ──
  const canCreate = entityType === 'contact'
    ? (title.trim() || firstName.trim() || contactEmail.trim())
    : entityType === 'email'
    ? emailTo.length > 0
    : entityType === 'event'
    ? (title.trim() && eventStart && eventEnd)
    : title.trim()

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
          className="fixed left-[50%] top-[25%] z-50 w-full max-w-[680px] translate-x-[-50%] translate-y-0 overflow-hidden rounded-lg border bg-background shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=open]:slide-in-from-left-1/2"
        >
          <VisuallyHidden.Root><DialogPrimitive.Title>Create new {currentEntityOption.label.toLowerCase()}</DialogPrimitive.Title></VisuallyHidden.Root>

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
                <DropdownMenu>
                  <DropdownMenuTrigger className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-border px-3 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground dark:shadow-none">
                    {currentEntityOption.icon}
                    <span className="max-w-[100px] truncate">New {currentEntityOption.label.toLowerCase()}</span>
                    <ChevronsUpDown className="h-3 w-3 opacity-50" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-48">
                    {ENTITY_TYPE_OPTIONS.map((opt) => (
                      <DropdownMenuItem
                        key={opt.value}
                        onClick={() => setEntityType(opt.value)}
                        className="gap-2"
                      >
                        <div className={cn(
                          'flex h-4 w-4 items-center justify-center rounded-sm border border-primary',
                          entityType === opt.value ? 'bg-primary text-primary-foreground' : 'opacity-50',
                        )}>
                          {entityType === opt.value && <Check className="h-3 w-3" />}
                        </div>
                        {opt.icon}
                        <span className="text-sm">{opt.label}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
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
            /* Email compose form — matches EmailDraftCard style. `ph-no-capture`:
               PostHog session replay blocks the draft and autocapture skips it
               (Native Intelligence never stores mail text). */
            <div className="ph-no-capture">
              {/* Recipients */}
              <div className="space-y-1 border-t border-border/40 px-4 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="w-8 shrink-0 text-muted-foreground">To</span>
                  <EmailRecipientInput values={emailTo} onChange={setEmailTo} placeholder="Type email or search contacts..." />
                  {!showCcBcc && (
                    <div className="flex gap-1">
                      <button onClick={() => setShowCcBcc(true)} className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                        Cc/Bcc
                      </button>
                    </div>
                  )}
                </div>
                {showCcBcc && (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="w-8 shrink-0 text-muted-foreground">Cc</span>
                      <EmailRecipientInput values={emailCc} onChange={setEmailCc} placeholder="Search contacts..." />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-8 shrink-0 text-muted-foreground">Bcc</span>
                      <EmailRecipientInput values={emailBcc} onChange={setEmailBcc} placeholder="Search contacts..." />
                    </div>
                  </>
                )}
                <div className="flex items-center gap-2">
                  <span className="w-8 shrink-0 text-muted-foreground">Subj</span>
                  <input
                    ref={titleRef}
                    value={emailSubject}
                    onChange={(e) => setEmailSubject(e.target.value)}
                    placeholder="Subject"
                    className="flex-1 bg-transparent text-sm focus:outline-none h-7"
                  />
                </div>
              </div>

              {/* Body */}
              <div className="border-t border-border/40 px-4 py-3">
                <textarea
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  placeholder="Write your message..."
                  className="w-full min-h-[150px] resize-none bg-transparent text-sm leading-relaxed placeholder:text-muted-foreground/40 focus:outline-none"
                  autoFocus={emailTo.length > 0}
                />
              </div>
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
                        if (e.key === 'Enter' && !e.shiftKey && canCreate) {
                          e.preventDefault()
                          handleCreate()
                        }
                      }}
                      placeholder="First name"
                      className="w-full bg-transparent text-lg font-medium placeholder:text-muted-foreground/50 focus:outline-none"
                    />
                    <input
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && canCreate) {
                          e.preventDefault()
                          handleCreate()
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
                      if (e.key === 'Enter' && !e.shiftKey && title.trim()) {
                        e.preventDefault()
                        handleCreate()
                      }
                    }}
                    placeholder={titlePlaceholder}
                    className="w-full bg-transparent text-lg font-medium placeholder:text-muted-foreground/50 focus:outline-none"
                  />
                )}
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={descriptionPlaceholder}
                  rows={3}
                  className="w-full resize-none bg-transparent text-sm text-muted-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                />
              </div>
            </>
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
          <div className={cn('flex items-center justify-between px-4 py-2', showSubActionForm && entityType === 'action' && 'hidden')}>
            {entityType === 'email' ? (
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-8 px-3 text-muted-foreground hover:text-foreground" onClick={handleCancelEmail}>
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-3"
                  disabled={emailTo.length === 0}
                  onClick={handleSaveEmailDraft}
                >
                  Save draft
                </Button>
              </div>
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
              {entityType !== 'email' && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                <Switch
                  checked={createMore}
                  onCheckedChange={setCreateMore}
                  className="h-4 w-8 [&>span]:h-3 [&>span]:w-3 [&>span[data-state=checked]]:translate-x-4"
                />
                Create more
              </label>
              )}
              {/* Send later, beside Send: a time picked, the composer closes. */}
              {entityType === 'email' && (
                <SendLaterButton
                  className="h-8 px-3"
                  disabled={!canCreate || creating || emailSending || !emailAccountId}
                  onSchedule={handleScheduleEmail}
                />
              )}
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="default"
                      size="sm"
                      className="h-8 px-4"
                      disabled={!canCreate || creating || emailSending}
                      onClick={handleCreate}
                    >
                      {entityType === 'email' ? (
                        emailSending ? (
                          <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Sending...</>
                        ) : (
                          'Send'
                        )
                      ) : (
                        creating ? 'Creating...' : `Create ${currentEntityOption.label.toLowerCase()}`
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="flex items-center gap-2 bg-popover text-popover-foreground border shadow-md">
                    <span>{entityType === 'email' ? 'Send email' : `Create ${currentEntityOption.label.toLowerCase()}`}</span>
                    <span className="flex items-center gap-0.5">
                      <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 text-[10px] font-medium text-muted-foreground">{modKey}</kbd>
                      <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 text-[10px] font-medium text-muted-foreground">↵</kbd>
                    </span>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
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

