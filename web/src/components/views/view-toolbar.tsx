'use client'

import { useState, useCallback, useRef, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { ViewTabs } from './view-tabs'
import { ViewSettingsPopover } from './view-settings-popover'
import { FilterFieldPicker } from './filters/filter-field-picker'
import { FilterChip } from './filters/filter-chip'
import { defaultOperatorFor } from './filters/field-traits'
import { ListFilter, Filter as FilterIcon, Plus, Save, FilePlus2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DEFAULT_DISPLAY_PROPERTIES,
  type View, type ViewEntityType, type CreateViewBody,
  type ViewFilter, type FilterFieldDefinition, type FilterOperator, type FilterValue,
  type CrmScope, type LibraryScope,
} from '@/lib/views/types'
import type { ViewConfig } from './hooks/use-view'
import {
  seedFiltersForProspectStageTab,
  type ProspectStageTab, type ProspectStageCounts,
} from '@/lib/views/prospect-stage-tabs'

type EditMode = null | 'create' | 'edit'

interface ViewToolbarProps {
  /** Align scoped list tabs with the detail page's section tabs above them. */
  embedded?: boolean
  /** A chat card: no view tabs (it is its own view), just the filter and settings buttons. */
  hideTabs?: boolean
  /** The view tabs only below `md` (CSS): from there up a page's sub-nav beside the rail holds them. */
  tabsBelowMdOnly?: boolean
  /** A slimmer row, for a card inline in the chat. */
  compact?: boolean
  entityType: ViewEntityType
  teamId?: string
  views: View[]
  activeViewId: string | null
  /** `silent` marks a clear that is a side effect of another gesture (the scope
   *  tabs) rather than a view pick — the host must not record it in history. */
  onViewChange: (viewId: string | null, opts?: { silent?: boolean }) => void
  onCreateView: (data: CreateViewBody) => Promise<View | null>
  onUpdateView: (viewId: string, updates: Partial<View>) => void
  onDuplicateView: (viewId: string) => void
  onDeleteView: (viewId: string) => void
  config: ViewConfig
  onConfigChange: (updates: Partial<ViewConfig>) => void
  /** Atomic scope reset — clears saved view and resets config to defaults with the given overrides */
  onScopeReset?: (overrides: Partial<ViewConfig>) => void
  /** CRM scope pills (All/Internal/External/Companies). Scoped embeds pass
   *  false — inside e.g. Company → People the Companies pill would flip the
   *  embed to a list of ALL companies. */
  crmScopesEnabled?: boolean
  /** Capture scope pills (All captures/Mine/Shared with me). Scoped embeds
   *  pass false — inside e.g. Contact → Captures the pills would fight the
   *  parent scope (the contact's captures aren't partitioned by ownership). */
  captureScopesEnabled?: boolean
  /** Library collections use the same baseline tabs as actions and captures. */
  onLibraryScopeChange?: (scope: LibraryScope) => void
  /** Fields pinned by the parent scope (e.g. project_id inside Project → Actions). */
  lockedScopeFields?: Set<string>
  /**
   * The prospect list's stage tabs (All · Saved · Needs review · Dismissed):
   * baseline navigation like the action/CRM/capture scope pills, drawn by
   * ViewTabs in place of "All candidates". The page owns the value — `null`
   * while a custom view is open — and hears every pick through the handler;
   * this toolbar's part is to clear the custom view on the way, exactly as the
   * other scope sets do, so a tab and a view never both read as selected.
   */
  prospectStage?: ProspectStageTab | null
  prospectStageCounts?: ProspectStageCounts | null
  onProspectStageChange?: (tab: ProspectStageTab) => void
  /**
   * Page-owned controls for the toolbar's right cluster, drawn before the
   * filter and settings buttons — the prospect list's "Enrich · N" and its
   * people-run stop button, which share this row now that the stage tabs
   * share the views' tab row.
   */
  actions?: ReactNode
  // ── Draft state (owned by useViewConfig) ──
  /** True when config diverges from the baseline (saved view or default). */
  isDirty: boolean
  /** The override map — used to know what to PATCH on Save. */
  overrides: Partial<ViewConfig>
  /** Save the draft as an Update to the active saved view. No-op on the implicit default. */
  onSaveDraft: () => Promise<void> | void
  /** True when the host page supplied a graph body — see UnifiedViewLayout's
   *  `renderGraph`. Gates the Graph option in the layout toggle. */
  graphAvailable?: boolean
  /** Discard the draft, reverting to the baseline. */
  onDiscardDraft: () => void
}

const subscribe = () => () => {}
const getSnapshot = () => true
const getServerSnapshot = () => false

export function ViewToolbar({
  embedded = false, hideTabs = false, tabsBelowMdOnly = false, compact = false, entityType, teamId, views, activeViewId, onViewChange,
  onCreateView, onUpdateView, onDuplicateView, onDeleteView,
  config, onConfigChange, onScopeReset, crmScopesEnabled = true, captureScopesEnabled = true,
  lockedScopeFields,
  onLibraryScopeChange,
  prospectStage, prospectStageCounts, onProspectStageChange, actions,
  isDirty, overrides, onSaveDraft, onDiscardDraft,
  graphAvailable,
}: ViewToolbarProps) {
  // Prevent Radix popover hydration mismatch — defer popover rendering to client
  const isMounted = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const [toolbarPickerOpen, setToolbarPickerOpen] = useState(false)
  const [panelPickerOpen, setPanelPickerOpen] = useState(false)
  const [editMode, setEditMode] = useState<EditMode>(null)
  const [editingViewId, setEditingViewId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const preEditFiltersRef = useRef<ViewFilter[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // ─── Refs for stable callbacks (avoid re-renders in children) ───
  const configRef = useRef(config)
  configRef.current = config
  const editModeRef = useRef(editMode)
  editModeRef.current = editMode
  const viewsRef = useRef(views)
  viewsRef.current = views
  const draftNameRef = useRef(draftName)
  draftNameRef.current = draftName
  const editingViewIdRef = useRef(editingViewId)
  editingViewIdRef.current = editingViewId
  const activeViewIdRef = useRef(activeViewId)
  activeViewIdRef.current = activeViewId

  const effectiveEntityType: ViewEntityType =
    entityType === 'contact' && config.crm_scope === 'companies' ? 'company' : entityType

  const isInEditPanel = editMode !== null
  const activeView = views.find(v => v.id === activeViewId)

  // Focus input when entering edit panel
  useEffect(() => {
    if (editMode) {
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [editMode])

  // ─── Shared filter builder ───
  const buildFilter = (field: FilterFieldDefinition, value?: FilterValue): ViewFilter => {
    let operator: FilterOperator
    let filterValue: FilterValue

    if (value !== undefined) {
      if (Array.isArray(value) && value.length > 1) {
        operator = 'is_any_of'
        filterValue = value
      } else if (Array.isArray(value) && value.length === 1) {
        operator = 'is'
        filterValue = value[0]
      } else {
        operator = 'is'
        filterValue = value
      }
    } else {
      // Per-FIELD rather than the type's first operator: `is` on a continuous
      // number (confidence, a score) is exact equality, which is essentially
      // never the question and always answers with an empty list. See
      // filters/field-traits.
      operator = defaultOperatorFor(field)
      filterValue = field.type === 'boolean' ? true : ''
    }

    return {
      id: crypto.randomUUID(),
      field: field.field,
      operator,
      value: filterValue,
    }
  }

  // ─── Filter add (both toolbar button and edit-panel button) ───
  // Both paths go through onConfigChange → useViewConfig stores it as an
  // override → isDirty flips true → the overlay ribbon appears automatically.
  const handleToolbarAddFilter = useCallback((field: FilterFieldDefinition, value?: FilterValue) => {
    const newFilter = buildFilter(field, value)
    onConfigChange({ filters: [...configRef.current.filters, newFilter] })
    setToolbarPickerOpen(false)
  }, [onConfigChange])

  const handlePanelAddFilter = useCallback((field: FilterFieldDefinition, value?: FilterValue) => {
    const newFilter = buildFilter(field, value)
    onConfigChange({ filters: [...configRef.current.filters, newFilter] })
    setPanelPickerOpen(false)
  }, [onConfigChange])

  // ─── Overlay: Discard (revert to baseline) ───
  const handleOverlayClear = useCallback(() => {
    onDiscardDraft()
  }, [onDiscardDraft])

  // ─── Overlay: Update existing view (PATCH all overridden fields) ───
  const handleOverlayUpdateView = useCallback(() => {
    onSaveDraft()
  }, [onSaveDraft])

  // ─── Overlay: Save as new view (opens create panel with current config) ───
  // The draft remains in the override store until the create flow either saves
  // (which clears it via the create handler) or the user cancels.
  const handleOverlaySaveAsNew = useCallback(() => {
    preEditFiltersRef.current = configRef.current.filters
    setDraftName('')
    setEditingViewId(null)
    setEditMode('create')
  }, [])

  // ─── Create mode (from + button) ───
  // A prospect list's "+" pressed on the Saved (or Dismissed) tab seeds the
  // draft with a VISIBLE "Stage is saved" chip: the tab's own narrowing is an
  // invisible scope filter a saved view would silently drop, and a view made
  // from Saved should stay saved unless the user removes the chip.
  const handleStartCreate = useCallback(() => {
    preEditFiltersRef.current = configRef.current.filters
    onConfigChange({
      filters: entityType === 'prospect_list_entry'
        ? seedFiltersForProspectStageTab(prospectStage)
        : entityType === 'agent' || entityType === 'skill'
          ? configRef.current.filters
          : [],
    })
    setDraftName('')
    setEditingViewId(null)
    setEditMode('create')
  }, [onConfigChange, entityType, prospectStage])

  // ─── Edit mode (from right-click Edit) ───
  const handleStartEdit = useCallback((viewId: string) => {
    const view = viewsRef.current.find(v => v.id === viewId)
    if (!view) return
    onViewChange(viewId)
    preEditFiltersRef.current = view.filters || []
    setDraftName(view.name)
    setEditingViewId(viewId)
    setEditMode('edit')
  }, [onViewChange])

  // ─── Promote from dirty bar to full editor ───
  // Single code path for "I want to add another filter" — opens the same
  // edit/create panel used elsewhere instead of maintaining a parallel
  // picker inside the dirty bar. Pre-populates with the current draft so
  // the user doesn't lose what they've built.
  const handlePromoteToEditor = useCallback(() => {
    const cfg = configRef.current
    preEditFiltersRef.current = cfg.filters
    if (activeViewIdRef.current && viewsRef.current.find(v => v.id === activeViewIdRef.current)) {
      const view = viewsRef.current.find(v => v.id === activeViewIdRef.current)!
      setDraftName(view.name)
      setEditingViewId(view.id)
      setEditMode('edit')
    } else {
      setDraftName('')
      setEditingViewId(null)
      setEditMode('create')
    }
  }, [])

  // ─── Cancel edit/create ───
  const handleCancel = useCallback(() => {
    onConfigChange({ filters: preEditFiltersRef.current })
    setEditMode(null)
    setEditingViewId(null)
    setPanelPickerOpen(false)
  }, [onConfigChange])

  // ─── Save edit/create ───
  const savingRef = useRef(false)
  const handleSave = useCallback(async () => {
    const name = draftNameRef.current.trim()
    if (!name) return
    const mode = editModeRef.current
    const cfg = configRef.current

    if (mode === 'create') {
      // One create at a time: Enter and Save both land here before the first
      // await settles.
      if (savingRef.current) return
      savingRef.current = true
      const view = await onCreateView({
        name,
        entity_type: entityType,
        team_id: teamId,
        visibility: teamId ? 'team' : 'personal',
        layout: cfg.layout,
        filters: cfg.filters,
        ordering: cfg.ordering,
        grouping: cfg.grouping,
        sub_grouping: cfg.sub_grouping,
        display_properties: cfg.display_properties?.length
          ? cfg.display_properties
          : DEFAULT_DISPLAY_PROPERTIES[entityType],
        board_group_by: cfg.board_group_by ?? undefined,
        show_completed: cfg.show_completed,
        completed_filter: cfg.completed_filter,
        show_sub_items: cfg.show_sub_items,
        nested_sub_items: cfg.nested_sub_items,
        show_empty_groups: cfg.show_empty_groups,
      }).finally(() => { savingRef.current = false })
      if (!view) {
        // Keep the panel and the draft filters: closing and discarding here
        // would lose what the user built, with no view to show for it.
        toast.error('Could not save the view')
        return
      }
      setEditMode(null)
      setEditingViewId(null)
      // The draft on the source baseline (default or another view) has been
      // canonicalized into the new view — clear it so it doesn't reappear
      // when the user returns to that baseline.
      onDiscardDraft()
      onViewChange(view.id)
    } else if (mode === 'edit') {
      const vid = editingViewIdRef.current
      if (vid) {
        onUpdateView(vid, {
          name,
          filters: cfg.filters,
          ordering: cfg.ordering,
          grouping: cfg.grouping,
          sub_grouping: cfg.sub_grouping,
          layout: cfg.layout,
          board_group_by: cfg.board_group_by,
          show_completed: cfg.show_completed,
          completed_filter: cfg.completed_filter,
        })
        setEditMode(null)
        setEditingViewId(null)
        // The view's new baseline now matches the draft — clear overrides
        // so the dirty bar doesn't linger showing already-saved changes.
        onDiscardDraft()
      }
    }
  }, [onCreateView, onUpdateView, entityType, teamId, onViewChange, onDiscardDraft])

  // ─── Keyboard ───
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSave()
    } else if (e.key === 'Escape') {
      handleCancel()
    }
  }, [handleSave, handleCancel])

  // ─── View change ───
  // Switching baselines does NOT discard drafts — each baseline has its own
  // localStorage slot (see useViewConfig), so a draft on view A survives a
  // detour to view B. That's the "precious draft" behavior the user asked for.
  // We only close the inline Edit/Create panel since it's tied to a specific
  // editingViewId and doesn't make sense after navigation.
  const handleViewChange = useCallback((viewId: string | null) => {
    if (editModeRef.current !== null) {
      onConfigChange({ filters: preEditFiltersRef.current })
      setEditMode(null)
      setEditingViewId(null)
      setPanelPickerOpen(false)
    }
    onViewChange(viewId)
  }, [onConfigChange, onViewChange])

  // ─── Combined view change + scope (atomic reset to avoid stale config races) ───
  const handleScopedViewChange = useCallback((scope: 'assigned' | 'created' | 'all') => {
    if (editModeRef.current !== null) {
      setEditMode(null)
      setEditingViewId(null)
      setPanelPickerOpen(false)
    }
    // Silent: clearing the saved view here is plumbing for the scope switch,
    // not a view pick — it must not push a history step.
    onViewChange(null, { silent: true })
    // Build the correct scope filter. "All issues" has no scope filter so
    // unassigned items (e.g. MCP/API-created tickets) stay visible.
    const scopeFilters = scope === 'all'
      ? []
      : [{ id: '__scope_assignee', field: scope === 'created' ? 'user_id' : 'assignee_id', operator: 'is' as const, value: '@me' }]
    if (onScopeReset) {
      // Atomic: reset entire config to defaults + scope in one state update
      onScopeReset({ action_scope: scope, filters: scopeFilters })
    } else {
      onConfigChange({ action_scope: scope })
    }
  }, [onViewChange, onConfigChange, onScopeReset])

  const handleScopedCrmChange = useCallback((scope: CrmScope) => {
    if (editModeRef.current !== null) {
      setEditMode(null)
      setEditingViewId(null)
      setPanelPickerOpen(false)
    }
    // Silent for the same reason as handleScopedViewChange above.
    onViewChange(null, { silent: true })
    if (onScopeReset) {
      onScopeReset({ crm_scope: scope })
    } else {
      onConfigChange({ crm_scope: scope })
    }
  }, [onViewChange, onConfigChange, onScopeReset])

  const handleScopedCaptureChange = useCallback((scope: 'all' | 'mine' | 'shared') => {
    if (editModeRef.current !== null) {
      setEditMode(null)
      setEditingViewId(null)
      setPanelPickerOpen(false)
    }
    // Silent for the same reason as handleScopedViewChange above.
    onViewChange(null, { silent: true })
    if (onScopeReset) {
      onScopeReset({ capture_scope: scope })
    } else {
      onConfigChange({ capture_scope: scope })
    }
  }, [onViewChange, onConfigChange, onScopeReset])

  const handleScopedLibraryChange = useCallback((scope: LibraryScope) => {
    setEditMode(null)
    setEditingViewId(null)
    setPanelPickerOpen(false)
    onViewChange(null, { silent: true })
    onScopeReset?.({ library_scope: scope })
    onLibraryScopeChange?.(scope)
  }, [onViewChange, onScopeReset, onLibraryScopeChange])

  // The prospect stage tabs. No config reset: the tab's narrowing rides the
  // page's scope filters rather than `config.filters`, so there is nothing of
  // the old tab's to shadow the new one — and a draft filter the user built
  // ("Match score at least 80") survives a hop from All to Saved instead of
  // vanishing, which is what it does today between the CRM's pills.
  const handleScopedProspectChange = useCallback((tab: ProspectStageTab) => {
    if (editModeRef.current !== null) {
      setEditMode(null)
      setEditingViewId(null)
      setPanelPickerOpen(false)
    }
    // Silent for the same reason as handleScopedViewChange above.
    onViewChange(null, { silent: true })
    onProspectStageChange?.(tab)
  }, [onViewChange, onProspectStageChange])

  // ─── Filter chips renderer ───
  // `addControl`: null = no add affordance, 'picker' = inline popover picker
  // (used inside the edit/create panel), 'promote' = a `+` button that opens
  // the full edit panel (used in the dirty bar, so we don't have two parallel
  // filter-add UIs to maintain).
  const renderFilterChips = (
    addControl: null | 'picker' | 'promote',
    pickerState?: [boolean, (v: boolean) => void],
    onAdd?: (f: FilterFieldDefinition, v?: FilterValue) => void,
    onPromote?: () => void,
  ) => (
    <div className="flex items-center gap-1.5 flex-wrap min-w-0">
      {config.filters.map((filter, index) => (
        <FilterChip
          key={filter.id}
          filter={filter}
          entityType={effectiveEntityType}
          onUpdate={updated => {
            const next = [...configRef.current.filters]
            next[index] = updated
            onConfigChange({ filters: next })
          }}
          onRemove={() => onConfigChange({ filters: configRef.current.filters.filter((_, j) => j !== index) })}
        />
      ))}

      {addControl === 'picker' && pickerState && onAdd && (
        <Popover open={pickerState[0]} onOpenChange={pickerState[1]}>
          <PopoverTrigger asChild>
            <button className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-background hover:text-foreground transition-colors shrink-0">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-60 p-0" align="start">
            <FilterFieldPicker entityType={effectiveEntityType} onSelect={onAdd} />
          </PopoverContent>
        </Popover>
      )}

      {addControl === 'promote' && onPromote && (
        <button
          onClick={onPromote}
          title="Add filter (opens full view editor)"
          className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-background hover:text-foreground transition-colors shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )

  return (
    <div className="flex flex-col">
      {/* Row 1: tabs + filter button + settings */}
      <div className={cn('flex shrink-0 items-center justify-between', compact ? 'h-8' : 'h-10', embedded ? 'px-3' : 'px-4')}>
        {/* In a card the tabs scroll sideways rather than being cut off: an
            inline card is narrower than a window was. */}
        <div className={cn('flex items-center gap-1 min-w-0 flex-1', compact ? 'overflow-x-auto scrollbar-hide' : 'overflow-hidden')}>
          {/* Below `md` only where a page's sub-nav beside the rail holds them from there up (tabsBelowMdOnly). */}
          {!hideTabs && (
            <div data-view-tabs="" className={tabsBelowMdOnly ? 'contents md:hidden' : 'contents'}>
              <ViewTabs
                views={views}
                activeViewId={activeViewId}
                onViewChange={handleViewChange}
                onDuplicateView={onDuplicateView}
                onDeleteView={onDeleteView}
                onEditView={handleStartEdit}
                entityType={entityType}
                teamId={teamId}
                actionScope={config.action_scope}
                onActionScopeChange={handleScopedViewChange}
                crmScope={crmScopesEnabled ? config.crm_scope : undefined}
                onCrmScopeChange={crmScopesEnabled ? handleScopedCrmChange : undefined}
                captureScope={captureScopesEnabled ? config.capture_scope : undefined}
                onCaptureScopeChange={captureScopesEnabled ? handleScopedCaptureChange : undefined}
                libraryScope={config.library_scope}
                onLibraryScopeChange={onLibraryScopeChange ? handleScopedLibraryChange : undefined}
                prospectStage={prospectStage}
                prospectStageCounts={prospectStageCounts}
                onProspectStageChange={onProspectStageChange ? handleScopedProspectChange : undefined}
                editMode={editMode}
                editingViewId={editingViewId}
                draftName={draftName}
                onStartCreate={handleStartCreate}
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-2">
          {/* The page's own controls, before the views' buttons. */}
          {actions}
          <TooltipProvider>
            {/* Filter button */}
            {!isInEditPanel && isMounted && (
              <Popover open={toolbarPickerOpen} onOpenChange={setToolbarPickerOpen}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost" size="icon"
                        className={cn('h-8 w-8', isDirty && 'bg-muted')}
                      >
                        <ListFilter className="h-4 w-4" />
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Add filter</TooltipContent>
                </Tooltip>
                <PopoverContent className="w-60 p-0" align="end">
                  <FilterFieldPicker entityType={effectiveEntityType} onSelect={handleToolbarAddFilter} />
                </PopoverContent>
              </Popover>
            )}

            {/* Settings */}
            {isMounted && <ViewSettingsPopover config={config} entityType={effectiveEntityType} onChange={onConfigChange} lockedScopeFields={lockedScopeFields} graphAvailable={graphAvailable} />}
          </TooltipProvider>
        </div>
      </div>

      {/* Dirty-state ribbon: shown whenever the user's config diverges from
          the baseline (saved view or default). Persisted in localStorage so
          drafts survive navigation, reloads, and tab close/open until the
          user explicitly Saves or Cancels.

          Two visible buttons (per user choice):
            - Update "<view>"  → PATCH the saved view with all overrides
            - Save as new view → opens the create panel pre-filled with overrides
          On the implicit default (no activeView) only Save-as-new is shown. */}
      {isDirty && !isInEditPanel && (
        <div className="px-4 py-1.5">
          {/* Wraps: on a narrow card (a phone, an inline card) the chips take
              the row and the buttons drop under them, never over them. */}
          <div data-filter-ribbon="" className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/50 border px-2.5 py-1.5">
            <div className="min-w-0 flex-[1_1_12rem]">
              {renderFilterChips('promote', undefined, undefined, handlePromoteToEditor)}
            </div>
            <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">

            {/* Pill-shaped buttons to match view-tabs styling. Update is the
                primary action (filled foreground); Save as new is the
                secondary outline; Cancel is a quiet text button. */}
            <button
              onClick={handleOverlayClear}
              className="shrink-0 inline-flex items-center px-3 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
            >
              Cancel
            </button>

            {activeViewId && activeView && (
              <button
                onClick={handleOverlayUpdateView}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-full border border-border bg-muted text-foreground font-medium hover:bg-muted/70 transition-colors whitespace-nowrap"
              >
                <Save className="h-3 w-3" />
                Update &ldquo;{activeView.name}&rdquo;
              </button>
            )}

            <button
              onClick={handleOverlaySaveAsNew}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-full border bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground transition-colors whitespace-nowrap"
            >
              <FilePlus2 className="h-3 w-3" />
              Save as new view
            </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit/Create panel (name + filters in unified card) */}
      {isInEditPanel && (
        <div className="px-4 pb-2">
          <div className="rounded-lg border bg-muted/30">
            {/* Name row */}
            <div className="flex items-center h-10 px-3">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <FilterIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                <input
                  ref={inputRef}
                  value={draftName}
                  onChange={e => setDraftName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="View name..."
                  className="flex-1 min-w-0 bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground/50"
                />
              </div>
              <div className="flex items-center gap-1 shrink-0 ml-2">
                <button
                  onClick={handleCancel}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  className="text-xs font-medium text-foreground hover:text-primary transition-colors px-2"
                >
                  Save
                </button>
              </div>
            </div>

            {/* Filter row */}
            <div className="flex items-center gap-1.5 border-t border-border/50 px-3 py-1.5">
              {renderFilterChips('picker', [panelPickerOpen, setPanelPickerOpen], handlePanelAddFilter)}

              <div className="flex-1" />
              <TooltipProvider>
                <ViewSettingsPopover config={config} entityType={effectiveEntityType} onChange={onConfigChange} lockedScopeFields={lockedScopeFields} />
              </TooltipProvider>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
