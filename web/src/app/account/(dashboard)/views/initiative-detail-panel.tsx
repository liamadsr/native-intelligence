'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { format } from 'date-fns'
import { toast } from 'sonner'
import dynamic from 'next/dynamic'
import { usePanelSection } from './use-panel-section'
import { ListenBrief } from '@/components/read-aloud/listen-brief'
import { plainLine } from '@/lib/read-aloud/listen-briefs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { celebrateFromElement } from '@/components/celebration/celebrate'
import { useScopedLabels } from '@/lib/labels/use-scoped-labels'
import { LabelPickerContent } from '@/components/labels/label-picker-content'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Target,
  Folder,
  Plus,
  X,
  Calendar,
  Trash2,
  CircleCheck,
  CircleAlert,
  CircleDot,
  Circle,
  AlertTriangle,
  Tag,
  Flag,
  AlarmClock,
} from 'lucide-react'
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
import { Calendar as CalendarUI } from '@/components/ui/calendar'
import { NoteEditor } from './note-editor-lazy'
import { cn } from '@/lib/utils'
import { ReferencedIn } from '@/components/entity-links/referenced-in'
import { useCurrentMemberId } from '@/app/account/workspace-switcher'
import { PRIORITY_OPTIONS } from '@/lib/views/property-options'
import { EntityTitleInput } from '@/components/views/entity-title-input'
import { usePropertiesVisible } from '@/components/views/use-properties-visible'
import { WindowProperties, WindowActions } from '@/components/views/window-properties'
import { UnifiedViewLayout, useIsWindowFocused } from '@/components/views/unified-view-layout'
import { PropertyGroup } from '@/components/views/property-group'
import { MemberPanelField, DatePanelField, EnumPanelField, type MemberOption } from '@/components/views/properties'
import { EntityActionsMenu, PANEL_OMIT } from '@/components/entities/entity-actions-menu'
import { MoveToWorkspaceButton } from '@/components/move/move-to-workspace-button'
import { useEntityDetailSync, useEntityListSync } from '@/hooks/use-entity-sync'
import { emitEntityUpdated } from '@/lib/entity-events'
import { ReminderPickerPopover } from '@/components/reminders/reminder-picker'
import { fetchReminder, onReminderChanged } from '@/lib/reminders/client'
import type { Reminder } from '@/lib/reminders/types'
import { useHotkeys } from '@/lib/hotkeys'

// ============================================================
// Types
// ============================================================

interface InitiativeDetail {
  id: string
  name: string
  description: string | null
  status: string
  target_date: string | null
  color: string | null
  icon: string | null
  owner: { id: string; display_name: string; avatar_url: string | null } | null
  projects_list: {
    id: string
    name: string
    status: string
    priority: string
    health: string
    target_date: string | null
    lead: { id: string; display_name: string; avatar_url: string | null } | null
    progress: { total_actions: number; completed_actions: number; canceled_actions: number; percentage: number }
  }[]
  projects: {
    total: number
    by_status: Record<string, number>
  }
  progress: {
    total_actions: number
    completed_actions: number
    canceled_actions: number
    percentage: number
  }
  labels: { id: string; name: string; color: string }[]
  health: string
  // Backward compat
  owner_id: string | null
  owner_name: string | null
  owner_avatar: string | null
  project_count: number
  completed_project_count: number
}

interface WorkspaceMember {
  id: string
  display_name: string
  avatar_url: string | null
}

interface WorkspaceProject {
  id: string
  name: string
  initiative_id: string | null
}

interface WorkspaceLabel {
  id: string
  name: string
  color: string
}

// ============================================================
// Config
// ============================================================

const STATUS_CONFIG: Record<string, { label: string; dot: string }> = {
  planned: { label: 'Planned', dot: 'bg-gray-400' },
  active: { label: 'Active', dot: 'bg-blue-500' },
  completed: { label: 'Completed', dot: 'bg-green-500' },
  archived: { label: 'Archived', dot: 'bg-gray-400' },
}

const STATUS_DOTS: Record<string, string> = {
  planned: 'bg-gray-400',
  active: 'bg-blue-500',
  paused: 'bg-yellow-500',
  completed: 'bg-green-500',
  canceled: 'bg-red-500',
  archived: 'bg-gray-400',
}

const HEALTH_CONFIG: Record<string, { label: string; icon: typeof CircleCheck; color: string }> = {
  on_track: { label: 'On Track', icon: CircleDot, color: 'text-muted-foreground' },
  at_risk: { label: 'At Risk', icon: AlertTriangle, color: 'text-muted-foreground' },
  behind: { label: 'Behind', icon: CircleAlert, color: 'text-muted-foreground' },
  not_started: { label: 'No updates', icon: Circle, color: 'text-muted-foreground/50' },
  completed: { label: 'Completed', icon: CircleCheck, color: 'text-muted-foreground' },
}

const COLOR_PALETTE = [
  '#ef4444','#f97316','#f59e0b','#eab308','#22c55e','#14b8a6','#06b6d4','#3b82f6',
  '#6366f1','#8b5cf6','#a855f7','#ec4899','#f43f5e','#6b7280','#78716c','#0ea5e9',
]

// ============================================================
// Component
// ============================================================

// The Agents tab (plan row 12): the agents that worked on this, loaded when opened.
const EntityActivitySection = dynamic(
  () => import('@/components/work/entity-activity-tab').then((m) => m.EntityActivitySection),
  { ssr: false },
)

const INITIATIVE_SECTIONS = ['overview', 'projects', 'agents'] as const
type InitiativeSection = (typeof INITIATIVE_SECTIONS)[number]

export function InitiativeDetailPanel({
  initiativeId,
  section,
  onSectionChange,
  onClose,
  onDeleted,
}: {
  initiativeId: string
  /** Active inner tab, restored from navigation history. */
  section?: string
  /** Switch the inner tab — pushes a history step so Back returns to the prior tab. */
  onSectionChange?: (section: string) => void
  onClose: () => void
  onDeleted?: () => void
}) {
  const [initiative, setInitiative] = useState<InitiativeDetail | null>(null)
  // The latest initiative, for the listen brief's fallback line.
  const initiativeRef = useRef(initiative)
  initiativeRef.current = initiative
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = usePanelSection<InitiativeSection>(section, onSectionChange, 'overview', INITIATIVE_SECTIONS)
  // The page-level inspector owns visibility; standalone panels use their width.
  const panelBodyRef = useRef<HTMLDivElement>(null)
  const propertiesOpen = usePropertiesVisible(panelBodyRef)
  const currentMemberId = useCurrentMemberId()

  // ── Remind me (⇧H) ──
  // Read here, not inside the picker, so the Remove row is right on the very
  // first frame the popover paints. Declared above the loading early-return
  // below so the hooks run on every render, and so ⇧H is live while the
  // initiative is still loading. Stays current through the reminder-changed
  // event, which is how this button and the header pill agree without either
  // owning the other's state.
  const [reminderOpen, setReminderOpen] = useState(false)
  const [reminder, setReminder] = useState<Reminder | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      void fetchReminder('initiative', initiativeId)
        .then((r) => {
          if (!cancelled) setReminder(r)
        })
        // A failed read costs only the Remove row — no toast in an untouched toolbar.
        .catch(() => {})
    }
    setReminder(null)
    load()
    const off = onReminderChanged((detail) => {
      if (detail && (detail.entityType !== 'initiative' || detail.entityId !== initiativeId)) return
      load()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [initiativeId])
  // Hidden tabs stay mounted and a tab can show several windows at once — gate
  // the hotkey so Shift+H only fires in the FOCUSED window's panel. Outside a
  // window the hook returns true.
  const isWindowFocused = useIsWindowFocused()
  useHotkeys([
    { key: 'h', shift: true, handler: () => setReminderOpen(true), disabled: !isWindowFocused },
  ])

  const [members, setMembers] = useState<WorkspaceMember[]>([])

  // Link project
  const [linkProjectOpen, setLinkProjectOpen] = useState(false)
  const [allProjects, setAllProjects] = useState<WorkspaceProject[]>([])
  const [loadingAllProjects, setLoadingAllProjects] = useState(false)

  // Labels
  const [labelPickerOpen, setLabelPickerOpen] = useState(false)
  const { labels: scopedLabelsRaw, grouped: scopedLabelsGrouped, loading: loadingLabels } = useScopedLabels('initiative')
  const allLabels = useMemo(() => scopedLabelsRaw as unknown as WorkspaceLabel[], [scopedLabelsRaw])

  // Inline editing (debounced, always-editable — matches project detail panel pattern)
  const titleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingTitleRef = useRef<string | null>(null)
  const descriptionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Anchors the completion confetti to the status field (not screen center).
  const statusFieldRef = useRef<HTMLDivElement>(null)

  // Delete
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const fetchInitiative = useCallback(async (background = false) => {
    if (!background) setLoading(true)
    const res = await fetch(`/api/account/initiatives/${initiativeId}`)
    if (res.ok) {
      const data = await res.json()
      setInitiative(prev => {
        if (!prev || !background) return data.initiative
        // Preserve pending in-progress edits so background refresh doesn't overwrite
        const merged = { ...prev, ...data.initiative }
        if (pendingTitleRef.current !== null) merged.name = pendingTitleRef.current
        return merged
      })
    }
    if (!background) setLoading(false)
  }, [initiativeId])

  useEffect(() => {
    fetchInitiative(false)
  }, [fetchInitiative])

  // Background reload for realtime sync — preserves in-flight title edits.
  const reloadInitiative = useCallback(() => {
    fetchInitiative(true)
  }, [fetchInitiative])

  // Live sync: refetch on any remote initiative update, close on remote delete.
  useEntityDetailSync('initiative', initiativeId, {
    refetch: reloadInitiative,
    onDeleted: () => {
      onDeleted?.()
      onClose()
    },
  })

  // The embedded projects_list + progress rollup depend on which projects belong
  // to this initiative, so refetch when a relevant project changes. Scope to
  // this initiative's projects: a realtime UPDATE carries the NEW row, so a
  // project linked to (or unlinked from — new initiative_id is null) this
  // initiative passes; edits to projects under other initiatives are ignored.
  // DELETE payloads carry only the id (fields empty), so the null check lets
  // real deletes through — never gate on a fields key being present.
  useEntityListSync(['project'], reloadInitiative, {
    match: (d) => d.fields?.initiative_id == null || d.fields.initiative_id === initiativeId,
  })

  useEffect(() => {
    fetch('/api/account/workspace')
      .then((r) => r.json())
      .then((d) => setMembers(d.members || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!linkProjectOpen) return
    setLoadingAllProjects(true)
    fetch('/api/account/projects')
      .then((r) => r.json())
      .then((d) => setAllProjects(d.projects || []))
      .catch(() => setAllProjects([]))
      .finally(() => setLoadingAllProjects(false))
  }, [linkProjectOpen])

  // Labels are now fetched via useScopedLabels('initiative') hook above

  async function patchInitiative(updates: Record<string, unknown>) {
    // Capture pre-patch status so we celebrate only on the edge into completed.
    const wasCompleted = initiative?.status === 'completed'
    // Optimistic update — apply changes immediately so the UI doesn't flash
    setInitiative(prev => prev ? { ...prev, ...updates } : prev)
    setSaving(true)
    let ok = false
    try {
      const res = await fetch(`/api/account/initiatives/${initiativeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      ok = res.ok
    } catch {
      // Network failure — handled below like a rejected save.
    } finally {
      setSaving(false)
    }
    if (ok) {
      if (!wasCompleted && updates.status === 'completed') celebrateFromElement(statusFieldRef.current)
      // Fan the change out to every other surface + arm self-echo suppression so
      // reloadInitiative (the detail-sync refetch) can't clobber an in-flight
      // title edit with this tab's own realtime echo.
      emitEntityUpdated({ entityType: 'initiative', id: initiativeId, fields: updates })
    } else {
      toast.error('Failed to save initiative')
    }
    // Background refresh to reconcile enriched data (labels, health, projects)
    // — and, after a failed save, to replace the optimistic value with the
    // server's.
    fetchInitiative(true)
  }

  async function handleSetOwner(memberId: string | null) {
    const member = members.find(m => m.id === memberId)
    // Optimistically update the full owner object so it renders immediately
    setInitiative(prev => prev ? {
      ...prev,
      owner_id: memberId,
      owner: member ? { id: member.id, display_name: member.display_name, avatar_url: member.avatar_url } : null,
      owner_name: member?.display_name || null,
      owner_avatar: member?.avatar_url || null,
    } : prev)
    await patchInitiative({ owner_id: memberId })
  }

  async function handleLinkProject(projectId: string) {
    const res = await fetch(`/api/account/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initiative_id: initiativeId }),
    }).catch(() => null)
    if (!res?.ok) toast.error('Failed to link project')
    setLinkProjectOpen(false)
    fetchInitiative(true)
  }

  async function handleUnlinkProject(projectId: string) {
    // Optimistically remove from list
    setInitiative(prev => prev ? {
      ...prev,
      projects_list: prev.projects_list.filter(p => p.id !== projectId),
    } : prev)
    const res = await fetch(`/api/account/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initiative_id: null }),
    }).catch(() => null)
    // The refetch below restores the row when the unlink was refused.
    if (!res?.ok) toast.error('Failed to unlink project')
    fetchInitiative(true)
  }

  async function handleToggleLabel(labelId: string) {
    if (!initiative) return
    const currentIds = (initiative.labels ?? []).map((l) => l.id)
    const isRemoving = currentIds.includes(labelId)
    const newIds = isRemoving
      ? currentIds.filter((id) => id !== labelId)
      : [...currentIds, labelId]
    // Optimistically update labels in UI
    const targetLabel = allLabels.find(l => l.id === labelId)
    if (targetLabel) {
      setInitiative(prev => prev ? {
        ...prev,
        labels: isRemoving
          ? (prev.labels ?? []).filter(l => l.id !== labelId)
          : [...(prev.labels ?? []), targetLabel],
      } : prev)
    }
    await patchInitiative({ label_ids: newIds })
  }

  async function handleDelete() {
    setDeleting(true)
    const res = await fetch(`/api/account/initiatives/${initiativeId}`, { method: 'DELETE' })
    if (res.ok) {
      setDeleteConfirm(false)
      onDeleted?.()
      onClose()
    }
    setDeleting(false)
  }

  function handleTitleChange(value: string) {
    if (!initiative) return
    setInitiative({ ...initiative, name: value })
    pendingTitleRef.current = value
    if (titleTimeoutRef.current) clearTimeout(titleTimeoutRef.current)
    titleTimeoutRef.current = setTimeout(() => {
      patchInitiative({ name: value })
      pendingTitleRef.current = null
    }, 500)
  }

  function handleDescriptionChange(value: string) {
    if (descriptionTimeoutRef.current) clearTimeout(descriptionTimeoutRef.current)
    descriptionTimeoutRef.current = setTimeout(() => {
      patchInitiative({ description: value || null })
    }, 500)
  }

  const projectsList = initiative?.projects_list || []
  const availableProjects = allProjects.filter(
    (p) => !p.initiative_id || p.initiative_id === initiativeId,
  )

  // Inject the initiative's current owner so it renders immediately, even before
  // the members lookup list finishes loading.
  const ownerMemberOptions = useMemo<MemberOption[]>(() => {
    const owner = initiative?.owner
    if (owner && !members.some((m) => m.id === owner.id)) {
      return [owner, ...members]
    }
    return members
  }, [members, initiative?.owner])

  // Listen mode: where this initiative stands, spoken as it opens. First in
  // both the loading and the loaded panel, so it stays mounted across the two.
  const listenBrief = (
    <ListenBrief
      kind="initiative"
      id={initiativeId}
      fallback={() => {
        const i = initiativeRef.current
        return plainLine(i?.name, i?.status)
      }}
    />
  )

  if (loading || !initiative) {
    return (
      <div className="flex h-full flex-col">
        {listenBrief}
        <div className="p-5 space-y-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    )
  }

  const healthCfg = HEALTH_CONFIG[initiative.health] || HEALTH_CONFIG.not_started
  const HealthIconEl = healthCfg.icon

  return (
    <div className="flex h-full flex-col">
      {listenBrief}

      {/* Sub-header toolbar */}
      <div className="flex h-10 shrink-0 items-center px-3">
        <div className="flex items-center gap-1">
          {INITIATIVE_SECTIONS.map(tab => (
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
          <EntityActionsMenu entity={{ type: 'initiative', id: initiativeId, label: initiative?.name ?? '' }} state={{ archived: initiative ? initiative.status === 'archived' : null, status: initiative?.status ?? null }} omit={PANEL_OMIT} />
          {/* Remind me — the same picker ⇧H opens, anchored on its own button so
                    the popover has somewhere to point when the hotkey fires. */}
          <ReminderPickerPopover
            open={reminderOpen}
            onOpenChange={setReminderOpen}
            entityType="initiative"
            entityId={initiativeId}
            existing={reminder}
          >
            <PreferenceActionButton
              label="Remind me"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="Remind me (⇧H)"
            >
              <AlarmClock className="h-3.5 w-3.5 text-muted-foreground" />
            </PreferenceActionButton>
          </ReminderPickerPopover>
          {/* Move to another workspace — same post-move handling as delete:
                    the initiative leaves this workspace's lists either way. */}
          <MoveToWorkspaceButton
            entityType="initiative"
            id={initiativeId}
            entityLabel={initiative.name || undefined}
            onMoved={() => {
              onDeleted?.()
              onClose()
            }}
          />
          <PreferenceActionButton
            label="Delete initiative"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setDeleteConfirm(true)}
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </PreferenceActionButton>
        </WindowActions>
      </div>

      <div ref={panelBodyRef} className="flex flex-1 min-h-0 justify-center">
        {/* Left: tab content */}
        <div className={cn(
          'w-full min-w-0 min-h-0 flex flex-col',
          activeTab === 'overview' && 'mx-auto max-w-[736px]',
        )}>
          {activeTab === 'overview' && (
        <ScrollArea className="h-full">
          <div className="px-8 pb-28">
            {/* Title + Health badge */}
            <div className="pt-6 pb-2">
              <div className="flex items-start gap-5">
                {/* items-start, not items-center: a wrapped multi-line title
                    would otherwise push the icon to the vertical middle of the
                    block instead of leaving it beside the first line. */}
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  {initiative.icon && <span className="text-xl leading-snug shrink-0">{initiative.icon}</span>}
                  <EntityTitleInput
                    value={initiative.name}
                    onChange={handleTitleChange}
                    placeholder="Untitled initiative"
                  />
                </div>
                <span className={cn('flex items-center gap-1.5 text-xs font-medium shrink-0 mt-1.5 rounded-full border px-2.5 py-0.5', healthCfg.color)}>
                  <HealthIconEl className="h-3 w-3" />
                  {healthCfg.label}
                </span>
              </div>
            </div>

            {/* Description */}
            <div className="mt-4">
              <NoteEditor
                key={initiativeId}
                initialContent={initiative.description || ''}
                onUpdate={handleDescriptionChange}
                placeholder="Add description..."
              />
            </div>

            {/* Progress (action rollup across all projects) */}
            <div className="mt-8 space-y-3">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Progress</label>
              <div className="flex items-center gap-5">
                <div className="h-2 flex-1 rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-2 rounded-full transition-all',
                      initiative.progress.percentage >= 100 ? 'bg-green-500' : initiative.progress.percentage > 0 ? 'bg-blue-500' : 'bg-transparent',
                    )}
                    style={{ width: `${initiative.progress.percentage}%` }}
                  />
                </div>
                <span className="text-sm font-medium tabular-nums">
                  {initiative.progress.percentage}%
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {initiative.progress.completed_actions} of {initiative.progress.total_actions - initiative.progress.canceled_actions} actions completed across {initiative.projects.total} project{initiative.projects.total !== 1 ? 's' : ''}
              </p>
              {initiative.projects.total > 0 && (
                <div className="flex flex-wrap gap-5 mt-1">
                  {Object.entries(initiative.projects.by_status)
                    .filter(([, count]) => count > 0)
                    .map(([status, count]) => (
                      <span key={status} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOTS[status] || 'bg-gray-400')} />
                        {count} {status}
                      </span>
                    ))}
                </div>
              )}
            </div>

          </div>
        </ScrollArea>
          )}

          {activeTab === 'projects' && (
            <UnifiedViewLayout
              key={`initiative-projects-${initiativeId}`}
              entityType="project"
              scopeFilters={[{
                id: '__scope_initiative',
                field: 'initiative_id',
                operator: 'is',
                value: initiativeId,
              }]}
              viewScope={{ type: 'initiative', id: initiativeId }}
            />
          )}

          {activeTab === 'agents' && (
            <ScrollArea className="h-full">
              <div className="px-5">
                <EntityActivitySection entityType="initiative" entityId={initiativeId} />
              </div>
            </ScrollArea>
          )}
        </div>

        {/* Right: properties sidebar */}
        <WindowProperties key={initiativeId} title={initiative.name || 'Initiative'} fallbackVisible={propertiesOpen}>
            <div className="p-4 space-y-4">
              {/* Properties */}
              <PropertyGroup title="Properties">
                {/* Status */}
                <div ref={statusFieldRef}>
                  <EnumPanelField
                    value={initiative.status}
                    options={Object.entries(STATUS_CONFIG).map(([value, cfg]) => ({ value, label: cfg.label, dot: cfg.dot }))}
                    onChange={(v) => patchInitiative({ status: v })}
                    placeholder="Set status"
                  />
                </div>

                {/* Owner */}
                <MemberPanelField
                  value={initiative.owner_id}
                  members={ownerMemberOptions}
                  onChange={(v) => handleSetOwner(v)}
                  placeholder="Set owner"
                  emptyLabel="No owner"
                  currentMemberId={currentMemberId}
                />

                {/* Target date */}
                {/* target_date is a `date` column: read it as local midnight and
                    store the picked LOCAL date (the UTC date is a day off). */}
                <DatePanelField
                  value={initiative.target_date ? initiative.target_date + 'T00:00:00' : null}
                  onChange={(iso) => patchInitiative({ target_date: iso ? format(new Date(iso), 'yyyy-MM-dd') : null })}
                  granularity="day"
                  placeholder="Target date"
                />

                {/* Color */}
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-muted/50">
                      {initiative.color ? (
                        <div className="h-4 w-4 shrink-0 rounded-full" style={{ backgroundColor: initiative.color }} />
                      ) : (
                        <Target className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className={cn(!initiative.color && 'text-muted-foreground')}>
                        {initiative.color ? 'Color' : 'Set color'}
                      </span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-2" align="start">
                    <div className="grid grid-cols-8 gap-1">
                      {COLOR_PALETTE.map((c) => (
                        <button
                          key={c}
                          onClick={() => patchInitiative({ color: c })}
                          className={cn(
                            'h-6 w-6 rounded-full transition-transform hover:scale-110',
                            initiative.color === c && 'ring-2 ring-foreground ring-offset-2 ring-offset-background',
                          )}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                      {initiative.color && (
                        <button
                          onClick={() => patchInitiative({ color: null })}
                          className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed text-muted-foreground hover:bg-muted"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Labels — part of Properties rather than its own group */}
                <Popover open={labelPickerOpen} onOpenChange={setLabelPickerOpen}>
                  <PopoverTrigger asChild>
                    <button className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-muted/50">
                      <Tag className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="text-muted-foreground">Add label</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-56 p-2" align="start">
                    <LabelPickerContent
                      grouped={scopedLabelsGrouped}
                      selectedIds={(initiative.labels ?? []).map((l) => l.id)}
                      onToggle={(id, isAttached) => handleToggleLabel(id)}
                      loading={loadingLabels}
                    />
                  </PopoverContent>
                </Popover>
                {(initiative.labels?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-1 px-2">
                    {(initiative.labels ?? []).map((l) => (
                      <Badge
                        key={l.id}
                        variant="outline"
                        className="border-none px-2 py-0.5 text-[11px]"
                        style={{ backgroundColor: l.color + '20', color: l.color }}
                      >
                        {l.name}
                      </Badge>
                    ))}
                  </div>
                )}
              </PropertyGroup>

              {/* Projects */}
              <PropertyGroup title="Projects">
                <Popover open={linkProjectOpen} onOpenChange={setLinkProjectOpen}>
                  <PopoverTrigger asChild>
                    <button className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-muted/50">
                      <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="text-muted-foreground">Link project</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-56 p-1" align="start">
                    {loadingAllProjects ? (
                      <div className="px-2 py-3 text-xs text-muted-foreground">Loading...</div>
                    ) : availableProjects.filter((p) => p.initiative_id !== initiativeId).length === 0 ? (
                      <div className="px-2 py-3 text-xs text-muted-foreground">No available projects</div>
                    ) : (
                      <ScrollArea className="max-h-48">
                        {availableProjects
                          .filter((p) => p.initiative_id !== initiativeId)
                          .map((p) => (
                            <button
                              key={p.id}
                              onClick={() => handleLinkProject(p.id)}
                              className="flex w-full items-center gap-2 rounded-2xl px-2 py-1.5 text-xs hover:bg-muted"
                            >
                              <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1 truncate">{p.name}</span>
                            </button>
                          ))}
                      </ScrollArea>
                    )}
                  </PopoverContent>
                </Popover>
                {projectsList.length > 0 && (
                  <div className="space-y-0.5">
                    {projectsList.map((p) => {
                      const dotClass = STATUS_DOTS[p.status] || 'bg-gray-400'
                      return (
                        <div
                          key={p.id}
                          className="group flex items-center gap-2 rounded-md px-2 py-1 text-sm"
                        >
                          <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClass)} />
                          <span className="min-w-0 flex-1 truncate text-xs">{p.name}</span>
                          <button
                            onClick={() => handleUnlinkProject(p.id)}
                            className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <X className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </PropertyGroup>
              <ReferencedIn entityType="initiative" entityId={initiativeId} />
            </div>
          </WindowProperties>
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {initiative.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Projects linked to this initiative will be unlinked but not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
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

function InlineDateCalendar({ value, onChange }: { value?: Date; onChange: (d: Date | null) => void }) {
  return (
    <CalendarUI
      mode="single"
      selected={value}
      onSelect={(d) => onChange(d || null)}
      initialFocus
    />
  )
}
