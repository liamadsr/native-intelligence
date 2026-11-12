'use client'

import * as React from 'react'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Plus, Copy, Trash2, Pencil, Filter as FilterIcon, Users, Lock } from 'lucide-react'
import {
  FILTERABLE_FIELDS, operatorLabel as describeOperator,
  type View, type ViewEntityType, type ViewFilter, type CrmScope, type LibraryScope,
} from '@/lib/views/types'
import {
  PROSPECT_STAGE_TABS, PROSPECT_STAGE_TAB_LABELS, PROSPECT_STAGE_TAB_TITLES,
  isConditionalProspectStageTab,
  type ProspectStageTab, type ProspectStageCounts,
} from '@/lib/views/prospect-stage-tabs'
import { customFieldFilterFields, isCustomFieldPath } from '@/lib/views/custom-field-columns'
import { ACTION_SCOPE_TAB_ORDER, actionScopeLabel } from '@/lib/views/action-scopes'
import { useCustomFieldDefinitions } from './hooks/use-custom-field-definitions'

/** What a collection of these is CALLED, in the user's words. Drives the
 *  built-in "All …" tab and the search box's placeholder. */
export const ENTITY_PLURAL: Record<ViewEntityType, string> = {
  agent: 'agents', skill: 'skills',
  action: 'issues', capture: 'captures', contact: 'contacts',
  company: 'companies', email_thread: 'threads', document: 'documents',
  initiative: 'initiatives',
  project: 'projects',
  flow: 'flows',
  sequence: 'sequences',
  prospect_list: 'lists',
  prospect_list_entry: 'candidates',
  eval_suite: 'suites',
  eval_case: 'cases',
  eval_run: 'runs',
  // "All knowledge", not "All claims": the built-in tab names what the reader
  // came for, and nobody navigates to Knowledge thinking about claim rows.
  claim: 'knowledge',
  data_row: 'rows',
}

type EditMode = null | 'create' | 'edit'

// ── Filter preview for tooltip ──
function FilterPreview({ filter, entityType }: { filter: ViewFilter; entityType: ViewEntityType }) {
  const isCustom = isCustomFieldPath(filter.field)
  const customDefs = useCustomFieldDefinitions(entityType, isCustom)
  const fieldDef = isCustom
    ? customFieldFilterFields(customDefs).find(f => f.field === filter.field)
    : FILTERABLE_FIELDS[entityType]?.find(f => f.field === filter.field)
  // A custom field the workspace no longer has reads as "Custom field", not its path.
  const fieldLabel = fieldDef?.label || (isCustom ? 'Custom field' : filter.field)
  const operatorLabel = describeOperator(filter.operator, fieldDef?.type)

  let valueLabel: string
  const val = filter.value
  if (val === '@me') {
    valueLabel = 'Me'
  } else if (Array.isArray(val)) {
    valueLabel = val.join(', ')
  } else if (val && typeof val === 'object' && 'from' in val && 'to' in val) {
    // A `between` range — two numbers or two dates.
    valueLabel = `${String(val.from)} – ${String(val.to)}`
  } else if (val && typeof val === 'object' && 'count' in val && 'unit' in val) {
    // A relative date — "last 7 days".
    const rel = val as { direction: string; count: number; unit: string }
    valueLabel = rel.direction === 'this' ? `this ${rel.unit}` : `${rel.direction === 'past' ? 'last' : 'next'} ${rel.count} ${rel.unit}${rel.count === 1 ? '' : 's'}`
  } else if (typeof val === 'boolean') {
    valueLabel = val ? 'Yes' : 'No'
  } else if (val === '' || val === null || val === undefined) {
    valueLabel = '…'
  } else {
    valueLabel = String(val)
  }

  const noValue = ['is_empty', 'is_not_empty'].includes(filter.operator)

  return (
    <div className="inline-flex items-stretch h-6 rounded-md border bg-background text-[11px]">
      <span className="flex items-center px-2 text-muted-foreground font-medium">{fieldLabel}</span>
      <span className="flex items-center px-1.5 border-l text-muted-foreground">{operatorLabel}</span>
      {!noValue && (
        <span className="flex items-center px-2 border-l font-medium">{valueLabel}</span>
      )}
    </div>
  )
}

function ViewTooltipContent({ view, entityType }: { view: View; entityType: ViewEntityType }) {
  const hasFilters = view.filters && view.filters.length > 0

  if (!hasFilters && !view.description) return null

  return (
    <div className="flex flex-col gap-2 max-w-xs">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{view.name}</span>
        {hasFilters && (
          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {view.filters.length}
          </span>
        )}
      </div>
      {view.description && (
        <p className="text-xs text-muted-foreground">{view.description}</p>
      )}
      {hasFilters && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {view.filters.map(filter => (
            <FilterPreview key={filter.id} filter={filter} entityType={entityType} />
          ))}
        </div>
      )}
    </div>
  )
}

interface ViewTabsProps {
  views: View[]
  activeViewId: string | null
  onViewChange: (viewId: string | null) => void
  onDuplicateView: (viewId: string) => void
  onDeleteView: (viewId: string) => void
  onEditView: (viewId: string) => void
  /** Share a view with the workspace or make it personal (a menu item only when given). */
  onSetVisibility?: (viewId: string, visibility: 'personal' | 'workspace') => void
  entityType: ViewEntityType
  teamId?: string
  actionScope?: 'assigned' | 'created' | 'all'
  onActionScopeChange?: (scope: 'assigned' | 'created' | 'all') => void
  crmScope?: CrmScope
  onCrmScopeChange?: (scope: CrmScope) => void
  captureScope?: 'all' | 'mine' | 'shared'
  onCaptureScopeChange?: (scope: 'all' | 'mine' | 'shared') => void
  libraryScope?: LibraryScope
  onLibraryScopeChange?: (scope: LibraryScope) => void
  /**
   * The prospect list's stage tabs (All · Saved · Needs review · Dismissed) —
   * baseline navigation exactly like the three scope sets above, rendered in
   * place of the generic "All candidates" tab when the handler is given. The
   * page owns the value; `null` means a custom view is open and no tab is.
   * Counts are optional: an empty list shows the tabs bare.
   */
  prospectStage?: ProspectStageTab | null
  prospectStageCounts?: ProspectStageCounts | null
  onProspectStageChange?: (tab: ProspectStageTab) => void
  editMode?: EditMode
  editingViewId?: string | null
  draftName?: string
  onStartCreate?: () => void
}

export function ViewTabs({
  views, activeViewId, onViewChange, onDuplicateView, onDeleteView, onEditView, onSetVisibility,
  entityType, teamId, actionScope, onActionScopeChange, crmScope, onCrmScopeChange,
  captureScope, onCaptureScopeChange,
  libraryScope, onLibraryScopeChange,
  prospectStage, prospectStageCounts, onProspectStageChange,
  editMode, editingViewId, draftName, onStartCreate,
}: ViewTabsProps) {
  const isEditing = editMode !== null

  const tabClass = (active: boolean) => cn(
    'inline-flex shrink-0 items-center gap-1.5 px-3 py-1 text-xs rounded-full border transition-colors whitespace-nowrap',
    active
      ? 'bg-foreground text-background border-foreground font-medium'
      : 'bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground',
  )

  return (
    <TooltipProvider delayDuration={800} skipDelayDuration={300}>
      <div className="flex items-center gap-1 flex-nowrap">
        {/* Default tabs */}
        {(entityType === 'agent' || entityType === 'skill') && onLibraryScopeChange ? (
          (['all', 'mine', 'workspace', 'discover'] as const).map(scope => (
            <button
              key={scope}
              type="button"
              aria-pressed={!activeViewId && !isEditing && libraryScope === scope}
              onClick={() => onLibraryScopeChange(scope)}
              className={tabClass(!activeViewId && !isEditing && libraryScope === scope)}
            >
              {{ all: 'All', mine: 'My', workspace: 'Workspace', discover: 'Discover' }[scope]} {ENTITY_PLURAL[entityType]}
            </button>
          ))
        ) : entityType === 'action' && !teamId && onActionScopeChange ? (
          <>
            {/* Their names from one source, shared with the Tasks sub-nav (lib/views/action-scopes.ts). */}
            {ACTION_SCOPE_TAB_ORDER.map(scope => (
              <button
                key={scope}
                onClick={() => onActionScopeChange(scope)}
                className={tabClass(!activeViewId && !isEditing && actionScope === scope)}
              >
                {actionScopeLabel(scope)}
              </button>
            ))}
          </>
        ) : entityType === 'contact' && onCrmScopeChange ? (
          <>
            <button
              onClick={() => onCrmScopeChange('contacts')}
              className={tabClass(!activeViewId && !isEditing && crmScope === 'contacts')}
            >
              All
            </button>
            <button
              onClick={() => onCrmScopeChange('internal')}
              className={tabClass(!activeViewId && !isEditing && crmScope === 'internal')}
            >
              Internal
            </button>
            <button
              onClick={() => onCrmScopeChange('external')}
              className={tabClass(!activeViewId && !isEditing && crmScope === 'external')}
            >
              External
            </button>
            <button
              onClick={() => onCrmScopeChange('companies')}
              className={tabClass(!activeViewId && !isEditing && crmScope === 'companies')}
            >
              Companies
            </button>
          </>
        ) : entityType === 'capture' && onCaptureScopeChange ? (
          <>
            <button
              onClick={() => onCaptureScopeChange('all')}
              className={tabClass(!activeViewId && !isEditing && captureScope === 'all')}
            >
              All captures
            </button>
            <button
              onClick={() => onCaptureScopeChange('mine')}
              className={tabClass(!activeViewId && !isEditing && captureScope === 'mine')}
            >
              Mine
            </button>
            <button
              onClick={() => onCaptureScopeChange('shared')}
              className={tabClass(!activeViewId && !isEditing && captureScope === 'shared')}
            >
              Shared with me
            </button>
          </>
        ) : entityType === 'prospect_list_entry' && onProspectStageChange ? (
          /* The stage tabs, with their counts — the count IS the affordance: a
             bare "Dismissed" makes a user click to find out whether it is worth
             clicking. Real buttons in a tablist; every one stays tabbable. */
          <div role="tablist" aria-label="Filter candidates" className="flex items-center gap-1">
            {PROSPECT_STAGE_TABS.map(tab => {
              const active = !activeViewId && !isEditing && prospectStage === tab
              const count = prospectStageCounts?.[tab]
              if (isConditionalProspectStageTab(tab) && !active && !(count && count > 0)) return null
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-prospect-stage={tab}
                  title={PROSPECT_STAGE_TAB_TITLES[tab]}
                  onClick={() => onProspectStageChange(tab)}
                  className={tabClass(active)}
                >
                  {PROSPECT_STAGE_TAB_LABELS[tab]}
                  {count !== undefined && (
                    <span className={cn('tabular-nums', active ? 'text-background/70' : 'text-muted-foreground/70')}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ) : (
          <button
            onClick={() => onViewChange(null)}
            className={tabClass(!activeViewId && !isEditing)}
          >
            All {ENTITY_PLURAL[entityType]}
          </button>
        )}

        {/* Saved view tabs */}
        {views.map(view => {
          const isBeingEdited = editMode === 'edit' && editingViewId === view.id
          const hasTooltipContent = (view.filters?.length > 0 || view.description) && !isBeingEdited
          const tab = (
            <button
              onClick={() => onViewChange(view.id)}
              className={tabClass(isBeingEdited || (!isEditing && activeViewId === view.id))}
            >
              {isBeingEdited && <Pencil className="h-3 w-3" />}
              {view.icon && !isBeingEdited && <span>{view.icon}</span>}
              {isBeingEdited ? (draftName || view.name) : view.name}
              {onSetVisibility && view.visibility === 'workspace' && !isBeingEdited && (
                <Users className="h-3 w-3 opacity-60" aria-label="Shared with the workspace" />
              )}
            </button>
          )

          return (
            <ContextMenu key={view.id}>
              <ContextMenuTrigger>
                {hasTooltipContent ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {tab}
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      align="start"
                      sideOffset={8}
                      className="bg-popover text-popover-foreground border shadow-md rounded-3xl p-3"
                    >
                      <ViewTooltipContent view={view} entityType={entityType} />
                    </TooltipContent>
                  </Tooltip>
                ) : tab}
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => onEditView(view.id)}>
                  <Pencil className="h-4 w-4 mr-2" /> Edit
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onDuplicateView(view.id)}>
                  <Copy className="h-4 w-4 mr-2" /> Duplicate
                </ContextMenuItem>
                {onSetVisibility && (
                  view.visibility === 'workspace' ? (
                    <ContextMenuItem onClick={() => onSetVisibility(view.id, 'personal')}>
                      <Lock className="h-4 w-4 mr-2" /> Make personal
                    </ContextMenuItem>
                  ) : (
                    <ContextMenuItem onClick={() => onSetVisibility(view.id, 'workspace')}>
                      <Users className="h-4 w-4 mr-2" /> Share with workspace
                    </ContextMenuItem>
                  )
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => onDeleteView(view.id)} className="text-destructive">
                  <Trash2 className="h-4 w-4 mr-2" /> Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}

        {/* Draft tab when creating */}
        {editMode === 'create' && (
          <span className={tabClass(true)}>
            <FilterIcon className="h-3 w-3" />
            {draftName || 'New view'}
          </span>
        )}

        {/* Create new view */}
        {!isEditing && (
          <button
            type="button"
            aria-label="Create view"
            onClick={() => onStartCreate?.()}
            className="inline-flex shrink-0 items-center justify-center h-7 w-7 rounded-full border border-dashed border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </TooltipProvider>
  )
}
