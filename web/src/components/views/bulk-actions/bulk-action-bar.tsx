'use client'

import * as React from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Command, CommandInput, CommandList, CommandItem, CommandEmpty, CommandGroup, CommandSeparator,
} from '@/components/ui/command'
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
  X, ChevronLeft, Command as CommandIcon,
  Circle, User, Flag, Folder, Tag, Trash2, Archive,
  Target, Pin, PinOff, FolderInput, Mail, MailOpen, Star, StarOff, Users,
  ArrowRightLeft, Send,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { BULK_ACTIONS, type BulkActionDefinition, type BulkActionId, type StatusByTeamValue } from './types'
import { useWorkspaces } from '@/app/account/workspace-switcher'
import type { ViewEntityType } from '@/lib/views/types'

// Icon mapping from string names to components
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Circle, User, Flag, Folder, Tag, Trash2, Archive,
  Target, Pin, PinOff, FolderInput, Mail, MailOpen, Star, StarOff, Users,
  ArrowRightLeft, Send,
}

// ── Static & dynamic option fetchers ────────────────────────

const PRIORITY_OPTIONS = [
  { id: 'urgent', name: 'Urgent' },
  { id: 'high', name: 'High' },
  { id: 'medium', name: 'Medium' },
  { id: 'low', name: 'Low' },
  { id: 'none', name: 'None' },
]

const STATUS_OPTIONS: Record<string, { id: string; name: string }[]> = {
  initiative: [
    { id: 'planned', name: 'Planned' },
    { id: 'active', name: 'Active' },
    { id: 'completed', name: 'Completed' },
    { id: 'archived', name: 'Archived' },
  ],
  project: [
    { id: 'planned', name: 'Planned' },
    { id: 'active', name: 'Active' },
    { id: 'paused', name: 'Paused' },
    { id: 'completed', name: 'Completed' },
    { id: 'canceled', name: 'Canceled' },
  ],
}

const RELATIONSHIP_OPTIONS = [
  { id: 'contact', name: 'Contact' },
  { id: 'lead', name: 'Lead' },
  { id: 'customer', name: 'Customer' },
  { id: 'partner', name: 'Partner' },
  { id: 'vendor', name: 'Vendor' },
  { id: 'internal', name: 'Internal' },
]

const FOLDER_OPTIONS = [
  { id: 'inbox', name: 'Inbox' },
  { id: 'archive', name: 'Archive' },
  { id: 'starred', name: 'Starred' },
  { id: 'trash', name: 'Trash' },
]

const PICKER_ENDPOINTS: Record<string, { endpoint: string; nameKey: string }> = {
  member: { endpoint: '/api/account/workspace/members', nameKey: 'display_name' },
  project: { endpoint: '/api/account/projects', nameKey: 'name' },
  initiative: { endpoint: '/api/account/initiatives', nameKey: 'name' },
}

// ── Component ───────────────────────────────────────────────

interface BulkActionBarProps {
  entityType: ViewEntityType
  selectedCount: number
  onClear: () => void
  onAction: (actionId: BulkActionId, value?: unknown) => void
  allVisibleIds?: string[]
  onSelectAll?: (ids: string[]) => void
  /** Destructive actions whose confirmation is owned by a richer EXTERNAL
   *  dialog (e.g. the company cascade delete shows a dry-run people count):
   *  the bar keeps their destructive styling but dispatches onAction directly
   *  instead of stacking its generic "N item(s)" confirm in front. */
  skipConfirmActionIds?: BulkActionId[]
}

/**
 * The slab every selection island is made of — a rounded-full glass pill
 * that wraps rather than scrolls when the column is narrow (a split view, the
 * chat open beside it): a second row of pills is still an island, a hidden
 * button is not. Shared with UnifiedViewLayout, which draws a page's own
 * verbs in a SECOND island of the same make above this one.
 */
export const SELECTION_ISLAND_CLASS =
  'flex max-w-full flex-wrap items-center justify-center gap-1 rounded-full border border-border bg-background/95 p-1.5 shadow-lg shadow-black/10 backdrop-blur-xl dark:shadow-black/50'

/**
 * The selection island: what a selection can do, floating over the bottom of
 * the list (UnifiedViewLayout places it; this component is only its face).
 * Liam, 2026-09-06: "take that whole thing and make it a floating component,
 * just like how Linear does this … centered to the width of the main content
 * view, on the bottom of the page … following the same standard we follow
 * with our pill shaped buttons".
 *
 * A rounded-full glass slab holding pills in the tab row's own vocabulary:
 * the count in the FILLED pill (the tab in force), with the clear × inside
 * it; Select all as a quiet text pill; and the Actions pill, which opens the
 * command dialog below. Every consumer of the views layout — actions,
 * projects, CRM, captures, prospect lists — gets the same island, because it
 * is the layout that draws it. A page with verbs of its own (the prospect
 * list's Save, Dismiss, Enrich…) gets them in a second island floating above
 * this one, never mixed into it — see UnifiedViewLayout `selectionActions`.
 */
export function BulkActionBar({
  entityType, selectedCount, onClear, onAction,
  allVisibleIds, onSelectAll, skipConfirmActionIds,
}: BulkActionBarProps) {
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [confirmAction, setConfirmAction] = React.useState<BulkActionDefinition | null>(null)
  // Two-level navigation: null = action list, BulkActionDefinition = option picker
  const [drillAction, setDrillAction] = React.useState<BulkActionDefinition | null>(null)
  // `value`, when set, is what a pick sends (else the option's id).
  const [subOptions, setSubOptions] = React.useState<{ id: string; name: string; color?: string; value?: unknown }[]>([])
  const [subLoaded, setSubLoaded] = React.useState(false)
  // The search text, which is also the tag an "Add tags" drill-in adds.
  const [query, setQuery] = React.useState('')

  // Hooks must run unconditionally — this component mounts with zero selection
  // and re-renders as the count changes, so an early return above a hook call
  // flips the hook order between renders and crashes React.
  const { workspaces } = useWorkspaces()

  if (selectedCount === 0) return null
  // 'Move to workspace...' needs somewhere to move TO; with a single
  // workspace the dialog would render an empty destination picker.
  const actions = (BULK_ACTIONS[entityType] || []).filter(
    (a) => a.id !== 'move_to_workspace' || workspaces.length > 1,
  )
  const nonDestructive = actions.filter(a => !a.destructive)
  const destructive = actions.filter(a => a.destructive)

  const handleActionClick = (action: BulkActionDefinition) => {
    if (action.destructive) {
      setDialogOpen(false)
      setDrillAction(null)
      // Externally-confirmed destructive actions dispatch straight to
      // onAction, which opens the richer dialog that owns the confirmation.
      if (skipConfirmActionIds?.includes(action.id)) {
        onAction(action.id)
        return
      }
      setConfirmAction(action)
      return
    }
    if (action.requiresValue) {
      // Drill into sub-options within the same dialog
      setQuery('')
      setDrillAction(action)
      setSubLoaded(false)
      setSubOptions([])
      loadSubOptions(action)
      return
    }
    // Execute immediately
    setDialogOpen(false)
    setDrillAction(null)
    onAction(action.id)
  }

  const loadSubOptions = (action: BulkActionDefinition) => {
    const vt = action.valueType
    if (!vt) { setSubLoaded(true); return }

    // Static options
    if (vt === 'priority') { setSubOptions(PRIORITY_OPTIONS); setSubLoaded(true); return }
    if (vt === 'relationship_type') { setSubOptions(RELATIONSHIP_OPTIONS); setSubLoaded(true); return }
    if (vt === 'folder') { setSubOptions(FOLDER_OPTIONS); setSubLoaded(true); return }
    // Tags are typed, not picked (the "Add …" row below the input).
    if (vt === 'tags') { setSubLoaded(true); return }
    // The route takes label ids as an ARRAY: each option sends a one-label list.
    if (vt === 'labels') {
      fetch(`/api/account/labels?scope=${encodeURIComponent(entityType)}`)
        .then(r => r.ok ? r.json() : null)
        .then(json => {
          const labels = (json?.labels ?? []) as { id: string; name: string; color?: string }[]
          setSubOptions(labels.map(l => ({ id: l.id, name: l.name, color: l.color, value: [l.id] })))
          setSubLoaded(true)
        })
        .catch(() => setSubLoaded(true))
      return
    }

    if (vt === 'status') {
      if (entityType === 'action') {
        // Fetch workflow states dynamically
        fetch('/api/account/teams')
          .then(r => r.ok ? r.json() : null)
          .then(async (json) => {
            if (!json?.teams?.length) { setSubLoaded(true); return }
            // One option per state NAME, holding every team's own id for it:
            // states are per team, and one team's id written onto another
            // team's action puts it in a column its board doesn't have.
            const byName = new Map<string, { name: string; color?: string; value: StatusByTeamValue }>()
            for (const team of json.teams as { id: string }[]) {
              const res = await fetch(`/api/account/workflow-states?team_id=${team.id}`)
              if (!res.ok) continue
              const statesJson = await res.json()
              for (const s of (statesJson.states || []) as { id: string; name: string; color?: string }[]) {
                let opt = byName.get(s.name)
                if (!opt) {
                  opt = { name: s.name, color: s.color, value: { kind: 'status_by_team', name: s.name, stateIdByTeam: {} } }
                  byName.set(s.name, opt)
                }
                opt.value.stateIdByTeam[team.id] = s.id
              }
            }
            setSubOptions(Array.from(byName.values(), (o) => ({ id: o.name, name: o.name, color: o.color, value: o.value })))
            setSubLoaded(true)
          })
          .catch(() => setSubLoaded(true))
        return
      }
      const staticStatuses = STATUS_OPTIONS[entityType]
      if (staticStatuses) { setSubOptions(staticStatuses); setSubLoaded(true); return }
    }

    // Dynamic entity picker
    const pickerConfig = PICKER_ENDPOINTS[vt]
    if (pickerConfig) {
      fetch(pickerConfig.endpoint)
        .then(r => r.ok ? r.json() : null)
        .then(json => {
          const items = json?.members || json?.projects || json?.initiatives || json?.data || []
          setSubOptions(
            (items as Record<string, unknown>[]).map(item => ({
              id: item.id as string,
              name: item[pickerConfig.nameKey] as string || 'Unknown',
            })),
          )
          setSubLoaded(true)
        })
        .catch(() => setSubLoaded(true))
      return
    }

    setSubLoaded(true)
  }

  const handleSubSelect = (value: unknown) => {
    if (!drillAction) return
    setDialogOpen(false)
    setDrillAction(null)
    onAction(drillAction.id, value)
  }

  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open)
    if (!open) { setDrillAction(null); setQuery('') }
  }

  return (
    <>
      <div
        role="toolbar"
        aria-label="Selection"
        data-bulk-action-island
        className={SELECTION_ISLAND_CLASS}
      >
        {/* The count, in the filled pill the tab row uses for the tab in force,
            with the clear × riding inside it. */}
        <div className="inline-flex h-7 shrink-0 items-center rounded-full bg-foreground pl-3 pr-1 text-xs font-medium text-background">
          <span className="tabular-nums">{selectedCount} selected</span>
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear selection"
            className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-background/70 transition-colors hover:bg-background/20 hover:text-background"
          >
            <X className="h-3 w-3" />
          </button>
        </div>

        {/* Select all — offered while some visible rows are still unchecked. */}
        {allVisibleIds && allVisibleIds.length > selectedCount && onSelectAll && (
          <button
            type="button"
            onClick={() => onSelectAll(allVisibleIds)}
            className="inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Select all ({allVisibleIds.length})
          </button>
        )}

        {/* Actions opens the command dialog below. */}
        {actions.length > 0 && (
          <>
            <div aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <CommandIcon className="h-3.5 w-3.5" />
              Actions
            </button>
          </>
        )}
      </div>

      {/* Unified actions dialog with drill-in sub-options */}
      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="sm:max-w-[360px] p-0 gap-0">
          <DialogHeader className="px-4 pt-4 pb-2">
            <DialogTitle className="text-sm font-medium flex items-center gap-2">
              {drillAction ? (
                <>
                  <button
                    onClick={() => { setDrillAction(null); setQuery('') }}
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors text-xs"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    Back
                  </button>
                  <span className="text-border">/</span>
                  {drillAction.label.replace('...', '')}
                </>
              ) : (
                `${selectedCount} item${selectedCount !== 1 ? 's' : ''} selected`
              )}
            </DialogTitle>
          </DialogHeader>

          <Command className="border-0">
            <CommandInput
              placeholder={drillAction?.valueType === 'tags' ? 'Type a tag...' : drillAction ? 'Search options...' : 'Search actions...'}
              value={query}
              onValueChange={setQuery}
              className="h-9"
            />
            <CommandList className="max-h-72">
              <CommandEmpty>{drillAction ? (subLoaded ? 'No options found.' : 'Loading...') : 'No actions.'}</CommandEmpty>

              {!drillAction ? (
                /* ── Level 1: Action list ─────────────────── */
                <>
                  <CommandGroup>
                    {nonDestructive.map(action => {
                      const Icon = ICON_MAP[action.icon]
                      return (
                        <CommandItem
                          key={action.id}
                          value={action.label}
                          onSelect={() => handleActionClick(action)}
                          className="gap-2"
                        >
                          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
                          <span className="flex-1">{action.label}</span>
                          {action.shortcut && (
                            <span className="text-xs text-muted-foreground">{action.shortcut}</span>
                          )}
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>

                  {destructive.length > 0 && nonDestructive.length > 0 && <CommandSeparator />}

                  {destructive.length > 0 && (
                    <CommandGroup>
                      {destructive.map(action => {
                        const Icon = ICON_MAP[action.icon]
                        return (
                          <CommandItem
                            key={action.id}
                            value={action.label}
                            onSelect={() => handleActionClick(action)}
                            className={cn('gap-2', 'text-destructive')}
                          >
                            {Icon && <Icon className="h-4 w-4" />}
                            <span className="flex-1">{action.label}</span>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  )}

                </>
              ) : (
                /* ── Level 2: Sub-option list ─────────────── */
                <CommandGroup>
                  {/* "None" option for member pickers */}
                  {drillAction.valueType === 'member' && (
                    <CommandItem
                      value="__none__"
                      onSelect={() => handleSubSelect(null)}
                      className="gap-2"
                    >
                      <span className="text-muted-foreground">No one</span>
                    </CommandItem>
                  )}
                  {drillAction.valueType === 'tags' && query.trim() && (
                    <CommandItem
                      value={query.trim()}
                      onSelect={() => handleSubSelect([query.trim()])}
                      className="gap-2"
                    >
                      <span>Add tag &ldquo;{query.trim()}&rdquo;</span>
                    </CommandItem>
                  )}
                  {subOptions.map(opt => (
                    <CommandItem
                      key={opt.id}
                      value={opt.name}
                      onSelect={() => handleSubSelect(opt.value ?? opt.id)}
                      className="gap-2"
                    >
                      {opt.color && <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: opt.color }} />}
                      <span className="capitalize">{opt.name.replace(/_/g, ' ')}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      {/* Destructive action confirmation */}
      <AlertDialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.label} {selectedCount} item{selectedCount !== 1 ? 's' : ''}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.id === 'delete'
                ? `This will permanently delete ${selectedCount} item${selectedCount !== 1 ? 's' : ''}. This action cannot be undone.`
                : `This will ${confirmAction?.label.toLowerCase()} ${selectedCount} item${selectedCount !== 1 ? 's' : ''}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(confirmAction?.destructive && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}
              onClick={() => {
                if (confirmAction) onAction(confirmAction.id)
                setConfirmAction(null)
              }}
            >
              {confirmAction?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
