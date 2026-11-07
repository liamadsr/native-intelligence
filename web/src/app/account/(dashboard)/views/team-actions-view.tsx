'use client'

import { PageTitle } from '@/components/views/page-title'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { AlertCircle, RefreshCw, Plus, Play, Check, ChevronsUpDown, MoreHorizontal, Trash2, Settings2, LayoutGrid } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { format, parseISO } from 'date-fns'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DateTimePicker } from '@/components/ui/datetime-picker'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { celebrate } from '@/components/celebration/celebrate'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import { useTeams } from '../../teams-context'
import { UnifiedViewLayout } from '@/components/views/unified-view-layout'
import { ViewHeader } from './view-header'

interface Cycle {
  id: string
  name: string
  number: number
  start_date: string
  end_date: string
  status: 'upcoming' | 'active' | 'completed'
  total_actions: number
  completed_actions: number
  in_progress_actions: number
  not_started_actions: number
}

export function TeamActionsView({
  teamId,
  teamName,
  onSelectAction,
  selectedActionId,
  onSelectTeam,
  onViewAllTeams,
  onOpenTeamSettings,
  onVisibleItemsChange,
  obscured = false,
}: {
  teamId: string
  teamName: string
  /** Called when an action row is clicked — parent opens the detail panel */
  onSelectAction?: (id: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>) => void
  /** Currently-open action id so the row can highlight in the list */
  selectedActionId?: string | null
  onSelectTeam?: (teamId: string, teamName: string) => void
  /** Open the full Teams index (grid of every team in the workspace). */
  onViewAllTeams?: () => void
  /** Open this team's high-level settings/configuration page. */
  onOpenTeamSettings?: (teamId: string) => void
  /** Reports the ordered visible rows so the parent can drive prev/next nav */
  onVisibleItemsChange?: React.ComponentProps<typeof UnifiedViewLayout>['onVisibleItemsChange']
  /** True while a detail overlay covers this board. The board stays mounted so
   *  its list state and subscriptions survive; only interaction is suppressed —
   *  including this view's OWN header (team switcher, cycles), which would
   *  otherwise stay tab-reachable behind the opaque overlay. */
  obscured?: boolean
}) {
  const { teams } = useTeams()
  const [cyclesDialogOpen, setCyclesDialogOpen] = useState(false)

  // Cycles state
  const [activeCycle, setActiveCycle] = useState<Cycle | null>(null)
  const [cycles, setCycles] = useState<Cycle[]>([])
  const [loadingCycles, setLoadingCycles] = useState(false)
  const [showCreateCycle, setShowCreateCycle] = useState(false)
  const [newCycleStart, setNewCycleStart] = useState<Date | undefined>()
  const [newCycleEnd, setNewCycleEnd] = useState<Date | undefined>()
  const [newCycleName, setNewCycleName] = useState('')
  const [creatingCycle, setCreatingCycle] = useState(false)
  const [createCycleError, setCreateCycleError] = useState<string | null>(null)
  const createNameInputRef = useRef<HTMLInputElement>(null)
  const [completeCycleTarget, setCompleteCycleTarget] = useState<Cycle | null>(null)
  const [rollToNext, setRollToNext] = useState(true)
  const [completing, setCompleting] = useState(false)
  const [cycleError, setCycleError] = useState<string | null>(null)
  // Inline edit state for the cycles list
  const [editingNameId, setEditingNameId] = useState<string | null>(null)
  const [editingNameValue, setEditingNameValue] = useState('')
  const [deleteCycleTarget, setDeleteCycleTarget] = useState<Cycle | null>(null)

  /**
   * Format a Date as `YYYY-MM-DD` (matches the API's expected date format),
   * from its LOCAL date parts: the pickers hold local-midnight Dates, whose UTC
   * date is a day off for anyone not on UTC.
   */
  const formatDateISO = (d: Date) => format(d, 'yyyy-MM-dd')

  /** Seed sensible default dates when the create form opens: today + 2 weeks. */
  const openCreateCycleForm = useCallback(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const twoWeeks = new Date(today)
    twoWeeks.setDate(today.getDate() + 14)
    setNewCycleName('')
    setNewCycleStart(today)
    setNewCycleEnd(twoWeeks)
    setCreateCycleError(null)
    setShowCreateCycle(true)
    // Auto-focus name input after the form mounts
    requestAnimationFrame(() => createNameInputRef.current?.focus())
  }, [])

  const fetchCycles = useCallback(async () => {
    setLoadingCycles(true)
    const res = await fetch(`/api/account/cycles?team_id=${teamId}`)
    if (res.ok) {
      const data = await res.json()
      setCycles(data.cycles || [])
      const active = (data.cycles || []).find((c: Cycle) => c.status === 'active')
      setActiveCycle(active || null)
    }
    setLoadingCycles(false)
  }, [teamId])

  useEffect(() => {
    fetchCycles()
  }, [fetchCycles])

  // Live-sync cycles for THIS team: create/start/complete/rename/delete from an
  // MCP tool, a teammate, or another tab refresh both the header pill and (when
  // open) the dialog list. The cycle realtime table is unfiltered, so its
  // INSERT/UPDATE payloads carry the raw row columns (including team_id) in
  // detail.fields. Match when the scoping key is absent — realtime DELETE
  // payloads carry an empty fields {} (so `!d.fields` is false) and
  // locally-emitted events may omit fields entirely — treating both as a match
  // and letting the refetch reconcile; only reject a different team_id.
  useEntityListSync(['cycle'], fetchCycles, {
    match: (d) => d.fields?.team_id == null || d.fields.team_id === teamId,
  })

  async function handleCreateCycle() {
    setCreateCycleError(null)
    if (!newCycleStart || !newCycleEnd) {
      setCreateCycleError('Start and end date are required')
      return
    }
    if (newCycleEnd <= newCycleStart) {
      setCreateCycleError('End date must be after start date')
      return
    }
    setCreatingCycle(true)
    const body: Record<string, string> = {
      team_id: teamId,
      start_date: formatDateISO(newCycleStart),
      end_date: formatDateISO(newCycleEnd),
    }
    if (newCycleName.trim()) body.name = newCycleName.trim()

    const res = await fetch('/api/account/cycles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (res.ok) {
      setShowCreateCycle(false)
      setNewCycleStart(undefined)
      setNewCycleEnd(undefined)
      setNewCycleName('')
      fetchCycles()
    } else {
      const data = await res.json().catch(() => null)
      setCreateCycleError(data?.error || 'Failed to create cycle')
    }
    setCreatingCycle(false)
  }

  async function handleStartCycle(cycleId: string) {
    setCycleError(null)
    const res = await fetch(`/api/account/cycles/${cycleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
    if (res.ok) {
      fetchCycles()
    } else {
      const data = await res.json().catch(() => null)
      setCycleError(data?.error || 'Failed to start cycle')
    }
  }

  async function handleCompleteCycle() {
    if (!completeCycleTarget) return
    setCompleting(true)
    const res = await fetch(`/api/account/cycles/${completeCycleTarget.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roll_to_next: rollToNext }),
    })
    if (res.ok) {
      const cycleName = completeCycleTarget.name
      setCompleteCycleTarget(null)
      fetchCycles()
      // Notify the rest of the app that actions changed so open list views refetch.
      window.dispatchEvent(new CustomEvent('dial8:entity-created', { detail: { entityType: 'action' } }))
      // Cute confetti pop + a success toast (this flow had no feedback before).
      celebrate()
      toast.success(`Completed ${cycleName} 🎉`)
    }
    setCompleting(false)
  }

  async function handleDeleteCycle(cycleId: string) {
    const res = await fetch(`/api/account/cycles/${cycleId}`, { method: 'DELETE' })
    if (res.ok) fetchCycles()
  }

  async function confirmDeleteCycle() {
    if (!deleteCycleTarget) return
    const target = deleteCycleTarget
    setDeleteCycleTarget(null)
    await handleDeleteCycle(target.id)
  }

  /** PATCH a field on a cycle with optimistic update + refetch on error. */
  const patchCycle = useCallback(
    async (cycleId: string, updates: { name?: string; start_date?: string; end_date?: string }) => {
      // Optimistic update
      setCycles((prev) =>
        prev.map((c) => (c.id === cycleId ? { ...c, ...updates } : c)),
      )
      setActiveCycle((prev) =>
        prev && prev.id === cycleId ? { ...prev, ...updates } : prev,
      )
      const res = await fetch(`/api/account/cycles/${cycleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setCycleError(data?.error || 'Failed to update cycle')
        // Refetch to reconcile the optimistic change
        fetchCycles()
      }
    },
    [fetchCycles],
  )

  function startEditingName(cycle: Cycle) {
    setEditingNameId(cycle.id)
    setEditingNameValue(cycle.name)
  }

  function commitNameEdit() {
    if (!editingNameId) return
    const cycle = cycles.find((c) => c.id === editingNameId)
    const trimmed = editingNameValue.trim()
    if (cycle && trimmed && trimmed !== cycle.name) {
      patchCycle(editingNameId, { name: trimmed })
    }
    setEditingNameId(null)
    setEditingNameValue('')
  }

  function cancelNameEdit() {
    setEditingNameId(null)
    setEditingNameValue('')
  }

  function formatDateRange(start: string, end: string) {
    // `date` columns arrive as `YYYY-MM-DD`; parseISO reads them as local
    // midnight (new Date() would read UTC midnight and show the day before).
    const s = parseISO(start)
    const e = parseISO(end)
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
    return `${s.toLocaleDateString('en-US', opts)} – ${e.toLocaleDateString('en-US', opts)}`
  }

  return (
    <div className="flex h-full flex-col" inert={obscured || undefined} aria-hidden={obscured || undefined}>
      <ViewHeader className="gap-3">
        <PageTitle label="Team" as="h1" />
        {onSelectTeam && teams.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-border px-3 text-xs font-semibold text-foreground shadow-sm transition-colors hover:bg-muted data-[state=open]:bg-muted dark:shadow-none">
              <span className="max-w-[140px] truncate">{teamName}</span>
              <ChevronsUpDown className="h-3 w-3 opacity-50" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {teams.map((team) => {
                const isSelected = team.id === teamId
                return (
                  <DropdownMenuItem
                    key={team.id}
                    onSelect={(e) => e.preventDefault()}
                    onClick={() => {
                      if (team.id !== teamId) onSelectTeam(team.id, team.name)
                    }}
                    className="gap-2"
                  >
                    <div className={cn(
                      'flex h-4 w-4 items-center justify-center rounded-sm border border-primary',
                      isSelected ? 'bg-primary text-primary-foreground' : 'opacity-50',
                    )}>
                      {isSelected && <Check className="h-3 w-3" />}
                    </div>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">{team.name}</span>
                      {team.issue_prefix && (
                        <span className="text-[10px] text-muted-foreground">{team.issue_prefix}</span>
                      )}
                    </div>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="text-sm font-semibold">{teamName}</span>
        )}

        {/* Team configuration affordances next to the name: this team's
            settings (gear) first, then view-all-teams (grid). */}
        {onOpenTeamSettings && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => onOpenTeamSettings(teamId)}
            title="Team settings"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
        )}
        {onViewAllTeams && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onViewAllTeams}
            title="View all teams"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </Button>
        )}

        <div className="flex-1" />
        {/* Cycles control. When a sprint is active it expands into a pill
            showing the cycle name + progress (replaces the old full-width
            banner); otherwise it stays a bare icon button. */}
        {activeCycle ? (
          <button
            onClick={() => setCyclesDialogOpen(true)}
            title={`${activeCycle.name} · ${formatDateRange(activeCycle.start_date, activeCycle.end_date)}`}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-muted dark:shadow-none"
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            <span className="max-w-[120px] truncate">{activeCycle.name}</span>
            <span className="text-muted-foreground tabular-nums">
              {activeCycle.completed_actions}/{activeCycle.total_actions}
            </span>
          </button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setCyclesDialogOpen(true)}
            title="Cycles"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        )}
      </ViewHeader>

      <div className="flex-1 min-h-0 overflow-hidden">
        <UnifiedViewLayout
          key={`team-actions-${teamId}`}
          entityType="action"
          teamId={teamId}
          onItemSelect={onSelectAction}
          selectedItemId={selectedActionId ?? null}
          onVisibleItemsChange={onVisibleItemsChange}
        />
      </div>

      {/* Cycles management dialog */}
      <Dialog
        open={cyclesDialogOpen}
        onOpenChange={(open) => {
          setCyclesDialogOpen(open)
          if (!open) {
            // Reset transient form state when the dialog closes
            setShowCreateCycle(false)
            setCreateCycleError(null)
            setEditingNameId(null)
            setEditingNameValue('')
          }
        }}
      >
        <DialogContent className="max-w-xl max-h-[85vh] flex flex-col gap-0 p-0">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-3">
            <DialogTitle className="text-sm font-semibold">Cycles</DialogTitle>
          </DialogHeader>
          <ScrollArea className="flex-1">
            <div className="px-5 py-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">All cycles</h3>
                {!showCreateCycle && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={openCreateCycleForm}
                  >
                    <Plus className="h-3 w-3" />
                    New cycle
                  </Button>
                )}
              </div>

            {/* Create cycle form */}
            {showCreateCycle && (
              <div className="mb-4 rounded-lg border border-border p-3 space-y-3">
                <Input
                  ref={createNameInputRef}
                  value={newCycleName}
                  onChange={(e) => setNewCycleName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !creatingCycle) handleCreateCycle()
                    if (e.key === 'Escape') {
                      setShowCreateCycle(false)
                      setCreateCycleError(null)
                    }
                  }}
                  placeholder="Cycle name (optional)"
                  className="h-8 text-sm"
                />
                <div className="flex items-center gap-2">
                  <div className="flex-1 space-y-1">
                    <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Start</label>
                    <DateTimePicker
                      value={newCycleStart}
                      onChange={(d) => setNewCycleStart(d)}
                      granularity="day"
                      placeholder="Start date"
                      displayFormat={{ hour24: 'MMM d, yyyy' }}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">End</label>
                    <DateTimePicker
                      value={newCycleEnd}
                      onChange={(d) => setNewCycleEnd(d)}
                      granularity="day"
                      placeholder="End date"
                      displayFormat={{ hour24: 'MMM d, yyyy' }}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
                {createCycleError && (
                  <p className="text-xs text-destructive">{createCycleError}</p>
                )}
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setShowCreateCycle(false)
                      setNewCycleStart(undefined)
                      setNewCycleEnd(undefined)
                      setNewCycleName('')
                      setCreateCycleError(null)
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={handleCreateCycle}
                    disabled={!newCycleStart || !newCycleEnd || creatingCycle}
                  >
                    {creatingCycle ? 'Creating…' : 'Create cycle'}
                  </Button>
                </div>
              </div>
            )}

            {cycleError && (
              <div className="mb-3 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">{cycleError}</span>
                <button onClick={() => setCycleError(null)} className="shrink-0 text-destructive/60 hover:text-destructive">×</button>
              </div>
            )}

            {loadingCycles ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-lg" />
                ))}
              </div>
            ) : cycles.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <RefreshCw className="mb-3 h-10 w-10 text-muted-foreground/50" />
                <p className="text-sm font-medium text-muted-foreground">No cycles yet.</p>
                <p className="mt-1 text-xs text-muted-foreground/60">
                  Create a cycle to plan time-boxed sprints for your team.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {cycles.map((cycle) => {
                  const progress = cycle.total_actions > 0
                    ? Math.round((cycle.completed_actions / cycle.total_actions) * 100)
                    : 0
                  const isEditingName = editingNameId === cycle.id
                  const startDate = parseISO(cycle.start_date)
                  const endDate = parseISO(cycle.end_date)

                  return (
                    <div
                      key={cycle.id}
                      className={cn(
                        'group/row rounded-lg border border-border p-3 space-y-2',
                        cycle.status === 'active' && 'border-blue-500/30 bg-blue-500/5',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <RefreshCw className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        {isEditingName ? (
                          <Input
                            autoFocus
                            value={editingNameValue}
                            onChange={(e) => setEditingNameValue(e.target.value)}
                            onBlur={commitNameEdit}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitNameEdit()
                              if (e.key === 'Escape') cancelNameEdit()
                            }}
                            className="h-7 min-w-0 flex-1 text-sm"
                          />
                        ) : (
                          <button
                            onClick={() => startEditingName(cycle)}
                            className="min-w-0 flex-1 truncate rounded-sm px-1 py-0.5 text-left text-sm font-medium transition-colors hover:bg-muted"
                            title="Click to rename"
                          >
                            {cycle.name}
                          </button>
                        )}
                        <Badge
                          variant="outline"
                          className={cn(
                            'shrink-0 px-1.5 py-0 text-[10px]',
                            cycle.status === 'active' && 'bg-blue-500/10 text-blue-500',
                            cycle.status === 'completed' && 'bg-green-500/10 text-green-500',
                          )}
                        >
                          {cycle.status}
                        </Badge>
                        {/* Hover-reveal actions menu */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover/row:opacity-100 data-[state=open]:opacity-100"
                              aria-label="Cycle actions"
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem onClick={() => startEditingName(cycle)}>
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {cycle.status === 'upcoming' && (
                              <DropdownMenuItem onClick={() => handleStartCycle(cycle.id)}>
                                <Play className="h-3.5 w-3.5" />
                                Start cycle
                              </DropdownMenuItem>
                            )}
                            {cycle.status === 'active' && (
                              <DropdownMenuItem onClick={() => setCompleteCycleTarget(cycle)}>
                                <Check className="h-3.5 w-3.5" />
                                Complete cycle
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => setDeleteCycleTarget(cycle)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Delete cycle
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>

                      {/* Inline-editable date range */}
                      <div className="flex items-center gap-2 text-xs">
                        <DateTimePicker
                          value={startDate}
                          onChange={(d) => {
                            if (d) patchCycle(cycle.id, { start_date: formatDateISO(d) })
                          }}
                          granularity="day"
                          displayFormat={{ hour24: 'MMM d, yyyy' }}
                          className="h-7 flex-1 border-none bg-transparent px-2 text-xs shadow-none hover:bg-muted/60"
                        />
                        <span className="text-muted-foreground/60">→</span>
                        <DateTimePicker
                          value={endDate}
                          onChange={(d) => {
                            if (d) patchCycle(cycle.id, { end_date: formatDateISO(d) })
                          }}
                          granularity="day"
                          displayFormat={{ hour24: 'MMM d, yyyy' }}
                          className="h-7 flex-1 border-none bg-transparent px-2 text-xs shadow-none hover:bg-muted/60"
                        />
                      </div>

                      {cycle.total_actions > 0 && (
                        <div className="h-1.5 rounded-full bg-muted">
                          <div
                            className="h-1.5 rounded-full bg-green-500 transition-all"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Delete cycle confirmation dialog */}
      <AlertDialog
        open={!!deleteCycleTarget}
        onOpenChange={(open) => !open && setDeleteCycleTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete cycle?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{deleteCycleTarget?.name}&rdquo; will be permanently deleted. Actions in this cycle will keep their data but lose the cycle assignment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteCycle}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Complete cycle confirmation dialog */}
      <AlertDialog
        open={!!completeCycleTarget}
        onOpenChange={(open) => !open && setCompleteCycleTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Complete {completeCycleTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {completeCycleTarget && completeCycleTarget.total_actions - completeCycleTarget.completed_actions > 0 ? (
                <>
                  {completeCycleTarget.total_actions - completeCycleTarget.completed_actions} unfinished action{completeCycleTarget.total_actions - completeCycleTarget.completed_actions !== 1 ? 's' : ''} will{' '}
                  {rollToNext ? 'be moved to the next cycle' : 'remain unassigned'}.
                </>
              ) : (
                'All actions in this cycle are complete.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {completeCycleTarget && completeCycleTarget.total_actions - completeCycleTarget.completed_actions > 0 && (
            <div className="flex items-center gap-2 px-1">
              <Checkbox
                id="roll-to-next"
                checked={rollToNext}
                onCheckedChange={(v) => setRollToNext(!!v)}
              />
              <label htmlFor="roll-to-next" className="text-sm">
                Roll unfinished actions to next cycle
              </label>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleCompleteCycle} disabled={completing}>
              {completing ? 'Completing...' : 'Complete Cycle'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
