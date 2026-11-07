'use client'

import { PageTitle } from '@/components/views/page-title'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Boxes,
  Check,
  Cog,
  ChevronRight,
  Crown,
  GripVertical,
  Loader2,
  Lock,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Plus,
  Shield,
  Trash2,
  UserMinus,
  Users,
} from 'lucide-react'
import { DndProvider, useDrag, useDrop } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AgentIcon } from '@/components/agents/agent-icon'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogFooter,
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
import { FlowIndicator } from '@/components/views/flow-indicator'
import type { FlowRef } from '@/components/views/hooks/use-flow-status-ids'
import { useTeams } from '@/app/account/teams-context'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import {
  emitEntityCreated,
  emitEntityUpdated,
  emitEntityDeleted,
  wasRecentlyMutatedLocally,
} from '@/lib/entity-events'
import { SYSTEM_TEAMMATE_BLURBS, type SystemTeammateKey } from '@/lib/work/system-teammates'
import { AiTeammateDialog, type LibraryRef } from './ai-teammate-dialog'
import { ViewHeader } from './view-header'

// ─── Types ───────────────────────────────────────────────────────────

interface TeamSummary {
  id: string
  name: string
  slug: string
  icon: string | null
  issue_prefix: string
  is_private: boolean
  member_count: number
  ai_member_count?: number
  created_at: string
}

interface WorkflowState {
  id: string
  team_id: string
  name: string
  category: string
  color: string
  sort_order: number
  is_default: boolean
  description: string | null
}

interface Team {
  id: string
  name: string
  slug: string
  icon: string | null
  issue_prefix: string
  issue_counter: number
  is_private: boolean
  timezone: string
  created_at: string
  updated_at: string
}

interface TeamMember {
  team_member_id: string
  team_role: string
  joined_at: string
  member_id: string
  display_name: string
  avatar_url: string | null
  workspace_role: string
  email: string
}

interface WorkspaceMember {
  id: string
  display_name: string
  avatar_url: string | null
  role: string
  email: string
}

interface AiMember {
  id: string
  name: string
  avatar_url: string | null
  team_role: string
  created_at: string
  /** A built-in loop's teammate (row 4): grouped last, not removable, persona fixed. */
  is_system?: boolean
  system_key?: string | null
  /** A loop's work agent (migration 302): speaks for its loops, takes no assignments, persona fixed. */
  fronts_only?: boolean
  /** What the caller can read: another creator's personal persona or skill drops out. */
  agent: LibraryRef | null
  skills: LibraryRef[]
  /** What it has, readable or not (the edit dialog keeps what it can't name). */
  agent_recipe_id?: string | null
  skill_recipe_ids?: string[]
}

/** User-built teammates first, then the built-in loops' (plan 1.4: the system
 *  lane is a filter on the roster, not a separate list). */
function rosterOrder(list: AiMember[]): AiMember[] {
  return [...list.filter((m) => !m.is_system), ...list.filter((m) => m.is_system)]
}

/** Every skill it has, the ones the viewer can't read included. */
function skillCount(m: AiMember): number {
  return m.skill_recipe_ids?.length ?? m.skills.length
}

function getInitials(name: string) {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

const COLOR_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
  '#6366f1', '#8b5cf6', '#a855f7', '#ec4899',
  '#f43f5e', '#6b7280', '#78716c', '#0ea5e9',
]

const CATEGORY_OPTIONS = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'unstarted', label: 'Unstarted' },
  { value: 'started', label: 'Started' },
  { value: 'completed', label: 'Completed' },
  { value: 'canceled', label: 'Canceled' },
]

// ═══ Top-level view: index ⇄ detail ════════════════════════════════════

export function TeamsView({
  onOpenTeamBoard,
  initialTeamId = null,
  fromBoard = null,
  onTeamChange,
}: {
  onOpenTeamBoard: (teamId: string, teamName: string) => void
  /** The team open in the detail changed (null: back to the index). A chat
   *  card keeps it (pages in the chat); a tab needs no word of it. */
  onTeamChange?: (teamId: string | null) => void
  /** When set, open straight into this team's settings (e.g. from the team
   *  boards header gear icon) instead of the index. */
  initialTeamId?: string | null
  /** The board the user navigated from — used for the "back to board"
   *  breadcrumb on both the index and the detail panel. */
  fromBoard?: { teamId: string; teamName: string } | null
}) {
  const [selectedTeamId, setSelected] = useState<string | null>(initialTeamId)
  const setSelectedTeamId = (teamId: string | null) => {
    setSelected(teamId)
    onTeamChange?.(teamId)
  }

  if (selectedTeamId) {
    // The detail was reached straight from a board (gear icon) when it's still
    // showing the team we were deep-linked into — that makes "back" the board.
    // Once the user navigates via the index, back becomes the Teams index.
    const cameFromBoard = selectedTeamId === initialTeamId
    return (
      <TeamDetailPanel
        teamId={selectedTeamId}
        cameFromBoard={cameFromBoard}
        onBack={() => setSelectedTeamId(null)}
        onOpenBoard={onOpenTeamBoard}
      />
    )
  }

  return (
    <TeamsIndex
      onSelectTeam={setSelectedTeamId}
      onOpenBoard={onOpenTeamBoard}
      fromBoard={fromBoard}
    />
  )
}

// ═══ Index: list + create teams ════════════════════════════════════════

function TeamsIndex({
  onSelectTeam,
  onOpenBoard,
  fromBoard,
}: {
  onSelectTeam: (teamId: string) => void
  onOpenBoard: (teamId: string, teamName: string) => void
  /** When the index was opened from a board, offer a breadcrumb back to it. */
  fromBoard: { teamId: string; teamName: string } | null
}) {
  const { refetchTeams } = useTeams()
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPrefix, setNewPrefix] = useState('')
  const [prefixTouched, setPrefixTouched] = useState(false)
  const [createError, setCreateError] = useState('')

  const fetchTeams = useCallback(async () => {
    const res = await fetch('/api/account/teams')
    if (res.ok) {
      const data = await res.json()
      setTeams(data.teams)
    }
  }, [])

  useEffect(() => {
    // fetch-on-mount + loading flag; setState lands after the fetch resolves.
    fetchTeams().finally(() => setLoading(false))
  }, [fetchTeams])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const name = newName.trim()
    if (!name || creating) return
    setCreating(true)
    setCreateError('')
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const issue_prefix = newPrefix.trim() || name.slice(0, 3).toUpperCase()

    const res = await fetch('/api/account/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, slug, issue_prefix }),
    })

    if (res.ok) {
      setNewName('')
      setNewPrefix('')
      setPrefixTouched(false)
      setShowCreate(false)
      fetchTeams()
      refetchTeams()
    } else {
      const data = await res.json().catch(() => null)
      setCreateError(data?.error || 'Failed to create team')
    }
    setCreating(false)
  }

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        history="custom"
        title={
          fromBoard ? (
            <nav className="flex items-center gap-1.5 text-sm" aria-label="Breadcrumb">
              <PageTitle label={`${fromBoard.teamName} board`} iconName="Team" onClick={() => onOpenBoard(fromBoard.teamId, fromBoard.teamName)} />
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
              <span className="font-semibold text-foreground">Teams</span>
            </nav>
          ) : (
            <>
              <PageTitle label="Teams" as="h1" />
            </>
          )
        }
        actions={
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => setShowCreate(true)}
            title="New team"
            aria-label="New team"
          >
            <Plus className="h-4 w-4" />
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-10">
          <div>
            <h1 className="text-2xl font-bold">Teams</h1>
            <p className="mt-1 text-muted-foreground">
              Teams in this workspace — humans and AI teammates, working together.
            </p>
          </div>

          <div className="mt-8">
            {loading ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-32 w-full rounded-xl" />
                ))}
              </div>
            ) : teams.length === 0 ? (
              <div className="mt-16 text-center">
                <Users className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
                <p className="text-lg font-medium text-muted-foreground">No teams yet</p>
                <Button className="mt-4" onClick={() => setShowCreate(true)}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  Create a team
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {teams.map((team) => (
                  <div
                    key={team.id}
                    className="group flex flex-col rounded-xl border bg-card p-4 transition-colors hover:border-foreground/20"
                  >
                    <button
                      className="flex items-start justify-between text-left"
                      onClick={() => onSelectTeam(team.id)}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-semibold">{team.name}</span>
                          {team.is_private && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />}
                        </div>
                        <Badge variant="outline" className="mt-1.5 text-[10px]">
                          {team.issue_prefix}
                        </Badge>
                      </div>
                    </button>

                    <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" />
                        {team.member_count}
                      </span>
                      {(team.ai_member_count ?? 0) > 0 && (
                        <span className="flex items-center gap-1">
                          <Boxes className="h-3.5 w-3.5" />
                          {team.ai_member_count}
                        </span>
                      )}
                    </div>

                    <div className="mt-3 flex items-center gap-2 border-t pt-3">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 flex-1 text-xs"
                        onClick={() => onSelectTeam(team.id)}
                      >
                        Manage
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 flex-1 text-xs"
                        onClick={() => onOpenBoard(team.id, team.name)}
                      >
                        <LayoutGrid className="mr-1 h-3.5 w-3.5" />
                        Board
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Create team dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a team</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-team-name" className="text-xs">Team name</Label>
              <Input
                id="new-team-name"
                placeholder="Engineering"
                value={newName}
                onChange={(e) => {
                  const val = e.target.value
                  setNewName(val)
                  setCreateError('')
                  if (!prefixTouched) setNewPrefix(val.trim().slice(0, 3).toUpperCase())
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-team-prefix" className="text-xs">
                Issue prefix <span className="text-muted-foreground">(unique)</span>
              </Label>
              <Input
                id="new-team-prefix"
                placeholder="ENG"
                maxLength={5}
                value={newPrefix}
                onChange={(e) => { setNewPrefix(e.target.value.toUpperCase()); setPrefixTouched(true); setCreateError('') }}
                className="w-32 uppercase"
              />
            </div>
            {createError && <p className="text-xs text-destructive">{createError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newName.trim() || !newPrefix.trim() || creating}>
                {creating ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Plus className="mr-1 h-3 w-3" />}
                Create team
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ═══ Workflow-state row (ported from settings team detail) ═════════════

const WORKFLOW_STATE_DND_TYPE = 'WORKFLOW_STATE_ROW'
interface DragWorkflowStateItem { index: number }

function WorkflowStateRow({
  state, index, flows, onReorder, onPersist, onUpdate, onDelete,
}: {
  state: WorkflowState
  index: number
  flows: FlowRef[]
  onReorder: (dragIndex: number, hoverIndex: number) => void
  onPersist: () => void
  onUpdate: (id: string, updates: Record<string, unknown>) => void
  onDelete: (id: string) => void
}) {
  const [{ isDragging }, dragRef] = useDrag<DragWorkflowStateItem, void, { isDragging: boolean }>({
    type: WORKFLOW_STATE_DND_TYPE,
    item: { index },
    end: () => onPersist(),
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  })
  const [{ isOver }, dropRef] = useDrop<DragWorkflowStateItem, void, { isOver: boolean }>({
    accept: WORKFLOW_STATE_DND_TYPE,
    hover(item) {
      if (item.index === index) return
      onReorder(item.index, index)
      item.index = index
    },
    collect: (monitor) => ({ isOver: monitor.isOver() }),
  })

  return (
    <div
      ref={dropRef as unknown as React.Ref<HTMLDivElement>}
      className={`flex items-center gap-3 rounded-md border px-3 py-2 transition-opacity ${
        isDragging ? 'opacity-40' : 'opacity-100'
      } ${isOver ? 'bg-muted/50' : ''}`}
    >
      <div
        ref={dragRef as unknown as React.Ref<HTMLDivElement>}
        className="shrink-0 cursor-grab text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
        title="Drag to reorder"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </div>
      <span className="h-4 w-4 shrink-0 rounded-full border" style={{ backgroundColor: state.color }} />
      <Input
        defaultValue={state.name}
        className="h-7 flex-1 text-xs"
        onBlur={(e) => {
          const val = e.target.value.trim()
          if (val && val !== state.name) onUpdate(state.id, { name: val })
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
      <Badge variant="outline" className="shrink-0 text-[10px]">{state.category}</Badge>
      {flows.length > 0 && <FlowIndicator flows={flows} />}
      <button
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
          state.is_default
            ? 'border-blue-500 bg-blue-500 text-white'
            : 'border-muted-foreground/30 text-muted-foreground/50 hover:border-muted-foreground'
        }`}
        title={state.is_default ? 'Default state' : 'Set as default'}
        onClick={() => { if (!state.is_default) onUpdate(state.id, { is_default: true }) }}
      >
        {state.is_default ? <Check className="h-2.5 w-2.5" /> : 'D'}
      </button>
      <button
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => onDelete(state.id)}
        title="Delete state"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

// ═══ Detail: one team (general, workflow, members incl. AI) ════════════

function TeamDetailPanel({
  teamId,
  cameFromBoard,
  onBack,
  onOpenBoard,
}: {
  teamId: string
  /** When true, this team's settings were opened directly from its board
   *  (gear icon) — so the breadcrumb leads back to the board, not the index. */
  cameFromBoard: boolean
  onBack: () => void
  onOpenBoard: (teamId: string, teamName: string) => void
}) {
  const { refetchTeams } = useTeams()
  const [team, setTeam] = useState<Team | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [aiMembers, setAiMembers] = useState<AiMember[]>([])
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([])
  // Who's looking, from the workspace read the panel already makes: whether
  // they may manage this team's AI teammates (below).
  const [viewer, setViewer] = useState<{ role: string | null; memberId: string | null }>({ role: null, memberId: null })
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [addMemberId, setAddMemberId] = useState('')

  const [workflowStates, setWorkflowStates] = useState<WorkflowState[]>([])
  const [flowsByStatus, setFlowsByStatus] = useState<Map<string, FlowRef[]>>(new Map())
  const savedSortOrderRef = useRef<Map<string, number>>(new Map())
  const [newStateName, setNewStateName] = useState('')
  const [newStateCategory, setNewStateCategory] = useState('unstarted')
  const [stateError, setStateError] = useState('')
  const [addingState, setAddingState] = useState(false)

  const [name, setName] = useState('')
  const [issuePrefix, setIssuePrefix] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const [showAiDialog, setShowAiDialog] = useState(false)
  const [editAiTarget, setEditAiTarget] = useState<AiMember | null>(null)
  const [deleteAiTarget, setDeleteAiTarget] = useState<AiMember | null>(null)

  const fetchAll = useCallback(async () => {
    const [teamRes, membersRes, aiRes, wsRes, statesRes, flowsRes] = await Promise.all([
      fetch(`/api/account/teams/${teamId}`),
      fetch(`/api/account/teams/${teamId}/members`),
      fetch(`/api/account/teams/${teamId}/ai-members`),
      fetch('/api/account/workspace'),
      fetch(`/api/account/workflow-states?team_id=${teamId}`),
      fetch('/api/account/flows'),
    ])

    if (teamRes.ok) {
      const data = await teamRes.json()
      setTeam(data.team)
      // Belt-and-braces: don't overwrite the editable fields from a background
      // refetch while an autosave is still pending — the user may be mid-edit
      // and the fetched row predates their unsaved keystrokes.
      if (saveTimeoutRef.current === null) {
        setName(data.team.name)
        setIssuePrefix(data.team.issue_prefix)
        setIsPrivate(data.team.is_private ?? false)
      }
    }
    if (membersRes.ok) setMembers((await membersRes.json()).members)
    if (aiRes.ok) {
      const data = await aiRes.json()
      setAiMembers(data.aiMembers)
    }
    if (wsRes.ok) {
      const data = await wsRes.json()
      setWorkspaceMembers(data.members || [])
      setViewer({ role: data.currentRole ?? null, memberId: data.currentMemberId ?? null })
    }
    if (statesRes.ok) {
      const states: WorkflowState[] = (await statesRes.json()).states || []
      setWorkflowStates(states)
      savedSortOrderRef.current = new Map(states.map((s) => [s.id, s.sort_order]))
    }
    if (flowsRes.ok) {
      const flows = ((await flowsRes.json()).flows || []) as Array<{
        id: string; name: string; enabled: boolean; trigger_type: string
        trigger_config: { to_status_id?: string } | null
      }>
      const map = new Map<string, FlowRef[]>()
      for (const f of flows) {
        if (!f.enabled || f.trigger_type !== 'entity_status_change') continue
        const statusId = f.trigger_config?.to_status_id
        if (!statusId) continue
        const list = map.get(statusId)
        if (list) list.push({ id: f.id, name: f.name })
        else map.set(statusId, [{ id: f.id, name: f.name }])
      }
      setFlowsByStatus(map)
    }
  }, [teamId])

  useEffect(() => {
    // fetch-on-mount + loading flag; setState lands after the fetch resolves.
    fetchAll().finally(() => setLoading(false))
  }, [fetchAll])

  // Reflect remote changes to this team's settings — workflow states, team
  // fields, and membership (team_member events arrive as kind 'team' from the
  // realtime core; workspace members arrive as 'member') — without a manual
  // reload. Debounced generously since fetchAll fans out six requests.
  //
  // This panel both emits and list-syncs 'workflow_state' and 'team', so skip
  // events THIS tab just originated — otherwise a workflow-state edit or a team
  // autosave would re-trigger fetchAll and clobber whatever the user is still
  // typing (useEntityListSync, unlike useEntityDetailSync, has no self-echo
  // skip of its own).
  useEntityListSync(['workflow_state', 'team', 'member'], fetchAll, {
    debounceMs: 500,
    match: (d) => !(d.id && wasRecentlyMutatedLocally(d.entityType, d.id)),
  })

  async function handleSave() {
    // Clear the pending-autosave marker up front so a background fetchAll can
    // reconcile the editable fields again once this save has flushed. (The
    // fetchAll guard reads saveTimeoutRef.current === null.)
    saveTimeoutRef.current = null
    if (!team) return
    const updates: Record<string, unknown> = {}
    if (name.trim() && name !== team.name) updates.name = name.trim()
    if (issuePrefix.trim() && issuePrefix !== team.issue_prefix) updates.issue_prefix = issuePrefix.trim()
    if (isPrivate !== team.is_private) updates.is_private = isPrivate
    if (Object.keys(updates).length === 0) return
    const res = await fetch(`/api/account/teams/${teamId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (res.ok) {
      setTeam((await res.json()).team)
      // Arm self-echo suppression + fan the change out to other surfaces. Also
      // stops our own list-sync (below) from re-triggering fetchAll while the
      // user may still be typing into another field.
      emitEntityUpdated({ entityType: 'team', id: teamId, fields: updates })
      refetchTeams()
    }
  }
  // The autosave is scheduled from the onChange handler, right after the
  // setState call, so that render's handleSave still sees the pre-edit
  // name/prefix/private values. Run the latest render's handleSave instead.
  const handleSaveRef = useRef(handleSave)
  useEffect(() => { handleSaveRef.current = handleSave })
  function scheduleAutoSave() {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => { void handleSaveRef.current() }, 800)
  }

  async function handleAddWorkflowState() {
    if (!newStateName.trim() || addingState) return
    setAddingState(true)
    setStateError('')
    const maxSort = workflowStates.reduce((max, s) => Math.max(max, s.sort_order), -1)
    const res = await fetch('/api/account/workflow-states', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: teamId, name: newStateName.trim(), category: newStateCategory, color: '#3b82f6', sort_order: maxSort + 1 }),
    })
    if (res.ok) {
      const data = await res.json()
      setWorkflowStates((prev) => [...prev, data.state])
      savedSortOrderRef.current.set(data.state.id, data.state.sort_order)
      setNewStateName('')
      // Let other surfaces (board columns, list-view status pickers, flow
      // triggers) react to the new state.
      emitEntityCreated({ entityType: 'workflow_state', id: data.state.id })
    } else {
      setStateError((await res.json()).error || 'Failed to create state')
    }
    setAddingState(false)
  }

  async function handleUpdateWorkflowState(stateId: string, updates: Record<string, unknown>) {
    setStateError('')
    const res = await fetch(`/api/account/workflow-states/${stateId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (res.ok) {
      const data = await res.json()
      setWorkflowStates((prev) => prev.map((s) => {
        if (s.id === stateId) return data.state
        if (updates.is_default === true && s.is_default) return { ...s, is_default: false }
        return s
      }))
      // Broadcast the change so pickers/board columns pick up the rename,
      // recolor, or default-state switch without a manual reload.
      emitEntityUpdated({ entityType: 'workflow_state', id: stateId, fields: data.state })
    } else {
      setStateError((await res.json()).error || 'Failed to update state')
    }
  }

  async function handleDeleteWorkflowState(stateId: string) {
    const res = await fetch(`/api/account/workflow-states/${stateId}`, { method: 'DELETE' })
    if (res.ok) {
      setWorkflowStates((prev) => prev.filter((s) => s.id !== stateId))
      emitEntityDeleted({ entityType: 'workflow_state', id: stateId })
    } else setStateError((await res.json()).error || 'Failed to delete state')
  }

  function handleReorderStates(dragIndex: number, hoverIndex: number) {
    setWorkflowStates((prev) => {
      const sorted = [...prev].sort((a, b) => a.sort_order - b.sort_order)
      const [moved] = sorted.splice(dragIndex, 1)
      sorted.splice(hoverIndex, 0, moved)
      return sorted.map((s, i) => ({ ...s, sort_order: i }))
    })
  }
  function persistStateOrder() {
    const updates = workflowStates
      .map((s) => ({ id: s.id, sort_order: s.sort_order }))
      .filter(({ id, sort_order }) => savedSortOrderRef.current.get(id) !== sort_order)
    if (updates.length === 0) return
    fetch('/api/account/workflow-states/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    }).then((res) => {
      if (!res.ok) throw new Error('reorder failed')
      updates.forEach(({ id, sort_order }) => {
        savedSortOrderRef.current.set(id, sort_order)
        emitEntityUpdated({ entityType: 'workflow_state', id, fields: { sort_order } })
      })
    }).catch(() => {
      setStateError('Failed to reorder states')
      void fetchAll()
    })
  }

  async function handleAddMember() {
    if (!addMemberId || adding) return
    setAdding(true)
    const res = await fetch(`/api/account/teams/${teamId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_id: addMemberId }),
    })
    if (res.ok) {
      setAddMemberId('')
      const membersRes = await fetch(`/api/account/teams/${teamId}/members`)
      if (membersRes.ok) setMembers((await membersRes.json()).members)
      refetchTeams()
    }
    setAdding(false)
  }

  async function handleChangeRole(teamMemberId: string, newRole: string) {
    const res = await fetch(`/api/account/teams/${teamId}/members/${teamMemberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_role: newRole }),
    })
    if (res.ok) {
      setMembers((prev) => prev.map((m) => m.team_member_id === teamMemberId ? { ...m, team_role: newRole } : m))
    }
  }

  async function handleRemoveMember(teamMemberId: string) {
    const res = await fetch(`/api/account/teams/${teamId}/members/${teamMemberId}`, { method: 'DELETE' })
    if (res.ok) {
      setMembers((prev) => prev.filter((m) => m.team_member_id !== teamMemberId))
      refetchTeams()
    }
  }

  async function handleRemoveAiMember(aiMemberId: string) {
    const res = await fetch(`/api/account/teams/${teamId}/ai-members/${aiMemberId}`, { method: 'DELETE' })
    if (res.ok) {
      setAiMembers((prev) => prev.filter((m) => m.id !== aiMemberId))
      refetchTeams()
    }
    setDeleteAiTarget(null)
  }

  // Workspace owners and admins, and this team's leads, may edit and remove its
  // AI teammates (ai_team_member's RLS). Others don't see the menu; the routes
  // still decide (403).
  const canManageAi =
    viewer.role === 'owner' ||
    viewer.role === 'admin' ||
    (!!viewer.memberId && members.some((m) => m.member_id === viewer.memberId && m.team_role === 'lead'))

  const availableMembers = workspaceMembers.filter(
    (wm) => !members.some((tm) => tm.member_id === wm.id),
  )

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader title="Teams" />
        <div className="mx-auto w-full max-w-2xl space-y-8 p-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    )
  }

  if (!team) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader title="Teams" />
        <div className="mx-auto max-w-2xl p-6">
          <p className="text-sm text-muted-foreground">Team not found.</p>
          <button onClick={onBack} className="mt-2 text-sm underline">Back to teams</button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        history="custom"
        title={
          <nav className="flex items-center gap-1.5 text-sm" aria-label="Breadcrumb">
            {cameFromBoard ? (
              <PageTitle label={`${team.name} board`} iconName="Team" onClick={() => onOpenBoard(team.id, team.name)} />
            ) : (
              <PageTitle label="Teams" onClick={onBack} />
            )}
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
            <span className="font-semibold text-foreground">Settings</span>
          </nav>
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => onOpenBoard(team.id, team.name)}>
            <LayoutGrid className="mr-1 h-3.5 w-3.5" />
            Open board
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-8 p-6">
          {/* Header */}
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">{team.name}</h1>
            <Badge variant="outline" className="text-[10px]">{team.issue_prefix}</Badge>
          </div>

          <Separator />

          {/* General */}
          <div className="space-y-4">
            <h2 className="text-sm font-medium">General</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="team-name" className="text-xs">Name</Label>
                <Input id="team-name" value={name} onChange={(e) => { setName(e.target.value); scheduleAutoSave() }} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="team-prefix" className="text-xs">Issue prefix</Label>
                <Input
                  id="team-prefix"
                  value={issuePrefix}
                  maxLength={5}
                  onChange={(e) => { setIssuePrefix(e.target.value.toUpperCase()); scheduleAutoSave() }}
                  className="uppercase"
                />
              </div>
            </div>
            <div className="flex items-center justify-between pt-2">
              <div className="space-y-0.5">
                <Label className="flex items-center gap-1.5 text-xs">
                  <Lock className="h-3 w-3" />
                  Private team
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Only team members can see this team and its content
                </p>
              </div>
              <Switch checked={isPrivate} onCheckedChange={(c) => { setIsPrivate(c); scheduleAutoSave() }} />
            </div>
          </div>

          <Separator />

          {/* Workflow states */}
          <div className="space-y-4">
            <h2 className="text-sm font-medium">Workflow</h2>
            {stateError && <p className="text-xs text-red-500">{stateError}</p>}
            <DndProvider backend={HTML5Backend}>
              <div className="space-y-2">
                {[...workflowStates].sort((a, b) => a.sort_order - b.sort_order).map((state, index) => (
                  <WorkflowStateRow
                    key={state.id}
                    state={state}
                    index={index}
                    flows={flowsByStatus.get(state.id) ?? []}
                    onReorder={handleReorderStates}
                    onPersist={persistStateOrder}
                    onUpdate={handleUpdateWorkflowState}
                    onDelete={handleDeleteWorkflowState}
                  />
                ))}
              </div>
            </DndProvider>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label className="text-xs">New state</Label>
                <Input
                  value={newStateName}
                  onChange={(e) => setNewStateName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddWorkflowState() }}
                  placeholder="State name..."
                  className="h-8 text-xs"
                />
              </div>
              <Select value={newStateCategory} onValueChange={setNewStateCategory}>
                <SelectTrigger className="h-8 w-[120px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((cat) => (
                    <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" className="h-8" disabled={!newStateName.trim() || addingState} onClick={handleAddWorkflowState}>
                {addingState ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              </Button>
            </div>
          </div>

          <Separator />

          {/* Members (humans + AI in one list) */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">
                Members ({members.length + aiMembers.length})
              </h2>
              <Button size="sm" variant="outline" onClick={() => setShowAiDialog(true)}>
                <Boxes className="mr-1 h-3.5 w-3.5" />
                Add AI member
              </Button>
            </div>

            {/* Add human member */}
            {availableMembers.length > 0 && (
              <div className="flex items-end gap-3">
                <div className="flex-1 space-y-1.5">
                  <Label className="text-xs">Add a workspace member</Label>
                  <Select value={addMemberId} onValueChange={setAddMemberId}>
                    <SelectTrigger><SelectValue placeholder="Select a member..." /></SelectTrigger>
                    <SelectContent>
                      {availableMembers.map((m) => (
                        <SelectItem key={m.id} value={m.id}>{m.display_name} ({m.email})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button size="sm" disabled={!addMemberId || adding} onClick={handleAddMember}>
                  {adding ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Plus className="mr-1 h-3 w-3" />}
                  Add
                </Button>
              </div>
            )}

            {members.length === 0 && aiMembers.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No members in this team.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead className="w-[60px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* Human members */}
                  {members.map((m) => (
                    <TableRow key={m.team_member_id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-7 w-7">
                            <AvatarImage src={m.avatar_url || undefined} />
                            <AvatarFallback className="text-[10px]">{getInitials(m.display_name || '?')}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{m.display_name}</p>
                            <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={m.team_role === 'lead' ? 'secondary' : 'outline'} className="gap-1 text-xs">
                          {m.team_role === 'lead' && <Crown className="h-3 w-3" />}
                          {m.team_role === 'lead' ? 'Lead' : 'Member'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {m.team_role === 'member' ? (
                              <DropdownMenuItem onClick={() => handleChangeRole(m.team_member_id, 'lead')}>
                                <Crown className="mr-2 h-3.5 w-3.5" /> Make lead
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={() => handleChangeRole(m.team_member_id, 'member')}>
                                <Shield className="mr-2 h-3.5 w-3.5" /> Make member
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem className="text-destructive" onClick={() => handleRemoveMember(m.team_member_id)}>
                              <UserMinus className="mr-2 h-3.5 w-3.5" /> Remove from team
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}

                  {/* AI members — user-built first, then the built-in loops' */}
                  {rosterOrder(aiMembers).map((m) => (
                    <TableRow key={m.id} data-system-teammate={m.is_system ? m.system_key ?? '' : undefined}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                            <AgentIcon />
                          </span>
                          <div className="min-w-0">
                            {/* div, not p — it holds a Badge (which renders a
                                div), and <div> can't be a descendant of <p>. */}
                            <div className="flex items-center gap-1.5 truncate text-sm font-medium">
                              {m.name}
                              {m.is_system ? (
                                <Badge className="h-4 gap-0.5 px-1 text-[9px]" variant="outline">
                                  <Cog className="h-2.5 w-2.5" /> System
                                </Badge>
                              ) : (
                                <Badge className="h-4 gap-0.5 px-1 text-[9px]" variant="secondary">
                                  <Boxes className="h-2.5 w-2.5" /> AI
                                </Badge>
                              )}
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {m.is_system ? (
                                (m.system_key && SYSTEM_TEAMMATE_BLURBS[m.system_key as SystemTeammateKey]) || 'Built-in loop'
                              ) : (
                                <>
                                  {m.agent?.name || (m.agent_recipe_id ? 'Private persona' : 'Agent')}
                                  {skillCount(m) > 0 && ` · ${skillCount(m)} skill${skillCount(m) === 1 ? '' : 's'}`}
                                </>
                              )}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={m.team_role === 'lead' ? 'secondary' : 'outline'} className="gap-1 text-xs">
                          {m.team_role === 'lead' && <Crown className="h-3 w-3" />}
                          {m.team_role === 'lead' ? 'Lead' : 'Member'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {canManageAi && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label={`${m.name} options`}>
                                <MoreHorizontal className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setEditAiTarget(m)}>
                                <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
                              </DropdownMenuItem>
                              {/* A system teammate is the attribution for a built-in loop: not removable. */}
                              {!m.is_system && (
                                <DropdownMenuItem className="text-destructive" onClick={() => setDeleteAiTarget(m)}>
                                  <Trash2 className="mr-2 h-3.5 w-3.5" /> Remove from team
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      </div>

      {/* Add AI member dialog */}
      {showAiDialog && (
        <AiTeammateDialog
          teamId={teamId}
          onClose={() => setShowAiDialog(false)}
          onSaved={() => { setShowAiDialog(false); fetchAll(); refetchTeams() }}
        />
      )}

      {/* Edit AI teammate dialog: name, persona, skills */}
      {editAiTarget && (
        <AiTeammateDialog
          key={editAiTarget.id}
          teamId={teamId}
          member={editAiTarget}
          onClose={() => setEditAiTarget(null)}
          onSaved={() => { setEditAiTarget(null); fetchAll() }}
        />
      )}

      {/* Remove AI member confirm */}
      <AlertDialog open={!!deleteAiTarget} onOpenChange={() => setDeleteAiTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove AI team member</AlertDialogTitle>
            <AlertDialogDescription>
              Remove &ldquo;{deleteAiTarget?.name}&rdquo; from this team? The underlying agent and skills are not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteAiTarget && handleRemoveAiMember(deleteAiTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
