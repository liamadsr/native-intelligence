'use client'

/**
 * Full-screen n8n-style canvas editor for a single flow.
 *
 * Model: one trigger (status change, schedule, or capture processed) → an
 * ORDERED list of N actions (HTTP request | run skill), each with an optional
 * condition. The canvas renders the Trigger node wired to a vertical fan-out
 * of Action nodes (one edge trigger → each action). Clicking a node opens its
 * config in the right-side panel; "+ Add action" appends a new action node.
 *
 * Save POSTs/PATCHes /api/account/flows, Test fires /:id/fire, and run history
 * reads /:id/runs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import {
  Archive,
  Laptop,
  Plug,
  Boxes,
  ChevronDown,
  ChevronUp,
  Filter,
  Globe,
  History,
  Loader2,
  Minus,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react'
import { useEditorConnections } from './use-editor-connections'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { EntityDetailHeader } from '@/components/views/entity-detail-header'
import { useIsWindowFocused } from '@/components/views/tab-active'
import { cn } from '@/lib/utils'
import { emitEntityUpdated, emitEntityDeleted, emitEntityCreated } from '@/lib/entity-events'
import { ListenBrief } from '@/components/read-aloud/listen-brief'
import { plainLine } from '@/lib/read-aloud/listen-briefs'
import { FlowConfigPanel } from './flow-config-panel'
import { FlowBotChip } from './flow-bot-picker'
import { FlowRunHistory } from './flow-run-history'
import { useResizable } from './use-resizable'
import {
  type CanvasLayout,
  type EditorAction,
  type EditorState,
  type Label,
  type Member,
  type Project,
  type SelectedNode,
  type SkillOption,
  type AgentOption,
  type Team,
  type WorkflowState,
  type Flow,
  type FlowBotOptions,
  editorSkillIds,
  emptyEditor,
  isReadOnlyFlow,
  describeSchedule,
  ANY_CHANNEL,
  PR_STATE_LABELS,
  ENTITY_LABELS,
  isActionComplete,
  newAction,
  buildSavePayload,
  flowToEditor,
  savedOnceOf,
  HIDDEN_CHANNEL,
} from './flow-types'

interface FlowCanvasEditorProps {
  /** Flow id to edit, or null to create a new flow. */
  flowId: string | null
  /** A run to land on (a notification deep link): the editor opens with Run
   *  history expanded and that run's row highlighted. */
  initialRunId?: string | null
  onClose: () => void
  /** Called after a successful create/update/delete so the list can refresh. */
  onSaved: () => void
}

export function FlowCanvasEditor({ flowId, initialRunId = null, onClose, onSaved }: FlowCanvasEditorProps) {
  const [editor, setEditor] = useState<EditorState | null>(null)
  // The latest editor state, for the listen brief's fallback line.
  const editorRef = useRef(editor)
  editorRef.current = editor
  const [teams, setTeams] = useState<Team[]>([])
  const [statesByTeam, setStatesByTeam] = useState<Record<string, WorkflowState[]>>({})
  const [labels, setLabels] = useState<Label[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [skills, setSkills] = useState<SkillOption[]>([])
  const [agents, setAgents] = useState<AgentOption[]>([])
  // "Its agent" (bots-v3 Phase 3): what the picker offers, and the default it
  // suggests for a new loop from the loop's skills.
  const [botOptions, setBotOptions] = useState<FlowBotOptions | null>(null)
  const [botOptionsLoading, setBotOptionsLoading] = useState(false)
  const [botOptionsVersion, setBotOptionsVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<SelectedNode>(flowId ? null : { kind: 'trigger' })
  const [saving, setSaving] = useState(false)
  const [firing, setFiring] = useState(false)
  // Run-history drawer. `runsToggle` is the user's explicit choice; null means
  // "follow the deep link" — open when the editor was asked to land on a run.
  // A NEW deep link arriving while mounted (a second notification for the same
  // flow) resets the choice so the drawer reopens: derived-state-from-props,
  // not an effect.
  const [runsToggle, setRunsToggle] = useState<boolean | null>(null)
  const [seenRunId, setSeenRunId] = useState<string | null>(initialRunId)
  if (initialRunId !== seenRunId) {
    setSeenRunId(initialRunId)
    setRunsToggle(null)
  }
  const showRuns = runsToggle ?? initialRunId !== null
  const [zoom, setZoom] = useState(1)

  const ZOOM_MIN = 0.4
  const ZOOM_MAX = 2
  const zoomBy = useCallback(
    (delta: number) => setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(z + delta).toFixed(3)))),
    [],
  )
  const resetZoom = useCallback(() => setZoom(1), [])

  // Resizable run-history drawer (vertical) and config side panel (horizontal),
  // each persisted to localStorage so the chosen size sticks across sessions.
  const runsResize = useResizable({
    storageKey: 'ni:flow-canvas:runs-height',
    defaultSize: 260,
    min: 120,
    max: 600,
    axis: 'y-top',
  })
  const panelResize = useResizable({
    storageKey: 'ni:flow-canvas:panel-width',
    defaultSize: 360,
    min: 300,
    max: 600,
    axis: 'x-left',
  })

  // The data-load effect below must run ONLY when the flow id changes — not when
  // onClose's identity changes. FlowsView passes an inline onClose, so it's a
  // fresh reference on every render; a tab switch re-renders FlowsView (the tab
  // shell re-renders all tabs when activeTabId changes), which would otherwise
  // re-fire the loader, reset `loading` to true, and flash the spinner + reload
  // the flow. Route onClose through a ref so the effect can call the latest one
  // without depending on it.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // ── Data loading ──
  const loadStatesForTeam = useCallback(
    async (teamId: string) => {
      if (!teamId) return
      setStatesByTeam((prev) => {
        if (prev[teamId]) return prev
        return prev
      })
      const res = await fetch(`/api/account/workflow-states?team_id=${teamId}`)
      if (!res.ok) return
      const { states } = await res.json()
      setStatesByTeam((prev) => ({ ...prev, [teamId]: states || [] }))
    },
    [],
  )

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      // Load picker context for the condition builder in parallel with teams.
      // Skills (workspace + system) feed the run_skill action's skill picker,
      // and agents (category 'agent') feed the run_agent action's agent picker —
      // same endpoints the Agents & Skills library uses.
      const [teamsRes, labelsRes, membersRes, projectsRes, skillsRes, agentsRes] =
        await Promise.all([
          fetch('/api/account/teams').then((r) => (r.ok ? r.json() : { teams: [] })).catch(() => ({ teams: [] })),
          fetch('/api/account/labels?scope=action').then((r) => (r.ok ? r.json() : { labels: [] })).catch(() => ({ labels: [] })),
          fetch('/api/account/workspace/members').then((r) => (r.ok ? r.json() : { members: [] })).catch(() => ({ members: [] })),
          fetch('/api/account/projects').then((r) => (r.ok ? r.json() : { projects: [] })).catch(() => ({ projects: [] })),
          // ?for=flows: the lens skills too (F3), which only run as a call loop's skill.
          fetch('/api/account/skills?for=flows').then((r) => (r.ok ? r.json() : { skills: [] })).catch(() => ({ skills: [] })),
          fetch('/api/account/agents').then((r) => (r.ok ? r.json() : { agents: [] })).catch(() => ({ agents: [] })),
        ])
      const loadedTeams: Team[] = teamsRes.teams || []
      if (!cancelled) {
        setLabels(labelsRes.labels || [])
        setMembers(membersRes.members || [])
        setProjects(projectsRes.projects || [])
        setSkills(skillsRes.skills || [])
        setAgents(agentsRes.agents || [])
      }

      if (flowId) {
        const res = await fetch(`/api/account/flows/${flowId}`)
        if (!res.ok) {
          if (!cancelled) {
            toast.error('Failed to load flow')
            onCloseRef.current()
          }
          return
        }
        const { flow } = (await res.json()) as { flow: Flow }
        if (cancelled) return
        setTeams(loadedTeams)
        setEditor(flowToEditor(flow))
      } else {
        if (cancelled) return
        setTeams(loadedTeams)
        setEditor({ ...emptyEditor(), team_id: loadedTeams[0]?.id ?? '' })
      }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
    // Intentionally depends ONLY on flowId — onClose is read via onCloseRef so a
    // new onClose reference (e.g. from a tab-switch re-render) doesn't reload the
    // flow and flash the spinner.
  }, [flowId])

  // The bot options, refetched when the loop's skills change: a new loop's
  // default follows them (the skill's holder, else Triage for a verdict skill,
  // else a free face) until the person picks one; a saved loop keeps its own.
  const skillKey = editor ? editorSkillIds(editor).join(',') : null
  useEffect(() => {
    if (skillKey === null) return
    let cancelled = false
    setBotOptionsLoading(true)
    fetch(`/api/account/flows/bots?skill_ids=${encodeURIComponent(skillKey)}`)
      .then((r) => (r.ok ? (r.json() as Promise<FlowBotOptions>) : null))
      .then((opts) => {
        if (cancelled || !opts) return
        setBotOptions(opts)
        const suggested = opts.suggested
        if (!suggested) return
        setEditor((prev) => {
          if (!prev || prev.id || prev.botDirty) return prev
          return {
            ...prev,
            bot:
              suggested.kind === 'teammate'
                ? { kind: 'teammate', id: suggested.teammateId }
                : { kind: 'new', name: '' },
          }
        })
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setBotOptionsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [skillKey, botOptionsVersion])

  // Fetch workflow states whenever the editor's team changes (action triggers).
  useEffect(() => {
    if (editor?.team_id) loadStatesForTeam(editor.team_id)
  }, [editor?.team_id, loadStatesForTeam])

  // Esc closes the overlay (when no config panel intercepts it). Only the
  // canvas in focus answers: a canvas in a chat card full screen and one in
  // a Flows window under it would otherwise both close on one Esc.
  const isFocused = useIsWindowFocused()
  const isFocusedRef = useRef(isFocused)
  isFocusedRef.current = isFocused
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isFocusedRef.current) return
      if (e.key === 'Escape') {
        if (selected) setSelected(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, onClose])

  const states = editor ? statesByTeam[editor.team_id] ?? [] : []

  // ── Action CRUD ──
  // Add a child of `parentId` (null = a root action that chains off the
  // trigger). Any node — the trigger or an action — can spawn a child, so the
  // actions form a tree.
  const addAction = useCallback((parentId: string | null) => {
    const action = newAction(parentId)
    setEditor((prev) => (prev ? { ...prev, actions: [...prev.actions, action] } : prev))
    setSelected({ kind: 'action', id: action.id })
  }, [])

  const updateAction = useCallback((id: string, patch: Partial<EditorAction>) => {
    setEditor((prev) =>
      prev
        ? { ...prev, actions: prev.actions.map((a) => (a.id === id ? { ...a, ...patch } : a)) }
        : prev,
    )
  }, [])

  // Remove an action. Its children are re-parented onto the removed node's own
  // parent so a mid-tree delete doesn't silently drop a whole branch.
  const removeAction = useCallback((id: string) => {
    setEditor((prev) => {
      if (!prev) return prev
      if (prev.actions.length <= 1) {
        toast.error('A flow needs at least one action')
        return prev
      }
      const removed = prev.actions.find((a) => a.id === id)
      const newParent = removed?.parent_id ?? null
      const actions = prev.actions
        .filter((a) => a.id !== id)
        .map((a) => (a.parent_id === id ? { ...a, parent_id: newParent } : a))
      return { ...prev, actions }
    })
    setSelected((cur) => (cur && cur.kind === 'action' && cur.id === id ? null : cur))
  }, [])

  // ── Save / delete / test ──
  const handleSave = useCallback(async () => {
    if (!editor) return
    const built = buildSavePayload(editor)
    if ('error' in built) {
      toast.error(built.error)
      // Open the panel that owns the missing field.
      if (built.bot) {
        setSelected({ kind: 'bot' })
      } else if (typeof built.actionIndex === 'number' && editor.actions[built.actionIndex]) {
        setSelected({ kind: 'action', id: editor.actions[built.actionIndex].id })
      } else if (
        built.error.includes('status') ||
        built.error.includes('Team') ||
        built.error.includes('Schedule') ||
        built.error.includes('Timezone')
      ) {
        setSelected({ kind: 'trigger' })
      }
      return
    }
    setSaving(true)
    try {
      const url = editor.id ? `/api/account/flows/${editor.id}` : '/api/account/flows'
      const method = editor.id ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Save failed')
      }
      const { flow, awaiting_owner: awaitingOwner } = (await res.json()) as { flow: Flow; awaiting_owner?: string | null }
      const wasCreate = !editor.id
      // A risky loop someone else owns switches on only from its owner's card (F1).
      if (awaitingOwner) toast.success(`Saved. ${awaitingOwner} has a card to switch it on`)
      else toast.success(wasCreate ? 'Flow created' : 'Flow saved')
      if (wasCreate) {
        // Tell the views list to refetch so the new row appears.
        window.dispatchEvent(new CustomEvent('ni:entity-created', { detail: { entityType: 'flow', id: flow.id } }))
      } else {
        // Patch the existing row in place (name/enabled may have changed).
        emitEntityUpdated({
          entityType: 'flow',
          id: flow.id,
          fields: { enabled: flow.enabled, name: flow.name, ai_team_member_id: flow.ai_team_member_id ?? null, bot: flow.bot ?? null },
        })
      }
      // Refresh the ⚡ status indicators across board/list/team-settings — the
      // trigger status or enabled flag may have changed.
      window.dispatchEvent(new CustomEvent('ni:flows-changed'))
      onSaved()
      // After creating, keep the editor open but switch to edit mode so Test
      // fire + run history become available. (flowToEditor is statically
      // imported — no dynamic import() here, which could hang the save promise
      // on a stalled chunk fetch and leave the button spinning forever.)
      if (wasCreate) {
        setEditor(flowToEditor(flow))
      } else {
        // The saved bot: a work bot made on save now has an id, and a second
        // save must not make another.
        setEditor((prev) =>
          prev
            ? {
                ...prev,
                // The saved state: off while it waits on the owner's card, a
                // one-time loop on again after a new time, off after its time.
                enabled: flow.enabled,
                savedOnce: savedOnceOf(flow),
                bot: flow.ai_team_member_id ? { kind: 'teammate', id: flow.ai_team_member_id } : null,
                botDirty: false,
                botSummary: flow.bot ?? null,
              }
            : prev,
        )
      }
      // A bot made on save joins the picker's list.
      setBotOptionsVersion((v) => v + 1)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [editor, onSaved])

  // F1: someone else's loop. Its trigger and steps are read-only; "Take over
  // this flow" asks its owner for it (their card), then reads "Requested".
  const readOnly = editor ? isReadOnlyFlow(editor) : false
  const [requesting, setRequesting] = useState(false)
  const handleTakeover = useCallback(async () => {
    if (!editor?.id) return
    setRequesting(true)
    try {
      const res = await fetch(`/api/account/flows/${editor.id}/takeover`, { method: 'POST' })
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
      if (!res.ok) throw new Error(body.error || 'Could not ask for this flow')
      setEditor((prev) => (prev && prev.ownedBy ? { ...prev, ownedBy: { ...prev.ownedBy, requested: true } } : prev))
      toast.success(`Asked ${editor.ownedBy?.name ?? 'the owner'} to hand this flow to you`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not ask for this flow')
    } finally {
      setRequesting(false)
    }
  }, [editor])

  const handleDelete = useCallback(async () => {
    if (!editor?.id) {
      onClose()
      return
    }
    if (!confirm(`Delete "${editor.name || 'this flow'}"? Run history will also be deleted.`)) return
    const res = await fetch(`/api/account/flows/${editor.id}`, { method: 'DELETE' })
    if (!res.ok) {
      toast.error('Delete failed')
      return
    }
    toast.success('Flow deleted')
    emitEntityDeleted({ entityType: 'flow', id: editor.id })
    window.dispatchEvent(new CustomEvent('ni:flows-changed'))
    onSaved()
    onClose()
  }, [editor, onClose, onSaved])

  const handleTestFire = useCallback(async () => {
    if (!editor?.id) {
      toast.error('Save the flow first to test fire')
      return
    }
    setFiring(true)
    try {
      const res = await fetch(`/api/account/flows/${editor.id}/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json) {
        toast.error(json?.error || 'Test fire failed')
        return
      }
      const r = json.result as {
        status: string
        action_results: Array<{ skipped: boolean; status: string; response_status_code: number | null; error_message: string | null }>
      }
      const fired = r.action_results.filter((a) => !a.skipped)
      const skipped = r.action_results.length - fired.length
      const skipNote = skipped > 0 ? `, ${skipped} skipped` : ''
      if (r.status === 'success') {
        toast.success(`Test fired — ${fired.length} action${fired.length === 1 ? '' : 's'} sent${skipNote}`)
      } else {
        const firstErr = fired.find((a) => a.status === 'failed')
        toast.error(`Failed: ${firstErr?.error_message || `HTTP ${firstErr?.response_status_code ?? '?'}`}`)
      }
      setRunsToggle(true)
      // Nudge the run-history list to reload immediately rather than waiting on
      // the flow_run realtime round-trip. FlowRunHistory listens for flow_run
      // events scoped to this flow.
      emitEntityCreated({ entityType: 'flow_run', id: editor.id })
    } finally {
      setFiring(false)
    }
  }, [editor])

  // ── Persist node positions ──
  // Called on drag end. Holds the latest layout in editor state (so an
  // unsaved flow keeps it for Create) and, for an already-saved flow,
  // debounce-PATCHes canvas_layout. UI-only — never touches trigger/action.
  const layoutSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingLayoutSave = useRef<{ id: string; layout: CanvasLayout } | null>(null)
  const flowIdRef = useRef<string | null>(null)
  flowIdRef.current = editor?.id ?? null

  const persistLayout = useCallback((layout: CanvasLayout) => {
    // Keep the latest layout in editor state so an unsaved flow carries it into
    // Create (via buildSavePayload).
    setEditor((prev) => (prev ? { ...prev, canvas_layout: layout } : prev))
    // For an already-saved flow, debounce-PATCH the new positions.
    const id = flowIdRef.current
    if (!id) return
    if (layoutSaveTimer.current) clearTimeout(layoutSaveTimer.current)
    pendingLayoutSave.current = { id, layout }
    layoutSaveTimer.current = setTimeout(() => {
      layoutSaveTimer.current = null
      sendPendingLayoutSave(pendingLayoutSave)
    }, 600)
  }, [])

  // Flush any pending layout save when the editor unmounts (closing within the
  // debounce window must not drop the drag). keepalive lets the PATCH outlive
  // the page if the unmount is a navigation.
  useEffect(() => {
    return () => {
      if (layoutSaveTimer.current) clearTimeout(layoutSaveTimer.current)
      sendPendingLayoutSave(pendingLayoutSave, { keepalive: true })
    }
  }, [])

  // ── Render ──
  // Listen mode: what this flow does, spoken as it opens (a saved flow only).
  // First in both the loading and the loaded editor, so it stays mounted
  // across the two.
  const listenBrief = flowId ? (
    <ListenBrief kind="flow" id={flowId} fallback={() => plainLine(editorRef.current?.name)} />
  ) : null

  if (loading || !editor) {
    return (
      // Opaque glass surface, NOT transparent: this overlay is a full-screen
      // editor that sits ON TOP of the still-mounted Flows list view in the same
      // content panel. A transparent fill lets that list (its header controls,
      // "No items" text) and the 70%-opaque panel wallpaper bleed straight
      // through — see the glass-layer note on the main render below.
      <div className="absolute inset-0 z-30 flex items-center justify-center">
        {listenBrief}
        <div className="pointer-events-none absolute inset-0 z-0 bg-background/95 backdrop-blur-md" />
        <ThinkingOrb state="shaping" size={20} theme="auto" />
      </div>
    )
  }

  return (
    // Full-screen editor overlaying the still-mounted Flows list in the same
    // content panel. It MUST fully occlude that list, so it paints its own
    // opaque glass surface rather than inheriting the panel's (which is only
    // ~70% opaque and lets the list + wallpaper show through).
    <div className="absolute inset-0 z-30 flex flex-col">
      {listenBrief}
      {/* Glass layer — the translucent bg + backdrop-blur live on a dedicated
          sibling PAINTED BEHIND the content (absolute inset-0 z-0), not on this
          flex container, so no composited descendant (the canvas / config panel)
          can break the backdrop-filter. Mirrors the content-panel glass in
          dashboard-shell.tsx. bg-background/95 is near-opaque so the list below
          is fully occluded while the surface still reads as glass. */}
      <div className="pointer-events-none absolute inset-0 z-0 bg-background/95 backdrop-blur-md" />
      {/* Top bar — the shared detail header (identical to the sequence
          detail's): [Flows › name (inline-editable)] [⋯] ···· [status pill]
          [actions]. Breadcrumb replaces the old bare ✕ (Esc still closes),
          the redundant entity icon is gone, and Delete moved into the ⋯ menu.
          Wrapped relative z-10 so it (and every editor control) layers ABOVE
          the z-0 glass sibling — without an explicit stacking context the
          glass, being positioned, would paint over these in-flow controls. */}
      <div className="relative z-10 shrink-0">
        {/* border-b is a deliberate per-page call: on this translucent glass
            overlay it is the only separator between the header row and the
            canvas, so it stays; sequence detail sits on an opaque page and is
            borderless (see EntityDetailHeader's docblock). */}
        <EntityDetailHeader
          className="border-b border-border"
          viewTitle="Flows"
          onBack={onClose}
          name={editor.name}
          onNameChange={(name) => setEditor({ ...editor, name })}
          namePlaceholder="Untitled flow"
          menuItems={
            editor.id ? (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={handleDelete}
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Delete flow
              </DropdownMenuItem>
            ) : undefined
          }
          statusPill={
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                checked={editor.enabled}
                onCheckedChange={(v) => setEditor({ ...editor, enabled: v })}
                className="data-[state=checked]:bg-emerald-500"
              />
              {editor.enabled ? 'Active' : 'Paused'}
            </label>
          }
          actions={
            <>
              <FlowBotChip editor={editor} options={botOptions} onOpen={() => setSelected({ kind: 'bot' })} />
              {editor.id && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5"
                  onClick={handleTestFire}
                  disabled={firing}
                >
                  {firing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  Test
                </Button>
              )}
              <Button size="sm" className="h-8 gap-1.5" onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {editor.id ? 'Save' : 'Create'}
              </Button>
            </>
          }
        />
      </div>

      {/* Body: canvas + config panel — relative z-10, above the z-0 glass. */}
      <div className="relative z-10 flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <FlowCanvas
              editor={editor}
              states={states}
              skills={skills}
              agents={agents}
              selected={selected}
              onSelect={setSelected}
              // Someone else's loop (F1): its steps are read-only here.
              onAddChild={readOnly ? undefined : addAction}
              onRemoveAction={readOnly ? undefined : removeAction}
              zoom={zoom}
              onZoomBy={zoomBy}
              initialLayout={editor.canvas_layout}
              onLayoutChange={persistLayout}
            />

            {/* Someone else's loop (F1): who owns it, and asking them for it.
                Floats top-left in the zoom controls' skin. */}
            {editor.ownedBy && (
              <div
                data-flow-owner-bar=""
                className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-border bg-card/95 py-1 pl-2.5 pr-1 text-xs shadow-sm backdrop-blur"
              >
                <span className="text-muted-foreground">
                  Owned by <span className="font-medium text-foreground">{editor.ownedBy.name}</span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  disabled={editor.ownedBy.requested || requesting}
                  onClick={handleTakeover}
                >
                  {requesting ? <Loader2 className="h-3 w-3 animate-spin" /> : editor.ownedBy.requested ? 'Requested' : 'Take over this flow'}
                </Button>
              </div>
            )}

            {/* Zoom controls — floating bottom-left of the canvas */}
            <div className="absolute bottom-3 left-3 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-card/95 p-0.5 shadow-sm backdrop-blur">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => zoomBy(-0.2)}
                disabled={zoom <= ZOOM_MIN}
                aria-label="Zoom out"
              >
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <button
                type="button"
                onClick={resetZoom}
                className="min-w-[44px] rounded px-1.5 py-1 text-center text-xs font-medium tabular-nums text-muted-foreground hover:text-foreground"
                title="Reset zoom"
              >
                {Math.round(zoom * 100)}%
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => zoomBy(0.2)}
                disabled={zoom >= ZOOM_MAX}
                aria-label="Zoom in"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Run-history drawer. When expanded it has a resizable pixel height
              (drag the top handle) and scrolls internally, with bottom padding
              so the last row clears the floating chat dock in the corner.

              This div is the resize hook's DOM target: useResizable writes the
              dragged height straight onto the handle's PARENT element, so the
              handle below must stay a direct child of the sized element. React
              only renders the committed (post-release) height. */}
          {editor.id && (
            <div
              className="relative flex shrink-0 flex-col border-t border-border bg-card"
              style={showRuns ? { height: `${runsResize.size}px` } : undefined}
            >
              {/* Top resize handle — only when expanded */}
              {showRuns && (
                <div
                  onPointerDown={runsResize.startResize}
                  className="group/handle absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize run history"
                >
                  <div className="mx-auto mt-[3px] h-0.5 w-10 rounded-full bg-border transition-colors group-hover/handle:bg-muted-foreground/50" />
                </div>
              )}
              <button
                type="button"
                onClick={() => setRunsToggle(!showRuns)}
                className="flex w-full shrink-0 items-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <History className="h-3.5 w-3.5" />
                Run history
                {showRuns ? (
                  <ChevronDown className="ml-auto h-3.5 w-3.5" />
                ) : (
                  <ChevronUp className="ml-auto h-3.5 w-3.5" />
                )}
              </button>
              {showRuns && (
                <div className="min-h-0 flex-1 overflow-y-auto border-t border-border pb-20">
                  <FlowRunHistory flowId={editor.id} highlightRunId={initialRunId} />
                </div>
              )}
            </div>
          )}
        </div>

        {selected && (
          <FlowConfigPanel
            selected={selected}
            editor={editor}
            setEditor={setEditor}
            updateAction={updateAction}
            removeAction={removeAction}
            readOnly={readOnly}
            teams={teams}
            states={states}
            labels={labels}
            members={members}
            projects={projects}
            skills={skills}
            agents={agents}
            botOptions={botOptions}
            botOptionsLoading={botOptionsLoading}
            onBotsChanged={() => setBotOptionsVersion((v) => v + 1)}
            onClose={() => setSelected(null)}
            /* Committed width only — during a drag useResizable writes the live
               width onto the panel root (the resize handle's parent) directly,
               so no render happens per frame. */
            width={panelResize.size}
            onResizeStart={panelResize.startResize}
          />
        )}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Canvas — two draggable nodes, animated connecting edge
// ──────────────────────────────────────────────────────────────

type NodeKey = string // 'trigger' | `action:${id}`
interface Pos {
  x: number
  y: number
}
interface Rect {
  x: number
  y: number
  w: number
  h: number
}
interface DragState {
  pointerId: number
  startClientX: number
  startClientY: number
  origin: Record<NodeKey, Pos>
  group: NodeKey[]
  moved: boolean
  key: NodeKey
}

const NODE_W = 240
const NODE_H = 88
const ACTION_GAP = 32 // vertical gap between stacked action nodes
const COL_GAP = 160 // horizontal gap between tree depth columns
const ROW_STEP = NODE_H + ACTION_GAP

const actionKey = (id: string): NodeKey => `action:${id}`

function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/**
 * Compute default positions for the whole tree by depth (column) × leaf order
 * (row). The trigger is column 0; each action sits one column right of its
 * parent. Rows are assigned by a depth-first leaf walk so siblings stack and
 * subtrees don't overlap. Only used to seed nodes without a saved position.
 */
function defaultTreeLayout(editor: EditorState): Record<NodeKey, Pos> {
  const childrenOf = new Map<string | null, string[]>()
  const ids = new Set(editor.actions.map((a) => a.id))
  for (const a of editor.actions) {
    const parent = a.parent_id && ids.has(a.parent_id) ? a.parent_id : null
    const list = childrenOf.get(parent) ?? []
    list.push(a.id)
    childrenOf.set(parent, list)
  }
  const pos: Record<NodeKey, Pos> = {}
  let nextRow = 0
  const baseX = 80
  const baseY = 80
  // Walk the action forest (roots = parent null), assigning each node a column
  // by depth and a row by visit order. Returns the row span midpoint so a
  // parent can be centred against its children.
  const place = (id: string, depth: number): number => {
    const kids = childrenOf.get(id) ?? []
    let rowForThis: number
    if (kids.length === 0) {
      rowForThis = nextRow
      nextRow += 1
    } else {
      const childRows = kids.map((k) => place(k, depth + 1))
      rowForThis = (childRows[0] + childRows[childRows.length - 1]) / 2
    }
    pos[actionKey(id)] = { x: baseX + (depth + 1) * (NODE_W + COL_GAP), y: baseY + rowForThis * ROW_STEP }
    return rowForThis
  }
  const roots = childrenOf.get(null) ?? []
  const rootRows = roots.map((r) => place(r, 0))
  const triggerRow = rootRows.length ? (rootRows[0] + rootRows[rootRows.length - 1]) / 2 : 0
  pos.trigger = { x: baseX, y: baseY + triggerRow * ROW_STEP }
  return pos
}

function FlowCanvas({
  editor,
  states,
  skills,
  agents,
  selected,
  onSelect,
  onAddChild,
  onRemoveAction,
  zoom,
  onZoomBy,
  initialLayout,
  onLayoutChange,
}: {
  editor: EditorState
  states: WorkflowState[]
  skills: SkillOption[]
  agents: AgentOption[]
  selected: SelectedNode
  onSelect: (n: SelectedNode) => void
  /** Absent: the steps are read-only (someone else's loop). */
  onAddChild?: (parentId: string | null) => void
  onRemoveAction?: (id: string) => void
  zoom: number
  onZoomBy: (delta: number) => void
  initialLayout: CanvasLayout
  onLayoutChange: (layout: CanvasLayout) => void
}) {
  // F4: a connected-app step names its app (fetched only when the loop has one).
  const connections = useEditorConnections(editor.actions.some((a) => a.type === 'call_tool'))
  const connectionNames = connections ? new Map(connections.map((c) => [c.id, c.display_name])) : null
  // The set of node keys present this render: trigger + one per action.
  const nodeKeys = useMemo<NodeKey[]>(
    () => ['trigger', ...editor.actions.map((a) => actionKey(a.id))],
    [editor.actions],
  )

  // Map action id -> its parent NodeKey ('trigger' for a root action). Used by
  // edge rendering. A dangling parent_id falls back to the trigger.
  const parentKeyOf = useMemo(() => {
    const ids = new Set(editor.actions.map((a) => a.id))
    const m = new Map<string, NodeKey>()
    for (const a of editor.actions) {
      m.set(a.id, a.parent_id && ids.has(a.parent_id) ? actionKey(a.parent_id) : 'trigger')
    }
    return m
  }, [editor.actions])

  // Node positions live in state so they can be dragged. Seed from the flow's
  // saved canvas_layout, falling back to a computed tree layout for any node
  // without a stored position.
  const seedPositions = useCallback((): Record<NodeKey, Pos> => {
    const defaults = defaultTreeLayout(editor)
    const out: Record<NodeKey, Pos> = {}
    out.trigger = initialLayout.trigger ?? defaults.trigger
    editor.actions.forEach((a) => {
      out[actionKey(a.id)] = initialLayout.actions?.[a.id] ?? defaults[actionKey(a.id)]
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [positions, setPositions] = useState<Record<NodeKey, Pos>>(seedPositions)

  // Reconcile positions when the action list changes (add/remove): keep known
  // keys, seed a fresh tree-layout default for new keys, drop removed keys.
  useEffect(() => {
    setPositions((prev) => {
      const defaults = defaultTreeLayout(editor)
      const next: Record<NodeKey, Pos> = {}
      next.trigger = prev.trigger ?? defaults.trigger
      editor.actions.forEach((a) => {
        const k = actionKey(a.id)
        next[k] = prev[k] ?? initialLayout.actions?.[a.id] ?? defaults[k]
      })
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeKeys.join('|')])

  // Mirror of `positions` in a ref so pointer-up can read the freshest values.
  const positionsRef = useRef(positions)
  useEffect(() => {
    positionsRef.current = positions
  }, [positions])

  const [moveSel, setMoveSel] = useState<Set<NodeKey>>(() => new Set())
  const [marquee, setMarquee] = useState<Rect | null>(null)

  /** Persist the full layout (trigger + all action keys) to the parent. */
  const emitLayout = useCallback(
    (p: Record<NodeKey, Pos>) => {
      const actions: Record<string, Pos> = {}
      for (const a of editor.actions) {
        const pos = p[actionKey(a.id)]
        if (pos) actions[a.id] = pos
      }
      onLayoutChange({ trigger: p.trigger, actions })
    },
    [editor.actions, onLayoutChange],
  )

  // Title + subtitle for the trigger node, per trigger kind.
  const triggerSummary = useMemo(() => {
    const t = editor.trigger
    if (t.kind === 'schedule') {
      return { title: 'Schedule', subtitle: describeSchedule(t) }
    }
    if (t.kind === 'capture_processed') {
      return { title: 'Capture processed', subtitle: 'After batch processing completes' }
    }
    if (t.kind === 'pr_status_changed') {
      return {
        title: 'Pull request',
        subtitle: t.repo_full_name ? `${PR_STATE_LABELS[t.pr_state]} in ${t.repo_full_name}` : 'Pick a repository',
      }
    }
    if (t.kind === 'email_received') {
      if (t.details_hidden) return { title: 'New email', subtitle: "In its owner's inbox" }
      return { title: 'New email', subtitle: t.email_from.trim() ? `From ${t.email_from.trim()}` : 'From anyone, in your inbox' }
    }
    if (t.kind === 'chat_message') {
      const where = t.chat_channel_id === ANY_CHANNEL ? 'any channel' : t.chat_channel_id === HIDDEN_CHANNEL ? 'a channel' : t.chat_channel_id ? 'its channel' : 'pick a channel'
      const who = t.details_hidden ? 'its owner is' : "you're"
      return { title: 'Chat message', subtitle: t.mentions_only ? `When ${who} @mentioned in ${where}` : `Every message in ${where}` }
    }
    if (t.kind === 'document_created') {
      return { title: 'New document', subtitle: 'When someone creates a document you can see' }
    }
    if (t.kind === 'calendar_event') {
      const mag = Math.abs(t.offset_minutes)
      const dir = t.offset_minutes > 0 ? 'after' : 'before'
      const when = mag === 0 ? 'at start of' : `${mag} min ${dir}`
      return {
        title: 'Calendar event',
        subtitle: t.event_title ? `${when} "${t.event_title}"` : 'Pick an event',
      }
    }
    const entityLabel = ENTITY_LABELS[t.entity_type]
    const from =
      t.from_status_id === '__any__' ? 'Any' : statusName(editor, states, t.from_status_id)
    const to = t.to_status_id ? statusName(editor, states, t.to_status_id) : 'Pick a status'
    return { title: `${entityLabel} status change`, subtitle: `${from} → ${to}` }
  }, [editor, states])

  // Content size grows with the furthest node so dragging outward reveals more
  // scrollable canvas.
  const allPos = Object.values(positions)
  const maxX = Math.max(NODE_W, ...allPos.map((p) => p.x + NODE_W))
  const maxY = Math.max(NODE_H, ...allPos.map((p) => p.y + NODE_H))
  const contentW = Math.max(maxX + 120, 900)
  const contentH = Math.max(maxY + 160, 480)

  // ── Drag a node (or the whole move-selection) ──────────────
  const dragRef = useRef<DragState | null>(null)

  const beginNodeDrag = useCallback(
    (key: NodeKey, e: React.PointerEvent, shiftKey: boolean) => {
      let group: NodeKey[]
      if (shiftKey) {
        setMoveSel((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
        group = []
      } else if (moveSel.has(key) && moveSel.size > 0) {
        // Drop keys of nodes deleted since they were selected: they have no
        // origin position, and moving them would throw mid-drag.
        group = Array.from(moveSel).filter((k) => k in positions)
      } else {
        group = [key]
      }
      dragRef.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        origin: { ...positions },
        group,
        moved: false,
        key,
      }
    },
    [moveSel, positions],
  )

  // ── Marquee select on empty canvas ─────────────────────────
  const marqueeRef = useRef<{ startX: number; startY: number } | null>(null)
  const contentLayerRef = useRef<HTMLDivElement>(null)

  const clientToCanvas = useCallback(
    (clientX: number, clientY: number): Pos => {
      const el = contentLayerRef.current
      if (!el) return { x: 0, y: 0 }
      const r = el.getBoundingClientRect()
      return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom }
    },
    [zoom],
  )

  // Pointer move/up are handled at the canvas level so the drag survives the
  // cursor leaving the node. zoom is divided out so 1px of screen = 1/zoom of
  // canvas movement.
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current
      if (d && d.group.length) {
        const dx = (e.clientX - d.startClientX) / zoom
        const dy = (e.clientY - d.startClientY) / zoom
        if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true
        if (d.moved) {
          setPositions((prev) => {
            const next = { ...prev }
            for (const k of d.group) {
              next[k] = {
                x: Math.max(0, d.origin[k].x + dx),
                y: Math.max(0, d.origin[k].y + dy),
              }
            }
            return next
          })
        }
        return
      }
      // Marquee resize
      const m = marqueeRef.current
      if (m) {
        const { x, y } = clientToCanvas(e.clientX, e.clientY)
        setMarquee(normalizeRect(m.startX, m.startY, x, y))
      }
    },
    [zoom, clientToCanvas],
  )

  const onPointerUp = useCallback(() => {
    const d = dragRef.current
    dragRef.current = null
    if (d) {
      // A press that didn't move is a click (handled by the node). A real drag
      // → persist the new positions (read the freshest values via the ref).
      if (d.moved) emitLayout(positionsRef.current)
      return
    }
    // Finish marquee: select nodes intersecting the box.
    const m = marqueeRef.current
    marqueeRef.current = null
    if (m && marquee) {
      const pos = positionsRef.current
      const hits = new Set<NodeKey>()
      for (const k of Object.keys(pos)) {
        if (rectsIntersect(marquee, { x: pos[k].x, y: pos[k].y, w: NODE_W, h: NODE_H })) {
          hits.add(k)
        }
      }
      setMoveSel(hits)
    }
    setMarquee(null)
  }, [marquee, emitLayout])

  const beginMarquee = useCallback(
    (e: React.PointerEvent) => {
      // Only start a marquee on a primary press directly on the canvas surface.
      if (e.button !== 0) return
      // Stop the browser from starting a native text selection that would bleed
      // into the page below as the drag extends past the canvas.
      e.preventDefault()
      const { x, y } = clientToCanvas(e.clientX, e.clientY)
      marqueeRef.current = { startX: x, startY: y }
      setMarquee({ x, y, w: 0, h: 0 })
      if (!e.shiftKey) setMoveSel(new Set())
    },
    [clientToCanvas],
  )

  // Ctrl/Cmd + wheel (and trackpad pinch, which the browser reports as a
  // ctrlKey wheel) zooms. A non-passive listener is required to preventDefault
  // the browser's native pinch-zoom. The zoom delta is proportional to the
  // event's deltaY and heavily damped, so a pinch gesture nudges the zoom
  // instead of rocketing through the whole range. Per-event change is also
  // capped so a single large delta can't jump multiple steps.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const raw = -e.deltaY * 0.01
      const delta = Math.max(-0.06, Math.min(0.06, raw))
      onZoomBy(delta)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onZoomBy])

  return (
    <div
      ref={scrollRef}
      // A canvas: a drag on its empty surface is a marquee, never a move of
      // the content window it sits in.
      data-no-window-drag
      className="group/canvas absolute inset-0 select-none overflow-auto"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      {/* Spacer reserves the *scaled* footprint so the scroll container shows
          scrollbars when zoomed in. A CSS transform doesn't change layout size,
          so the inner scaled layer is positioned absolutely inside this. */}
      <div className="relative" style={{ width: contentW * zoom, height: contentH * zoom }}>
      {/* Scaled content layer — nodes + edges scale together at intrinsic size.
          A press on the empty surface clears selection and starts a marquee. */}
      <div
        ref={contentLayerRef}
        className="absolute left-0 top-0"
        style={{
          width: contentW,
          height: contentH,
          transform: `scale(${zoom})`,
          transformOrigin: 'top left',
        }}
        onPointerDown={(e) => {
          // Only when the press lands on the surface itself, not a node.
          if (e.target === e.currentTarget) {
            onSelect(null)
            beginMarquee(e)
          }
        }}
      >
        <svg
          className="pointer-events-none absolute left-0 top-0"
          style={{ width: contentW, height: contentH }}
        >
          <defs>
            <marker id="flow-arrow" markerWidth="10" markerHeight="10" refX="7.5" refY="5" orient="auto">
              <path d="M2,2 L8,5 L2,8 Z" fill="hsl(var(--muted-foreground))" opacity={editor.enabled ? 0.7 : 0.4} />
            </marker>
          </defs>
          {/* One edge from each action's parent (the trigger for a root action,
              otherwise its parent action) into the action's left port. */}
          {editor.actions.map((a) => {
            const ap = positions[actionKey(a.id)]
            const parentKey = parentKeyOf.get(a.id) ?? 'trigger'
            const pp = positions[parentKey]
            if (!ap || !pp) return null
            const sX = pp.x + NODE_W
            const sY = pp.y + NODE_H / 2
            const eX = ap.x
            const eY = ap.y + NODE_H / 2
            const c = Math.max(40, Math.abs(eX - sX) / 2)
            const d = `M ${sX} ${sY} C ${sX + c} ${sY}, ${eX - c} ${eY}, ${eX} ${eY}`
            // An edge into a disabled action (or one under a disabled ancestor)
            // is dimmed and not animated — that branch won't run.
            const live = editor.enabled && !isPrunedAction(editor.actions, a.id)
            return (
              <g key={a.id}>
                <path
                  d={d}
                  fill="none"
                  stroke="hsl(var(--muted-foreground))"
                  strokeWidth="2"
                  strokeLinecap="round"
                  opacity={live ? 0.5 : 0.25}
                  markerEnd="url(#flow-arrow)"
                />
                {live && (
                  <path
                    d={d}
                    fill="none"
                    stroke="hsl(var(--muted-foreground))"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray="1 9"
                    opacity={0.8}
                    className="flow-edge-animate"
                  />
                )}
              </g>
            )
          })}
        </svg>

        {/* Marquee selection box */}
        {marquee && (marquee.w > 1 || marquee.h > 1) && (
          <div
            className="pointer-events-none absolute rounded-sm border border-primary/60 bg-primary/10"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
          />
        )}

        {/* Trigger node — hover reveals a "+" to add a root action. */}
        <FlowNode
          kind="trigger"
          x={positions.trigger?.x ?? 0}
          y={positions.trigger?.y ?? 0}
          w={NODE_W}
          h={NODE_H}
          selected={selected?.kind === 'trigger'}
          moveSelected={moveSel.has('trigger')}
          onClick={() => onSelect({ kind: 'trigger' })}
          onDragStart={(e, shift) => beginNodeDrag('trigger', e, shift)}
          onAddChild={onAddChild ? () => onAddChild(null) : undefined}
          icon={<Zap className="h-4 w-4" />}
          eyebrow="Trigger"
          title={triggerSummary.title}
          subtitle={triggerSummary.subtitle}
          hasInput={false}
          hasOutput
        />

        {/* Action nodes — one per action; positioned by the tree layout. Each
            hover-reveals a "+" to add a child action that chains off it. */}
        {editor.actions.map((a, i) => {
          const k = actionKey(a.id)
          const p = positions[k]
          if (!p) return null
          const isSkill = a.type === 'run_skill'
          const isAgent = a.type === 'run_agent'
          const isArchive = a.type === 'archive_capture'
          const isTool = a.type === 'call_tool'
          const isMac = a.type === 'run_local_agent'
          const conditionCount = a.condition.enabled ? a.condition.rules.length : 0
          const pruned = isPrunedAction(editor.actions, a.id)
          // "Needs setup": enabled (so it's meant to fire) but has no usable
          // target yet (URL / picked skill / agent+repo) — a draft. Shown only
          // when not already greyed as disabled.
          const incomplete = a.enabled && !isActionComplete(a)
          const readySubtitle = isSkill
            ? `${a.mode === 'act' ? 'Act' : 'Report'} · ${
                skills.find((s) => s.id === a.skill_id)?.name ?? 'Skill'
              }`
            : isAgent
              ? a.use_triggering_action_context
                ? 'From triggering action'
                : `${agents.find((ag) => ag.id === a.agent_id)?.name ?? 'Agent'} · ${a.repo || 'no repo'}`
              : isArchive
                ? 'Triggering capture'
                : isTool
                  ? `${a.tool || 'tool'} · ${connectionNames?.get(a.connection) ?? 'connected app'}`
                  : isMac
                    ? a.stored_local_agent?.mode === 'edit' ? 'May edit · in a worktree' : 'Read only'
                    : `${a.method} · ${hostOf(a.url)}`
          const subtitle = !a.enabled ? 'Disabled' : incomplete ? 'Needs setup' : readySubtitle
          return (
            <FlowNode
              key={a.id}
              kind="action"
              x={p.x}
              y={p.y}
              w={NODE_W}
              h={NODE_H}
              selected={selected?.kind === 'action' && selected.id === a.id}
              moveSelected={moveSel.has(k)}
              dimmed={pruned}
              disabledSelf={!a.enabled}
              incomplete={incomplete}
              onClick={() => onSelect({ kind: 'action', id: a.id })}
              onDragStart={(e, shift) => beginNodeDrag(k, e, shift)}
              onDelete={onRemoveAction && editor.actions.length > 1 ? () => onRemoveAction(a.id) : undefined}
              onAddChild={onAddChild ? () => onAddChild(a.id) : undefined}
              icon={
                isSkill ? (
                  <Sparkles className="h-4 w-4" />
                ) : isAgent ? (
                  <Boxes className="h-4 w-4" />
                ) : isArchive ? (
                  <Archive className="h-4 w-4" />
                ) : isTool ? (
                  <Plug className="h-4 w-4" />
                ) : isMac ? (
                  <Laptop className="h-4 w-4" />
                ) : (
                  <Globe className="h-4 w-4" />
                )
              }
              eyebrow={`Action ${i + 1}`}
              title={
                isSkill
                  ? 'Run skill'
                  : isAgent
                    ? 'Run agent'
                    : isArchive
                      ? 'Archive capture'
                      : isTool
                        ? 'Connected app'
                        : isMac
                          ? 'Job on your Mac'
                          : 'HTTP request'
              }
              subtitle={subtitle}
              conditionCount={conditionCount}
              hasInput
              hasOutput
            />
          )
        })}
      </div>
      </div>
    </div>
  )
}

/**
 * Send (and clear) a debounced canvas_layout PATCH if one is pending. Called by
 * the debounce timer and, with keepalive, when the editor unmounts.
 */
function sendPendingLayoutSave(
  pendingRef: { current: { id: string; layout: CanvasLayout } | null },
  init?: { keepalive?: boolean },
) {
  const pending = pendingRef.current
  if (!pending) return
  pendingRef.current = null
  fetch(`/api/account/flows/${pending.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canvas_layout: pending.layout }),
    keepalive: init?.keepalive,
  }).catch(() => {
    /* best-effort — a dropped layout save isn't worth interrupting the user */
  })
}

/**
 * Is this action pruned at fire time — i.e. itself disabled, or under a
 * disabled ancestor? Mirrors the runner's collectPrunedActionIds so the canvas
 * dims exactly the branches that won't run. Guards against cycles/dangling
 * parents with a visited set.
 */
function isPrunedAction(actions: EditorAction[], id: string): boolean {
  const byId = new Map(actions.map((a) => [a.id, a]))
  let cur = byId.get(id)
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (!cur.enabled) return true
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
  }
  return false
}

/** Extract a display host from a URL, falling back to the raw/placeholder text. */
function hostOf(url: string): string {
  if (!url) return 'No endpoint set'
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Per-node-type styling. Kept mostly neutral/monochrome — the only colour is a
 * subtle tint on the icon glyph so the trigger (amber) and action (blue) are
 * still distinguishable at a glance. Tiles, badges, ports, and the selected
 * ring all use neutral tokens.
 */
const NODE_ACCENT = {
  trigger: {
    tile: 'bg-muted/60 text-amber-500/80',
    port: 'bg-muted-foreground/40',
    ring: 'ring-foreground/15',
    badge: 'bg-muted text-muted-foreground',
  },
  action: {
    tile: 'bg-muted/60 text-blue-500/80',
    port: 'bg-muted-foreground/40',
    ring: 'ring-foreground/15',
    badge: 'bg-muted text-muted-foreground',
  },
} as const

function FlowNode({
  kind,
  x,
  y,
  w,
  h,
  selected,
  moveSelected,
  dimmed,
  disabledSelf,
  incomplete,
  onClick,
  onDragStart,
  onDelete,
  onAddChild,
  icon,
  eyebrow,
  title,
  subtitle,
  conditionCount,
  hasInput,
  hasOutput,
}: {
  kind: 'trigger' | 'action'
  x: number
  y: number
  w: number
  h: number
  selected: boolean
  moveSelected: boolean
  /** True when this node (or its branch) is disabled — render greyed out. */
  dimmed?: boolean
  /** True when THIS node is the one toggled off (vs. dimmed via an ancestor). */
  disabledSelf?: boolean
  /** True when enabled but not yet runnable (no URL) — a draft "needs setup". */
  incomplete?: boolean
  onClick: () => void
  onDragStart: (e: React.PointerEvent, shiftKey: boolean) => void
  onDelete?: () => void
  /** Add a child action that chains off this node. */
  onAddChild?: () => void
  icon: React.ReactNode
  eyebrow: string
  title: string
  subtitle: string
  conditionCount?: number
  hasInput: boolean
  hasOutput: boolean
}) {
  const accent = NODE_ACCENT[kind]
  // Track press origin locally to tell a click (open config) from a drag.
  const downRef = useRef<{ x: number; y: number; shift: boolean } | null>(null)
  return (
    <div
      onPointerDown={(e) => {
        e.stopPropagation()
        downRef.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey }
        onDragStart(e, e.shiftKey)
      }}
      onPointerUp={(e) => {
        // Don't stop propagation — the canvas-level onPointerUp must still run
        // to clear the drag state. A press that didn't travel far (and isn't a
        // shift-extend) is a click: open this node's config panel.
        const d = downRef.current
        downRef.current = null
        if (d && !d.shift && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= 3) {
          onClick()
        }
      }}
      style={{ left: x, top: y, width: w, height: h, touchAction: 'none' }}
      className={cn(
        'group/node absolute touch-none select-none rounded-2xl border bg-card transition-shadow duration-150',
        'cursor-grab active:cursor-grabbing',
        dimmed && 'opacity-50',
        selected
          ? cn('border-transparent shadow-lg ring-2', accent.ring)
          : moveSelected
            ? 'border-transparent shadow-md ring-2 ring-primary/40'
            : incomplete
              ? 'border-dashed border-amber-500/60 shadow-sm hover:shadow-md'
              : 'border-border shadow-sm hover:shadow-md',
      )}
    >
      <div className="flex h-full items-center gap-3 px-3.5">
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-border/60 transition-transform group-hover/node:scale-105',
            accent.tile,
          )}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-1.5">
            <span
              className={cn(
                'rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider',
                accent.badge,
              )}
            >
              {eyebrow}
            </span>
            {/* Condition chip — present when this action has an active gate. */}
            {conditionCount ? (
              <span className="flex items-center gap-0.5 rounded bg-amber-500/10 px-1.5 py-px text-[9px] font-medium text-amber-600 dark:text-amber-400">
                <Filter className="h-2.5 w-2.5" />
                {conditionCount === 1 ? 'IF' : `IF ×${conditionCount}`}
              </span>
            ) : null}
            {/* Disabled chip — only on the node that's actually toggled off. */}
            {disabledSelf ? (
              <span className="rounded bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground">
                OFF
              </span>
            ) : incomplete ? (
              /* Needs-setup chip — enabled but no URL yet (a draft). */
              <span className="rounded bg-amber-500/10 px-1.5 py-px text-[9px] font-medium text-amber-600 dark:text-amber-400">
                NEEDS SETUP
              </span>
            ) : null}
          </div>
          <div className="truncate text-sm font-semibold leading-tight text-foreground">{title}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>
        </div>
      </div>

      {/* Hover-reveal delete (action nodes only). Pointer-down stops propagation
          so clicking delete never starts a drag. */}
      {onDelete && (
        <button
          type="button"
          aria-label="Delete action"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="absolute -right-2 -top-2 z-20 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-destructive group-hover/node:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}

      {/* Hover-reveal "+" on the output side — adds a child action that chains
          off this node. This is the primary way to grow the tree (replaces the
          old bottom-corner "Add action" button). Pointer-down stops propagation
          so clicking it never starts a node drag. */}
      {onAddChild && (
        <button
          type="button"
          aria-label="Add action"
          title="Add action"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onAddChild()
          }}
          className="absolute -right-3.5 top-1/2 z-20 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-all hover:border-primary/50 hover:text-foreground group-hover/node:opacity-100"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}

      {/* Ports */}
      {hasInput && <Port side="left" className={accent.port} />}
      {hasOutput && <Port side="right" className={accent.port} />}
    </div>
  )
}

function Port({ side, className }: { side: 'left' | 'right'; className?: string }) {
  return (
    <span
      className={cn(
        'absolute top-1/2 z-10 h-3 w-3 -translate-y-1/2 rounded-full ring-2 ring-card',
        side === 'left' ? '-left-1.5' : '-right-1.5',
        className,
      )}
    />
  )
}

// ── helpers ──

function statusName(editor: EditorState, states: WorkflowState[], statusId: string): string {
  if (statusId === '__any__') return 'Any'
  if (editor.trigger.entity_type === 'action') {
    return states.find((s) => s.id === statusId)?.name ?? '…'
  }
  return statusId.replace(/_/g, ' ')
}
