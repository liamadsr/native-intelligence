'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

import dynamic from 'next/dynamic'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { ThinkingOrb } from 'thinking-orbs'
import { createPortal } from 'react-dom'
import { usePanelSection } from './use-panel-section'
import { Button } from '@/components/ui/button'
import { celebrateFromElement } from '@/components/celebration/celebrate'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { DateTimePicker } from '@/components/ui/datetime-picker'
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
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Mic,
  Circle,
  CheckCircle2,
  Clock,
  Trash2,
  Plus,
  Milestone,
  X,
  ExternalLink,
  Search,
  Loader2,
  Lock,
  Monitor,
  Paperclip,
  ZoomIn,
  ZoomOut,
  AlarmClock,
} from 'lucide-react'
import { SiGithub } from '@icons-pack/react-simple-icons'
import { cn } from '@/lib/utils'
import { ReferencedIn } from '@/components/entity-links/referenced-in'
import { RecordHistory } from '@/components/entity-links/record-history'
import { useCurrentMemberId, useWorkspaceId } from '@/app/account/workspace-switcher'
import { cachedJson } from '@/lib/cached-fetch'
import { PRIORITY_OPTIONS } from '@/lib/views/property-options'
import { EntityTitleInput } from '@/components/views/entity-title-input'
import { usePropertiesVisible } from '@/components/views/use-properties-visible'
import { WindowProperties, WindowActions } from '@/components/views/window-properties'
import { ProjectEnvironmentField } from '@/components/environments/project-environment-field'
import { UnifiedViewLayout, useIsWindowFocused } from '@/components/views/unified-view-layout'
import { PropertyGroup } from '@/components/views/property-group'
import {
  MemberPanelField,
  InitiativePanelField,
  DatePanelField,
  EnumPanelField,
  type MemberOption,
  type InitiativeOption as PickerInitiativeOption,
} from '@/components/views/properties'
import { createClient } from '@/lib/supabase/client'
import { downloadFile } from '@/lib/download'
import { uploadAttachment, AttachmentUploadError } from '@/lib/attachments/upload-client'
import { ATTACHMENT_ACCEPT_ATTR, isAllowedAttachmentFile } from '@/lib/attachments/constants'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { toast } from 'sonner'
import type { AttachmentItem } from './capture-utils'
import { ContentTransition } from './transitions'
import { NoteEditor } from './note-editor-lazy'
import { Comments } from '../components/comments'
import { EntityActionsMenu, PANEL_OMIT } from '@/components/entities/entity-actions-menu'
import { MoveToWorkspaceButton } from '@/components/move/move-to-workspace-button'
import { EmojiIconPicker } from '@/components/ui/emoji-icon-picker'
import { Markdown } from '@/components/ui/markdown'
import { useEntityDetailSync, useEntityListSync } from '@/hooks/use-entity-sync'
import { emitEntityUpdated } from '@/lib/entity-events'
import { ReminderPickerPopover } from '@/components/reminders/reminder-picker'
import { fetchReminder, onReminderChanged } from '@/lib/reminders/client'
import type { Reminder } from '@/lib/reminders/types'
import { useHotkeys } from '@/lib/hotkeys'
import { ListenBrief } from '@/components/read-aloud/listen-brief'
import { plainLine } from '@/lib/read-aloud/listen-briefs'

// ============================================================
// Types
// ============================================================

interface ProjectDetail {
  id: string
  name: string
  description: string | null
  icon: string | null
  color: string | null
  status: string
  is_pinned: boolean
  is_archived: boolean
  start_date: string | null
  target_date: string | null
  team_id: string | null
  initiative_id: string | null
  initiative_name: string | null
  lead_id: string | null
  lead_name: string | null
  lead_avatar: string | null
  github_repo: string | null
  environment_id: string | null
  environment_name: string | null
  environment_network_access: 'trusted' | 'restricted' | 'isolated' | null
  milestones: MilestoneItem[]
  action_count: number
  completed_action_count: number
  created_at: string
  updated_at: string
}

interface MilestoneItem {
  id: string
  name: string
  description: string | null
  status: string
  target_date: string | null
  sort_order: number
}

interface TeamMember {
  id: string
  display_name: string
  avatar_url: string | null
}

interface InitiativeOption {
  id: string
  name: string
}

interface GitHubRepo {
  full_name: string
  name: string
  owner: string
  owner_avatar: string
  private: boolean
  html_url: string
  description: string | null
}

// ============================================================
// Status helpers
// ============================================================

const STATUS_CONFIG: Record<string, { label: string; dot: string }> = {
  planned: { label: 'Planned', dot: 'bg-gray-400' },
  active: { label: 'Active', dot: 'bg-blue-500' },
  paused: { label: 'Paused', dot: 'bg-yellow-500' },
  completed: { label: 'Completed', dot: 'bg-green-500' },
  canceled: { label: 'Canceled', dot: 'bg-red-500' },
}

interface WorkflowStateOption {
  id: string
  name: string
  category: string
  color: string
}

const MILESTONE_ICONS: Record<string, typeof Circle> = {
  pending: Circle,
  in_progress: Clock,
  completed: CheckCircle2,
}

// ============================================================
// Component
// ============================================================

// The Agents tab (plan row 10): the agents that worked on this, loaded when opened.
const EntityActivitySection = dynamic(
  () => import('@/components/work/entity-activity-tab').then((m) => m.EntityActivitySection),
  { ssr: false },
)

const PROJECT_SECTIONS = ['overview', 'actions', 'captures', 'documents', 'files', 'agents'] as const
type ProjectSection = (typeof PROJECT_SECTIONS)[number]

interface ProjectDetailPanelProps {
  projectId: string
  /** Active inner tab, restored from navigation history. */
  section?: string
  /** Switch the inner tab — pushes a history step so Back returns to the prior tab. */
  onSectionChange?: (section: string) => void
  onClose: () => void
  onUpdate?: () => void
  onDeleted?: () => void
  onSelectAction?: (actionId: string, title: string, event?: React.MouseEvent) => void
  onOpenCapture?: (captureId: string, title: string, event?: React.MouseEvent) => void
  /** Opens another entity in the host's navigation (initiative, …). Mount sites
   *  that don't wire this simply don't get the open affordance. */
  onOpenEntity?: (entityType: string, id: string, title: string, event?: React.MouseEvent) => void
}

export function ProjectDetailPanel({
  projectId,
  section,
  onSectionChange,
  onClose,
  onUpdate,
  onDeleted,
  onSelectAction,
  onOpenCapture,
  onOpenEntity,
}: ProjectDetailPanelProps) {
  const [project, setProject] = useState<ProjectDetail | null>(null)
  // For the Listen brief's fallback line, read when it plays.
  const projectRef = useRef(project)
  projectRef.current = project
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = usePanelSection<ProjectSection>(section, onSectionChange, 'overview', PROJECT_SECTIONS)
  // The page-level inspector owns visibility; standalone panels use their width.
  const panelBodyRef = useRef<HTMLDivElement>(null)
  const propertiesOpen = usePropertiesVisible(panelBodyRef)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const currentMemberId = useCurrentMemberId()
  const workspaceId = useWorkspaceId()

  // ── Remind me (⇧H) ──
  // Read here, not inside the picker, so the Remove row is right on the very
  // first frame the popover paints. Stays current through the reminder-changed
  // event, which is how this button and the header pill agree without either
  // owning the other's state.
  const [reminderOpen, setReminderOpen] = useState(false)
  const [reminder, setReminder] = useState<Reminder | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      void fetchReminder('project', projectId)
        .then((r) => {
          if (!cancelled) setReminder(r)
        })
        // A failed read costs only the Remove row — no toast in an untouched toolbar.
        .catch(() => {})
    }
    setReminder(null)
    load()
    const off = onReminderChanged((detail) => {
      if (detail && (detail.entityType !== 'project' || detail.entityId !== projectId)) return
      load()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [projectId])
  // Hidden tabs stay mounted and a tab can show several windows at once — gate
  // the hotkey so Shift+H only fires in the FOCUSED window's panel. Outside a
  // window the hook returns true.
  const isWindowFocused = useIsWindowFocused()
  useHotkeys([
    { key: 'h', shift: true, handler: () => setReminderOpen(true), disabled: !isWindowFocused },
  ])

  // Related data for pickers
  const [members, setMembers] = useState<TeamMember[]>([])
  const [initiatives, setInitiatives] = useState<InitiativeOption[]>([])

  // Workflow states for inline action editing
  const [workflowStates, setWorkflowStates] = useState<WorkflowStateOption[]>([])

  // Milestones
  const [newMilestoneName, setNewMilestoneName] = useState('')

  // Knowledge brief — the project's compiled world model (scope_type='project').
  const [brief, setBrief] = useState<{
    content: string
    claim_count: number
    generated_at: string
  } | null>(null)
  const [briefExpanded, setBriefExpanded] = useState(false)

  // GitHub repo linking
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [repoSearch, setRepoSearch] = useState('')
  const [repoPickerOpen, setRepoPickerOpen] = useState(false)


  const descriptionTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const titleTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pendingDescriptionRef = useRef<string | null>(null)
  const pendingTitleRef = useRef<string | null>(null)
  // Anchors the completion confetti to the status field (not screen center).
  const statusFieldRef = useRef<HTMLDivElement>(null)

  // Fetch project
  const fetchProject = useCallback(async () => {
    setLoading(true)
    setProject(null)
    const res = await fetch(`/api/account/projects/${projectId}`)
    if (res.ok) {
      const data = await res.json()
      setProject(data.project)
    }
    setLoading(false)
  }, [projectId])

  useEffect(() => {
    fetchProject()
  }, [fetchProject])

  // Quiet reload for background sync (remote update, milestone change) — keeps
  // the current record on screen instead of flashing "Loading", and preserves
  // any title/description the user is mid-edit (same guard as patchProject).
  const reloadProject = useCallback(async () => {
    const res = await fetch(`/api/account/projects/${projectId}`)
    if (!res.ok) return
    const data = await res.json()
    setProject((prev) => {
      const next = prev ? { ...prev, ...data.project } : data.project
      if (pendingTitleRef.current !== null) next.name = pendingTitleRef.current
      if (pendingDescriptionRef.current !== null) next.description = pendingDescriptionRef.current
      return next
    })
  }, [projectId])

  // Fetch the project's knowledge brief (+ linked claims, currently unused in
  // this panel but returned by the same route). Best-effort — the Brief section
  // stays hidden if there's no brief yet.
  const refetchBrief = useCallback(() => {
    fetch(`/api/account/knowledge/entity-context?type=project&id=${projectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.brief) setBrief(d.brief)
      })
      .catch(() => {})
  }, [projectId])

  useEffect(() => {
    setBrief(null)
    setBriefExpanded(false)
    refetchBrief()
  }, [projectId, refetchBrief])

  // Live sync: refetch on any remote project update, close on remote delete.
  useEntityDetailSync('project', projectId, {
    refetch: reloadProject,
    onDeleted: () => {
      onDeleted?.()
      onClose()
    },
  })

  // Milestones are embedded in the project payload, so a milestone change for
  // this project is picked up by a project reload. Match on project_id when the
  // event carries it (realtime rows do); locally-emitted milestone events may
  // not, so fall through and let the reload confirm.
  useEntityListSync(['milestone'], reloadProject, {
    match: (d) => !d.fields || d.fields.project_id === projectId,
  })

  // Brief recompiles when the project's knowledge graph changes.
  useEntityListSync(['claim'], refetchBrief)

  // Fetch workspace members for lead picker — via cachedJson so repeat panel
  // opens resolve from the shared cache instead of re-firing the heaviest
  // request in the app every mount.
  useEffect(() => {
    let cancelled = false
    cachedJson<{ members?: TeamMember[] }>('/api/account/workspace', { scope: workspaceId })
      .then((d) => {
        if (cancelled || !d) return
        setMembers(
          (d.members || []).map((m) => ({
            id: m.id,
            display_name: m.display_name,
            avatar_url: m.avatar_url,
          })),
        )
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspaceId])

  // Fetch initiatives for picker
  useEffect(() => {
    fetch('/api/account/initiatives')
      .then((r) => r.json())
      .then((d) => {
        setInitiatives(
          (d.initiatives || []).map((i: { id: string; name: string }) => ({
            id: i.id,
            name: i.name,
          })),
        )
      })
      .catch(() => {})
  }, [])

  // Fetch workflow states when project loads (need team_id from first action)
  useEffect(() => {
    if (!projectId) return
    // Fetch one action to get team_id, then fetch workflow states for that team
    fetch(`/api/account/actions?project_id=${projectId}&scope=all&status=all`)
      .then(r => r.json())
      .then(d => {
        const firstAction = (d.actions || [])[0]
        if (firstAction?.team_id) {
          return fetch(`/api/account/workflow-states?team_id=${firstAction.team_id}`)
            .then(r => r.json())
            .then(d2 => setWorkflowStates(d2.states || []))
        }
      })
      .catch(() => {})
  }, [projectId])

  async function fetchGithubRepos() {
    if (githubRepos.length > 0) return // already loaded
    setReposLoading(true)
    try {
      const res = await fetch('/api/account/github/repos')
      const data = await res.json()
      console.log('[GitHub Repos] response:', data)
      setGithubRepos(data.repos || [])
    } catch (err) {
      console.error('[GitHub Repos] fetch error:', err)
    }
    setReposLoading(false)
  }

  async function patchProject(updates: Record<string, unknown>) {
    // Capture the pre-patch status so we celebrate only on the edge into done.
    const wasCompleted = project?.status === 'completed'
    // Optimistic update — reflect the change immediately so fields feel instant.
    // (The PATCH response omits some fields like lead_id, so the optimistic value
    // is what the UI keeps until a full refetch.)
    setProject((prev) => (prev ? { ...prev, ...updates } : prev))
    setSaving(true)
    const res = await fetch(`/api/account/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (res.ok) {
      if (!wasCompleted && updates.status === 'completed') celebrateFromElement(statusFieldRef.current)
      const data = await res.json()
      // The PATCH endpoint returns a simpler shape — merge with existing project
      // Preserve any in-flight edits the user typed while the request was pending
      setProject((prev) => {
        if (!prev) return prev
        const merged = { ...prev, ...data.project }
        if (pendingTitleRef.current !== null) merged.name = pendingTitleRef.current
        if (pendingDescriptionRef.current !== null) merged.description = pendingDescriptionRef.current
        return merged
      })
      // Fan the change out to every other surface + arm self-echo suppression so
      // reloadProject (the detail-sync refetch) can't clobber an in-flight edit
      // with this tab's own realtime echo. The pendingTitleRef/pendingDescription
      // guards above remain as belt-and-braces for title/description specifically.
      emitEntityUpdated({ entityType: 'project', id: projectId, fields: updates })
      onUpdate?.()
    }
    setSaving(false)
  }

  function handleTitleChange(value: string) {
    if (!project) return
    setProject({ ...project, name: value })
    pendingTitleRef.current = value
    if (titleTimeoutRef.current) clearTimeout(titleTimeoutRef.current)
    titleTimeoutRef.current = setTimeout(() => {
      patchProject({ name: value })
      pendingTitleRef.current = null
    }, 500)
  }

  function handleDescriptionChange(value: string) {
    if (!project) return
    pendingDescriptionRef.current = value
    if (descriptionTimeoutRef.current) clearTimeout(descriptionTimeoutRef.current)
    descriptionTimeoutRef.current = setTimeout(() => {
      patchProject({ description: value })
      pendingDescriptionRef.current = null
    }, 500)
  }

  async function handleAddMilestone() {
    const name = newMilestoneName.trim()
    if (!name || !project) return
    const res = await fetch(`/api/account/projects/${projectId}/milestones`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (res.ok) {
      const data = await res.json()
      setProject({
        ...project,
        milestones: [...project.milestones, data.milestone],
      })
    }
    setNewMilestoneName('')
  }

  function handleStartDateSelect(date: Date | undefined) {
    patchProject({ start_date: date ? format(date, 'yyyy-MM-dd') : null })
  }

  function handleTargetDateSelect(date: Date | undefined) {
    patchProject({ target_date: date ? format(date, 'yyyy-MM-dd') : null })
  }

  async function handleDelete() {
    setDeleting(true)
    const res = await fetch(`/api/account/projects/${projectId}`, { method: 'DELETE' })
    if (res.ok) {
      onDeleted?.()
      onClose()
    }
    setDeleting(false)
    setDeleteConfirm(false)
  }

  const statusCfg = STATUS_CONFIG[project?.status || 'planned'] || STATUS_CONFIG.planned
  const denominator = project?.action_count || 0
  const percentage =
    denominator > 0
      ? Math.round(((project?.completed_action_count || 0) / denominator) * 100)
      : 0

  // Inject the project's current lead/initiative so they render immediately,
  // even before the members/initiatives lookup lists finish loading.
  const memberOptions = useMemo<MemberOption[]>(() => {
    if (project?.lead_id && !members.some((m) => m.id === project.lead_id)) {
      return [
        { id: project.lead_id, display_name: project.lead_name ?? 'Lead', avatar_url: project.lead_avatar },
        ...members,
      ]
    }
    return members
  }, [members, project?.lead_id, project?.lead_name, project?.lead_avatar])

  const initiativeOptions = useMemo<PickerInitiativeOption[]>(() => {
    const list: PickerInitiativeOption[] = initiatives.map((i) => ({ id: i.id, name: i.name, icon: null }))
    if (project?.initiative_id && project.initiative_name && !list.some((i) => i.id === project.initiative_id)) {
      list.unshift({ id: project.initiative_id, name: project.initiative_name, icon: null })
    }
    return list
  }, [initiatives, project?.initiative_id, project?.initiative_name])

  return (
    <div className="flex h-full flex-col">
      {/* Listen mode: where this project stands, spoken as it opens. */}
      <ListenBrief
        kind="project"
        id={projectId}
        fallback={() => {
          const p = projectRef.current
          return plainLine(p?.name, p?.status)
        }}
      />

      {/* Sub-header toolbar */}
      <div className="flex h-10 shrink-0 items-center px-3">
        <div className="flex items-center gap-1">
          {PROJECT_SECTIONS.map(tab => (
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
            </button>
          ))}
        </div>
        <WindowActions reveal={reminderOpen} className="ml-auto flex items-center gap-1">
          {saving && <span className="text-xs text-muted-foreground">Saving...</span>}
          <EntityActionsMenu entity={{ type: 'project', id: projectId, label: project?.name ?? '' }} state={{ archived: project?.is_archived ?? null }} omit={PANEL_OMIT} />
          {/* Remind me — the same picker ⇧H opens, anchored on its own button so
                    the popover has somewhere to point when the hotkey fires. */}
          <ReminderPickerPopover
            open={reminderOpen}
            onOpenChange={setReminderOpen}
            entityType="project"
            entityId={projectId}
            existing={reminder}
          >
            <PreferenceActionButton
              label="Remind me"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              title="Remind me (⇧H)"
            >
              <AlarmClock className="h-3.5 w-3.5" />
            </PreferenceActionButton>
          </ReminderPickerPopover>
          {/* Move to another workspace — same post-move handling as delete:
                    the project leaves this workspace's lists either way. */}
          <MoveToWorkspaceButton
            entityType="project"
            id={projectId}
            entityLabel={project?.name || undefined}
            onMoved={() => {
              onDeleted?.()
              onClose()
            }}
          />
          <PreferenceActionButton
            label="Delete project"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500"
            onClick={() => setDeleteConfirm(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </PreferenceActionButton>
        </WindowActions>
      </div>

      <ContentTransition contentKey={projectId} className="flex min-h-0 flex-1 flex-col">
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-sm text-muted-foreground">Loading...</div>
          </div>
        ) : !project ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-sm text-muted-foreground">Project not found</div>
          </div>
        ) : (
          <>

          <div ref={panelBodyRef} className="flex flex-1 min-h-0 justify-center">
            {/* Left: tab content */}
            <div className={cn(
              'w-full min-w-0 min-h-0 flex flex-col',
              activeTab === 'overview' && 'mx-auto max-w-[736px]',
            )}>
              {activeTab === 'overview' && (
              <ScrollArea className="h-full">
              <div className="px-8 pb-28">
                {/* Icon + Title */}
                <div className="pt-6 pb-2">
                  {/* items-start, not items-center: a wrapped multi-line title
                      would otherwise push the emoji to the vertical middle of
                      the block instead of leaving it beside the first line. */}
                  <div className="flex items-start gap-2">
                    <EmojiIconPicker
                      value={project.icon}
                      onChange={(emoji) => patchProject({ icon: emoji })}
                      className="shrink-0"
                    />
                    <EntityTitleInput
                      value={project.name}
                      onChange={handleTitleChange}
                      placeholder="Untitled project"
                    />
                  </div>
                </div>

                {/* Description */}
                <div className="mt-4">
                  <NoteEditor
                    key={projectId}
                    initialContent={project.description || ''}
                    onUpdate={handleDescriptionChange}
                    placeholder="Add description..."
                  />
                </div>

                {/* Brief — the compiled knowledge world model for this project.
                    Collapsed to a few lines with an expand toggle. Omitted when
                    the project has no brief yet. */}
                {brief && (
                  <div className="mt-8 space-y-3">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Brief</p>
                    <div className="rounded-lg border p-4">
                      <div
                        className={cn(
                          'prose prose-sm dark:prose-invert max-w-none text-sm [&_p]:my-1.5 [&_ul]:my-1.5 [&_li]:my-0.5 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm',
                          !briefExpanded && 'line-clamp-4',
                        )}
                      >
                        <Markdown>{brief.content}</Markdown>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <button
                          onClick={() => setBriefExpanded((v) => !v)}
                          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {briefExpanded ? 'Show less' : 'Show more'}
                        </button>
                        <span className="text-[11px] text-muted-foreground/70">
                          compiled {formatRelativeTime(brief.generated_at)}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Milestones — a main-column section (like Comments and
                    Activity), not a sidebar property: the list is wide, and
                    adding one is a real task rather than setting a field. */}
                <div className="mt-8 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Milestones
                      {project.milestones.length > 0 && (
                        <span className="ml-1.5 normal-case tracking-normal text-muted-foreground/60">
                          {project.milestones.filter((m) => m.status === 'completed').length}/
                          {project.milestones.length}
                        </span>
                      )}
                    </p>
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-foreground/80"
                          title="Add milestone"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-56 p-2" align="end">
                        <div className="flex items-center gap-1.5">
                          <Input
                            autoFocus
                            value={newMilestoneName}
                            onChange={(e) => setNewMilestoneName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleAddMilestone()
                            }}
                            placeholder="Milestone name..."
                            className="h-7 flex-1 text-xs"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0"
                            onClick={handleAddMilestone}
                            disabled={!newMilestoneName.trim()}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                  {/* Progress across the project's actions — moved here with
                      Milestones; both answer "how far along is this?". */}
                  <div>
                    <div className="h-2 w-full rounded-full bg-muted">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          percentage >= 100 ? 'bg-green-500' : percentage > 0 ? 'bg-blue-500' : 'bg-transparent',
                        )}
                        style={{ width: `${Math.min(100, percentage)}%` }}
                      />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{percentage}% complete</span>
                      <span>
                        {project.completed_action_count}/{project.action_count} actions
                      </span>
                    </div>
                  </div>

                  {project.milestones.length === 0 ? (
                    <p className="text-xs text-muted-foreground/70">No milestones yet</p>
                  ) : (
                    <div className="space-y-0.5">
                      {project.milestones.map((m) => {
                        const Icon = MILESTONE_ICONS[m.status] || Circle
                        return (
                          <div
                            key={m.id}
                            className={cn(
                              'flex items-center gap-2 rounded-md py-1.5 text-xs',
                              m.status === 'completed' ? 'text-muted-foreground line-through' : '',
                            )}
                          >
                            <Icon
                              className={cn(
                                'h-3.5 w-3.5 shrink-0',
                                m.status === 'completed'
                                  ? 'text-green-500'
                                  : m.status === 'in_progress'
                                    ? 'text-blue-500'
                                    : 'text-muted-foreground',
                              )}
                            />
                            <span className="min-w-0 flex-1 truncate">{m.name}</span>
                            {m.target_date && (
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {formatDateStr(m.target_date)}
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* Comments */}
                <div className="mt-8 space-y-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Comments</p>
                  <Comments commentableType="project" commentableId={project.id} currentMemberId={currentMemberId} />
                </div>

                {/* Activity */}
                <div className="mt-8 space-y-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Activity</p>
                  <div className="relative space-y-0">
                    <div className="absolute left-[9px] top-3 bottom-3 w-px bg-border" />
                    {project.updated_at !== project.created_at && (
                      <div className="relative flex items-start gap-3 py-1.5">
                        <div className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-background">
                          <span className={cn('h-2.5 w-2.5 rounded-full', statusCfg.dot)} />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Last updated &middot; {formatRelativeTime(project.updated_at)}
                        </p>
                      </div>
                    )}
                    {project.target_date && (
                      <div className="relative flex items-start gap-3 py-1.5">
                        <div className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-background">
                          <CalendarIcon className="h-2.5 w-2.5 text-orange-500" />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Target date set to{' '}
                          {formatDateStr(project.target_date)}
                        </p>
                      </div>
                    )}
                    <div className="relative flex items-start gap-3 py-1.5">
                      <div className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-background">
                        <Plus className="h-2.5 w-2.5 text-green-500" />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Created &middot; {formatRelativeTime(project.created_at)}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </ScrollArea>
              )}

              {activeTab === 'actions' && (
                <UnifiedViewLayout
                  key={`project-actions-${projectId}`}
                  entityType="action"
                  onItemSelect={(id, title, event) => onSelectAction?.(id, title, event)}
                  scopeFilters={[{
                    id: '__scope_project',
                    field: 'project_id',
                    operator: 'is',
                    value: projectId,
                  }]}
                  viewScope={{ type: 'project', id: projectId }}
                />
              )}

              {activeTab === 'captures' && (
                <UnifiedViewLayout
                  key={`project-captures-${projectId}`}
                  entityType="capture"
                  onItemSelect={(id, title, event) => onOpenCapture?.(id, title, event)}
                  scopeFilters={[{
                    id: '__scope_project',
                    field: 'project_id',
                    operator: 'is',
                    value: projectId,
                  }]}
                  viewScope={{ type: 'project', id: projectId }}
                />
              )}

              {activeTab === 'documents' && (
                <ProjectDocumentsList projectId={projectId} />
              )}

              {activeTab === 'files' && (
                <ProjectFilesList projectId={projectId} onOpenCapture={onOpenCapture} />
              )}

              {activeTab === 'agents' && (
                <div className="min-h-0 flex-1 overflow-y-auto px-5">
                  <EntityActivitySection entityType="project" entityId={projectId} />
                </div>
              )}
            </div>

            {/* Page-level properties inspector. */}
            <WindowProperties key={projectId} title={project.name || 'Project'} fallbackVisible={propertiesOpen}>
                    <div className="p-4 space-y-4">
                      {/* Properties group */}
                      <PropertyGroup title="Properties">
                        {/* Status */}
                        <div ref={statusFieldRef}>
                          <EnumPanelField
                            value={project.status}
                            options={Object.entries(STATUS_CONFIG).map(([value, cfg]) => ({ value, label: cfg.label, dot: cfg.dot }))}
                            onChange={(v) => patchProject({ status: v })}
                            placeholder="Set status"
                          />
                        </div>

                        {/* Lead */}
                        <MemberPanelField
                          value={project.lead_id}
                          members={memberOptions}
                          onChange={(v) => patchProject({ lead_id: v })}
                          placeholder="Lead"
                          currentMemberId={currentMemberId}
                        />

                        {/* Start date */}
                        <DatePanelField
                          value={project.start_date ? project.start_date + 'T00:00:00' : null}
                          onChange={(iso) => patchProject({ start_date: iso ? toLocalDateOnly(iso) : null })}
                          granularity="day"
                          placeholder="Start date"
                        />

                        {/* Target date */}
                        <DatePanelField
                          value={project.target_date ? project.target_date + 'T00:00:00' : null}
                          onChange={(iso) => patchProject({ target_date: iso ? toLocalDateOnly(iso) : null })}
                          granularity="day"
                          placeholder="Target date"
                        />
                        {/* Initiative — a property row rather than its own group */}
                        <InitiativePanelField
                          value={project.initiative_id}
                          initiatives={initiativeOptions}
                          onChange={(v) => patchProject({ initiative_id: v })}
                          placeholder="Set initiative"
                          onOpen={onOpenEntity && ((id, name, e) => onOpenEntity('initiative', id, name, e))}
                        />
                        {/* Repository — a property row rather than its own group */}
                        {project.github_repo ? (
                          <div className="flex items-center gap-2 px-2 py-1 group">
                            <SiGithub className="h-4 w-4 shrink-0 text-black dark:text-white" />
                            <a
                              href={`https://github.com/${project.github_repo}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="min-w-0 flex-1 truncate text-sm hover:underline"
                            >
                              {project.github_repo}
                            </a>
                            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                            <button
                              onClick={() => patchProject({ github_repo: null })}
                              className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ) : (
                          <Popover
                            open={repoPickerOpen}
                            onOpenChange={(open) => {
                              setRepoPickerOpen(open)
                              if (open) fetchGithubRepos()
                            }}
                          >
                            <PopoverTrigger asChild>
                              <button className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50">
                                <SiGithub className="h-4 w-4 shrink-0" />
                                <span>Link remote repository</span>
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-72 p-0" align="start">
                              <div className="flex items-center gap-2 border-b px-3 py-2">
                                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                                <Input
                                  value={repoSearch}
                                  onChange={(e) => setRepoSearch(e.target.value)}
                                  placeholder="Search repositories..."
                                  className="h-7 border-none bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                                  autoFocus
                                />
                              </div>
                              <div className="max-h-64 overflow-y-auto p-1">
                                {reposLoading ? (
                                  <div className="flex items-center justify-center py-6">
                                    <ThinkingOrb state="working" size={20} theme="auto" />
                                  </div>
                                ) : githubRepos.length === 0 ? (
                                  <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                                    No repositories found. Connect GitHub in Settings &rarr; Integrations.
                                  </p>
                                ) : (
                                  githubRepos
                                    .filter((r) =>
                                      r.full_name.toLowerCase().includes(repoSearch.toLowerCase()),
                                    )
                                    .map((repo) => (
                                      <button
                                        key={repo.full_name}
                                        className="flex w-full items-center gap-2.5 rounded-2xl px-2.5 py-2 text-left text-xs hover:bg-muted/50"
                                        onClick={() => {
                                          patchProject({ github_repo: repo.full_name })
                                          setRepoPickerOpen(false)
                                          setRepoSearch('')
                                        }}
                                      >
                                        <img
                                          src={repo.owner_avatar}
                                          alt=""
                                          className="h-5 w-5 shrink-0 rounded-full"
                                        />
                                        <div className="min-w-0 flex-1">
                                          <div className="flex items-center gap-1.5">
                                            <span className="truncate font-medium">{repo.full_name}</span>
                                            {repo.private && (
                                              <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                                            )}
                                          </div>
                                          {repo.description && (
                                            <p className="truncate text-muted-foreground">{repo.description}</p>
                                          )}
                                        </div>
                                      </button>
                                    ))
                                )}
                              </div>
                            </PopoverContent>
                          </Popover>
                        )}

                        {/* Environment: the project's shared cloud environment, and below it
                            your own "Run my work here on <your Mac>" (docs/plans/environments.md §6). */}
                        <ProjectEnvironmentField
                          projectId={projectId}
                          workspaceId={workspaceId}
                          githubRepo={project.github_repo}
                          environmentId={project.environment_id}
                          environmentName={project.environment_name}
                          environmentNetworkAccess={project.environment_network_access}
                          onLink={(env) =>
                            patchProject({
                              environment_id: env?.id ?? null,
                              environment_name: env?.name ?? null,
                              environment_network_access: env?.networkAccess ?? null,
                            })
                          }
                        />

                      </PropertyGroup>

                      <ReferencedIn entityType="project" entityId={projectId} />
                      <RecordHistory entityType="project" entityId={projectId} />
                    </div>
                  </WindowProperties>
          </div>
          </>
        )}
      </ContentTransition>

      {/* Delete confirmation */}
      <AlertDialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{project?.name}&rdquo; and all its milestones. Actions linked to this project will be unlinked but not deleted.
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
    </div>
  )
}

// ============================================================
// Helpers
// ============================================================

/**
 * The picker emits the picked LOCAL midnight as a UTC ISO string; its UTC date
 * is a day early east of UTC. Store the local calendar date instead.
 */
function toLocalDateOnly(iso: string): string {
  return format(new Date(iso), 'yyyy-MM-dd')
}

function formatDateStr(dateStr: string): string {
  // `date` columns arrive as `YYYY-MM-DD`: parseISO reads them as local
  // midnight, where new Date() reads UTC midnight (the day before in the US).
  const d = parseISO(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
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

function formatRelativeTime(dateStr: string) {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)
  const diffYears = Math.floor(diffDays / 365)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffWeeks < 5) return `${diffWeeks}w ago`
  if (diffMonths < 12) return `${diffMonths}mo ago`
  return `${diffYears}y ago`
}

// ============================================================
// Sub-list components for tabs
// ============================================================

// NOTE: ProjectActionsList was removed — the actions tab now uses
// <UnifiedViewLayout entityType="action" scopeFilters={[project_id=X]} viewScope={{ type: 'project', id }} />
// which provides the same inline editing plus filters, grouping, saved views,
// and list/board layout toggles.


interface CaptureListItem {
  id: string
  title: string
  started_at: string | null
  ended_at: string | null
  duration_seconds: number | null
  ai_processed: boolean
  status: string
}

const CAPTURE_STATUS_OPTIONS = [
  { value: 'active', label: 'Active', dot: 'bg-green-500' },
  { value: 'processing', label: 'Processing', dot: 'bg-blue-500' },
  { value: 'archived', label: 'Archived', dot: 'bg-gray-400' },
]

function ProjectCapturesList({ projectId, onOpenCapture }: { projectId: string; onOpenCapture?: (captureId: string, title: string, event?: React.MouseEvent) => void }) {
  const [captures, setCaptures] = useState<CaptureListItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/account/captures?project_id=${projectId}`)
      .then(r => r.json())
      .then(d => setCaptures(d.captures || []))
      .catch(() => setCaptures([]))
      .finally(() => setLoading(false))
  }, [projectId])

  async function patchCapture(captureId: string, updates: Record<string, unknown>) {
    const res = await fetch(`/api/account/captures/${captureId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (!res.ok) return
    // Optimistic update
    setCaptures(prev => prev.map(c => c.id === captureId ? { ...c, ...updates } as CaptureListItem : c))
  }

  if (loading) {
    return (
      <div className="p-4 space-y-2">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
      </div>
    )
  }

  if (captures.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">No captures in this project</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto pt-4">
      {/* Column headers */}
      <div className="sticky top-0 z-10 flex items-center gap-5 bg-background px-4 pb-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap">
        <span className="flex-1 min-w-0">Name</span>
        <span className="w-16 text-center shrink-0">Duration</span>
        <span className="w-20 text-center shrink-0">Date</span>
        <span className="w-16 text-right shrink-0">Status</span>
      </div>

      <div>
        {captures.map(c => {
          const statusOpt = CAPTURE_STATUS_OPTIONS.find(o => o.value === c.status) ?? CAPTURE_STATUS_OPTIONS[0]
          return (
            <div
              key={c.id}
              onClick={(e) => onOpenCapture?.(c.id, c.title || 'Untitled capture', e)}
              className={cn(
                'flex items-center gap-5 px-4 py-1.5 text-sm hover:bg-muted/50 transition-colors whitespace-nowrap',
                onOpenCapture && 'cursor-pointer',
              )}
            >
              {/* Name (flex-1) */}
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', statusOpt.dot)} />
                <span className="min-w-0 flex-1 truncate">{c.title || 'Untitled capture'}</span>
              </div>

              {/* Duration (w-16) */}
              <div className="w-16 flex items-center justify-center shrink-0">
                <span className="text-[11px] text-muted-foreground">
                  {c.duration_seconds
                    ? c.duration_seconds >= 3600
                      ? `${Math.floor(c.duration_seconds / 3600)}h ${Math.round((c.duration_seconds % 3600) / 60)}m`
                      : `${Math.round(c.duration_seconds / 60)}m`
                    : '—'}
                </span>
              </div>

              {/* Date (w-20) */}
              <div
                className="w-20 flex items-center justify-center shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <DateTimePicker
                  value={c.started_at ? new Date(c.started_at) : undefined}
                  onChange={(d) => patchCapture(c.id, { started_at: d ? d.toISOString() : null })}
                  granularity="day"
                  placeholder=""
                  displayFormat={{ hour24: 'MMM d' }}
                  className="h-7 w-auto min-w-0 border-none shadow-none bg-transparent hover:bg-muted/50 px-1.5 text-[11px] text-muted-foreground justify-center gap-1.5 [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:m-0 [&>svg]:shrink-0"
                />
              </div>

              {/* Status (w-16) */}
              <div
                className="w-16 flex justify-end shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <Select value={c.status} onValueChange={(v) => patchCapture(c.id, { status: v })}>
                  <SelectTrigger hideChevron className="h-7 w-auto gap-1.5 border-none bg-transparent px-1 text-xs shadow-none hover:bg-muted/50 justify-end">
                    <span className={cn('h-2 w-2 rounded-full shrink-0', statusOpt.dot)} />
                    <span className="capitalize text-muted-foreground">{statusOpt.label}</span>
                  </SelectTrigger>
                  <SelectContent>
                    {CAPTURE_STATUS_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>
                        <div className="flex items-center gap-2 capitalize">
                          <span className={cn('h-2 w-2 rounded-full shrink-0', opt.dot)} />
                          {opt.label}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================
// Project file uploads (shared by the Documents and Files tabs)
// ============================================================

async function uploadProjectFiles(
  projectId: string,
  files: File[],
): Promise<{ uploaded: number; errors: string[] }> {
  const errors: string[] = []
  const accepted: File[] = []
  for (const file of files) {
    const check = isAllowedAttachmentFile(file)
    if (check.ok) {
      accepted.push(file)
    } else {
      errors.push(check.reason)
    }
  }

  // Sequential on purpose: display_order is derived from a per-parent count on
  // the server, so concurrent registrations would all land on the same order.
  let uploaded = 0
  for (const file of accepted) {
    try {
      await uploadAttachment({ file, projectId })
      uploaded++
    } catch (err) {
      const message =
        err instanceof AttachmentUploadError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Upload failed. Please try again.'
      errors.push(`${file.name}: ${message}`)
    }
  }

  return { uploaded, errors }
}

/**
 * Drag-and-drop target that uploads dropped files as project attachments.
 * Without a drop handler the browser navigates to the dropped file — in the
 * desktop WebView that replaces the whole app.
 */
function ProjectFileDropZone({
  projectId,
  onUploaded,
  children,
}: {
  projectId: string
  onUploaded?: (count: number) => void
  children: React.ReactNode
}) {
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const { uploaded, errors } = await uploadProjectFiles(projectId, files)
    if (uploaded > 0) {
      toast.success(`Attached ${uploaded} file${uploaded === 1 ? '' : 's'} to this project`)
      onUploaded?.(uploaded)
    }
    for (const err of errors) toast.error(err)
  }

  return (
    <div
      className="relative h-full"
      data-file-drop-zone=""
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current += 1
        setDragActive(true)
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault()
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragActive(false)
      }}
      onDrop={(e) => void handleDrop(e)}
    >
      {children}
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-primary/50 bg-background/80">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Paperclip className="h-4 w-4" />
            Drop files to attach to this project
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================
// Project Documents List
// ============================================================

interface DocumentListItem {
  id: string
  title: string
  created_by_name: string | null
  created_at: string
  updated_at: string
}

function ProjectDocumentsList({ projectId }: { projectId: string }) {
  const [documents, setDocuments] = useState<DocumentListItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/account/documents?project_id=${projectId}`)
      .then(r => r.json())
      .then(d => setDocuments(d.documents || []))
      .catch(() => setDocuments([]))
      .finally(() => setLoading(false))
  }, [projectId])

  if (loading) {
    return (
      <div className="p-4 space-y-2">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
      </div>
    )
  }

  if (documents.length === 0) {
    return (
      <ProjectFileDropZone projectId={projectId}>
        <div className="flex flex-col flex-1 items-center justify-center gap-1 h-full">
          <p className="text-sm text-muted-foreground">No documents in this project</p>
          <p className="text-xs text-muted-foreground/60">
            Drop files here to attach them to the project
          </p>
        </div>
      </ProjectFileDropZone>
    )
  }

  return (
    <ProjectFileDropZone projectId={projectId}>
    <div className="h-full overflow-y-auto pt-4">
      {/* Column headers */}
      <div className="sticky top-0 z-10 flex items-center gap-5 bg-background px-4 pb-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap">
        <span className="flex-1 min-w-0">Name</span>
        <span className="w-24 text-center shrink-0">Author</span>
        <span className="w-20 text-center shrink-0">Updated</span>
      </div>

      <div>
        {documents.map(doc => (
          <div
            key={doc.id}
            className="flex items-center gap-5 px-4 py-1.5 text-sm hover:bg-muted/50 transition-colors whitespace-nowrap"
          >
            {/* Name */}
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{doc.title}</span>
            </div>

            {/* Author */}
            <div className="w-24 text-center shrink-0">
              <span className="text-[11px] text-muted-foreground truncate">
                {doc.created_by_name || '—'}
              </span>
            </div>

            {/* Updated */}
            <div className="w-20 text-center shrink-0">
              <span className="text-[11px] text-muted-foreground">
                {new Date(doc.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
    </ProjectFileDropZone>
  )
}

// ============================================================
// Project Files List
// ============================================================

function ProjectFilesList({ projectId, onOpenCapture }: { projectId: string; onOpenCapture?: (captureId: string, title: string, event?: React.MouseEvent) => void }) {
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({})
  const [captureNames, setCaptureNames] = useState<Record<string, string>>({})
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<AttachmentItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    fetch(`/api/account/attachments?project_id=${projectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(async (data) => {
        if (cancelled || !data?.attachments) {
          if (!cancelled) setLoading(false)
          return
        }
        const items = data.attachments as AttachmentItem[]
        if (!cancelled) setAttachments(items)

        // Generate signed URLs for images
        const imageItems = items.filter((item) => item.file_category === 'image' && item.storage_path)
        if (imageItems.length > 0) {
          const supabase = createClient()
          const results = await Promise.all(
            imageItems.map(async (item) => {
              const { data: urlData } = await supabase.storage
                .from('attachments')
                .createSignedUrl(item.storage_path!, 3600)
              return { id: item.id, url: urlData?.signedUrl || null }
            }),
          )
          if (!cancelled) {
            const urls: Record<string, string> = {}
            for (const r of results) {
              if (r.url) urls[r.id] = r.url
            }
            setSignedUrls(urls)
          }
        }

        // Fetch capture names for files that belong to a capture
        const captureIds = [...new Set(items.map((i) => i.note_id || i.capture_id).filter(Boolean))] as string[]
        if (captureIds.length > 0) {
          const supabase = createClient()
          const { data: captures } = await supabase
            .from('captures')
            .select('id, title')
            .in('id', captureIds)
          if (!cancelled && captures) {
            const names: Record<string, string> = {}
            for (const c of captures) {
              names[c.id] = c.title || 'Untitled capture'
            }
            setCaptureNames(names)
          }
        }

        if (!cancelled) setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [projectId, refreshKey])

  // Only images for the lightbox
  const imageAttachments = attachments.filter((a) => a.file_category === 'image')

  // Keyboard navigation for lightbox
  useEffect(() => {
    if (lightboxIndex === null) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        setLightboxIndex((i) => i !== null && i > 0 ? i - 1 : i)
      } else if (e.key === 'ArrowRight') {
        setLightboxIndex((i) => i !== null && i < imageAttachments.length - 1 ? i + 1 : i)
      } else if (e.key === 'Escape') {
        setLightboxIndex(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightboxIndex, imageAttachments.length])

  const handleDownload = useCallback(async (item: AttachmentItem) => {
    if (!item.storage_path) return
    const supabase = createClient()
    const { data } = await supabase.storage
      .from('attachments')
      .createSignedUrl(item.storage_path, 60)
    if (data?.signedUrl) {
      try {
        await downloadFile(data.signedUrl, item.file_name)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Download failed')
      }
    }
  }, [])

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  const handleUpload = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0) return
    setUploading(true)
    try {
      const { uploaded, errors } = await uploadProjectFiles(projectId, Array.from(list))
      if (uploaded > 0) {
        toast.success(`Attached ${uploaded} file${uploaded === 1 ? '' : 's'} to this project`)
        refresh()
      }
      for (const err of errors) toast.error(err)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [projectId, refresh])

  const performDelete = useCallback(async (item: AttachmentItem) => {
    setDeleting(true)
    try {
      const res = await fetch(`/api/account/attachments/${item.id}`, { method: 'DELETE' })
      if (res.ok) {
        toast.success('File deleted')
        refresh()
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        toast.error(body?.error ?? 'Delete failed')
      }
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }, [refresh])

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const uploadButton = (
    <button
      onClick={() => fileInputRef.current?.click()}
      disabled={uploading}
      className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted hover:border-foreground/30 transition-colors disabled:opacity-50"
    >
      {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
      Upload
    </button>
  )

  if (loading) {
    return (
      <div className="p-4 space-y-2">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
      </div>
    )
  }

  if (attachments.length === 0) {
    return (
      <ProjectFileDropZone projectId={projectId} onUploaded={refresh}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => void handleUpload(e.target.files)}
        />
        <div className="flex flex-col flex-1 items-center justify-center gap-2 h-full">
          <p className="text-sm text-muted-foreground">No files in this project</p>
          <p className="text-xs text-muted-foreground/60">Drag &amp; drop files here, or</p>
          {uploadButton}
        </div>
      </ProjectFileDropZone>
    )
  }

  return (
    <ProjectFileDropZone projectId={projectId} onUploaded={refresh}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void handleUpload(e.target.files)}
      />
      <div className="h-full overflow-y-auto pt-2">
        {/* Toolbar */}
        <div className="flex items-center justify-end px-4 pb-2">
          {uploadButton}
        </div>
        {/* Column headers */}
        <div className="sticky top-0 z-10 flex items-center gap-5 bg-background px-4 pb-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap">
          <span className="flex-1 min-w-0">Name</span>
          <span className="w-24 text-center shrink-0">Source</span>
          <span className="w-16 text-center shrink-0">Size</span>
          <span className="w-20 text-center shrink-0">Date</span>
          <span className="w-14 shrink-0" />
        </div>

        <div>
          {attachments.map((item) => {
            const captureId = item.note_id || item.capture_id
            const captureName = captureId ? captureNames[captureId] : null
            return (
              <div
                key={item.id}
                className="flex items-center gap-5 px-4 py-1.5 text-sm hover:bg-muted/50 transition-colors whitespace-nowrap group"
              >
                {/* Preview + Name */}
                <div className="flex items-center gap-2.5 flex-1 min-w-0">
                  {item.file_category === 'image' && signedUrls[item.id] ? (
                    <button
                      onClick={() => {
                        const imgIdx = imageAttachments.findIndex((a) => a.id === item.id)
                        if (imgIdx >= 0) setLightboxIndex(imgIdx)
                      }}
                      className="h-8 w-8 rounded object-cover shrink-0 overflow-hidden transition-opacity hover:opacity-80"
                    >
                      <img
                        src={signedUrls[item.id]}
                        alt={item.file_name}
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded bg-muted shrink-0">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.file_name}</span>
                </div>

                {/* Source capture */}
                <div className="w-24 text-center shrink-0">
                  {captureId && captureName ? (
                    <button
                      onClick={(e) => onOpenCapture?.(captureId, captureName, e)}
                      className="inline-flex items-center gap-1 max-w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors truncate"
                      title={captureName}
                    >
                      <Mic className="h-3 w-3 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{captureName}</span>
                    </button>
                  ) : (
                    <span className="text-[11px] text-muted-foreground/40">—</span>
                  )}
                </div>

                {/* Size */}
                <div className="w-16 text-center shrink-0">
                  <span className="text-[11px] text-muted-foreground">
                    {formatFileSize(item.file_size_bytes)}
                  </span>
                </div>

                {/* Date */}
                <div className="w-20 text-center shrink-0">
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(item.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                </div>

                {/* Download / Delete */}
                <div className="w-14 shrink-0 flex justify-center gap-2">
                  <button
                    onClick={() => handleDownload(item)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                    aria-label={`Download ${item.file_name}`}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setPendingDelete(item)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${item.file_name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Fullscreen lightbox for images — portalled to body to escape panel stacking context */}
      {lightboxIndex !== null && imageAttachments[lightboxIndex] && createPortal(
        <ProjectFilesLightbox
          images={imageAttachments}
          signedUrls={signedUrls}
          captureNames={captureNames}
          currentIndex={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onOpenCapture={onOpenCapture}
        />,
        document.body,
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title="Delete file"
        description={
          pendingDelete
            ? `This permanently deletes "${pendingDelete.file_name}" — the file, its search index, and its knowledge-graph links.${
                pendingDelete.note_id || pendingDelete.capture_id
                  ? ' It will also disappear from its capture.'
                  : ''
              }`
            : ''
        }
        busy={deleting}
        onConfirm={() => {
          if (pendingDelete) void performDelete(pendingDelete)
        }}
      />
    </ProjectFileDropZone>
  )
}

// ── Project Files Lightbox ─────────────────────────────────────

const ZOOM_MIN = 0.25
const ZOOM_MAX = 5
const ZOOM_STEP = 0.25

function ProjectFilesLightbox({
  images,
  signedUrls,
  captureNames,
  currentIndex,
  onIndexChange,
  onClose,
  onOpenCapture,
}: {
  images: AttachmentItem[]
  signedUrls: Record<string, string>
  captureNames: Record<string, string>
  currentIndex: number
  onIndexChange: (i: number) => void
  onClose: () => void
  onOpenCapture?: (captureId: string, title: string, event?: React.MouseEvent) => void
}) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const imageContainerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 })

  const current = images[currentIndex]
  const url = current ? signedUrls[current.id] : null
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < images.length - 1
  const captureId = current ? (current.note_id || current.capture_id) : null
  const captureName = captureId ? captureNames[captureId] : null
  const isZoomed = zoom !== 1

  // Reset zoom/pan when image changes
  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [currentIndex])

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(z + ZOOM_STEP, ZOOM_MAX))
  }, [])

  const handleZoomOut = useCallback(() => {
    setZoom((z) => {
      const next = Math.max(z - ZOOM_STEP, ZOOM_MIN)
      if (next <= 1) setPan({ x: 0, y: 0 })
      return next
    })
  }, [])

  const handleResetZoom = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  // Mouse wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
    setZoom((z) => {
      const next = Math.min(Math.max(z + delta, ZOOM_MIN), ZOOM_MAX)
      if (next <= 1) setPan({ x: 0, y: 0 })
      return next
    })
  }, [])

  // Pan via drag when zoomed
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (zoom <= 1) return
    e.preventDefault()
    setDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [zoom, pan])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    })
  }, [dragging])

  const handlePointerUp = useCallback(() => {
    setDragging(false)
  }, [])

  // Double-click to toggle zoom
  const handleDoubleClick = useCallback(() => {
    if (zoom > 1) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
    } else {
      setZoom(2)
    }
  }, [zoom])

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose()
      }}
    >
      {/* Top-left: zoom + go to capture */}
      <div className="absolute top-8 left-4 flex items-center gap-2">
        {/* Zoom controls */}
        <div className="h-8 inline-flex items-center gap-0.5 rounded-full bg-white/10 px-1">
          <button
            onClick={handleZoomOut}
            disabled={zoom <= ZOOM_MIN}
            className="h-6 w-6 inline-flex items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
            title="Zoom out"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleResetZoom}
            className="h-6 min-w-[3rem] inline-flex items-center justify-center rounded-full px-1 text-[11px] font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            title="Reset zoom"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={handleZoomIn}
            disabled={zoom >= ZOOM_MAX}
            className="h-6 w-6 inline-flex items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
            title="Zoom in"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Go to capture */}
        {captureId && captureName && onOpenCapture && (
          <button
            onClick={(e) => {
              onClose()
              onOpenCapture(captureId, captureName, e)
            }}
            className="h-8 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 text-xs text-white/70 transition-colors hover:bg-white/20 hover:text-white"
          >
            <Mic className="h-3.5 w-3.5" />
            <span className="max-w-[200px] truncate">Go to capture</span>
          </button>
        )}
      </div>

      {/* Top-center: counter */}
      {images.length > 1 && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 h-8 inline-flex items-center rounded-full bg-white/10 px-3 text-xs text-white/70">
          {currentIndex + 1} / {images.length}
        </div>
      )}

      {/* Top-right: close */}
      <button
        onClick={onClose}
        className="absolute top-8 right-4 h-8 w-8 inline-flex items-center justify-center rounded-full bg-white/10 text-white/70 transition-colors hover:bg-white/20 hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>

      {/* Previous */}
      {hasPrev && (
        <button
          onClick={() => onIndexChange(currentIndex - 1)}
          className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}

      {/* Image with zoom + pan */}
      {url ? (
        <div
          ref={imageContainerRef}
          className="flex items-center justify-center overflow-hidden"
          style={{ width: '70vw', height: '70vh' }}
          onWheel={handleWheel}
        >
          <img
            src={url}
            alt={current?.file_name || ''}
            className={cn(
              'max-h-[70vh] max-w-[70vw] rounded-lg object-contain select-none',
              isZoomed ? 'cursor-grab' : 'cursor-zoom-in',
              dragging && 'cursor-grabbing',
            )}
            style={{
              transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
              transition: dragging ? 'none' : 'transform 0.15s ease-out',
            }}
            draggable={false}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onDoubleClick={handleDoubleClick}
          />
        </div>
      ) : (
        <div className="flex h-40 w-40 items-center justify-center rounded-lg bg-white/5">
          <div className="h-8 w-8 animate-pulse rounded bg-white/10" />
        </div>
      )}

      {/* Next */}
      {hasNext && (
        <button
          onClick={() => onIndexChange(currentIndex + 1)}
          className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      )}
    </div>
  )
}
