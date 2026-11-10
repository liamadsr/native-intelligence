'use client'

import * as React from 'react'
import { format, parseISO, startOfDay } from 'date-fns'
import { ThinkingOrb } from 'thinking-orbs'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { AlarmClock, Building2, Check, CircleDollarSign, ChevronRight, ExternalLink, EyeOff, FileText, FlaskConical, Linkedin, Loader2, Play, Send, Target, Telescope, Users, X, Zap } from 'lucide-react'
import { ProjectIcon, isEmoji } from '@/components/ui/emoji-icon-picker'
import { DealCell } from './deal-cells'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { emitAddToSequence } from '@/components/sequences/add-to-sequence-dialog'
import {
  EXIT_REASON_META,
  SEQUENCE_STATUS_META,
  describeEnrollmentProgress,
  humanizeSendTime,
  replyRate,
  timezoneAbbreviation,
} from '@/lib/sequences/ui-helpers'
import { OutcomeChip } from '@/app/account/(dashboard)/evals/outcome-chip'
import {
  MODE_LABELS,
  dimensionTally,
  dimensionTallyText,
  formatCost as formatEvalCost,
  formatDuration as formatEvalDuration,
  formatRunWhen,
  runLabel,
} from '@/app/account/(dashboard)/evals/ui-helpers'
import { LIBRARY_CATEGORY_ICONS } from '@/lib/types/library-icons'
import { ReminderPickerContent } from '@/components/reminders/reminder-picker'
import { RowWorkspaceBadge } from '../workspace-badge'
import { EntityActionsMenuItems, useEntityRenameDialog } from '@/components/entities/entity-actions-menu'
import { isArchivedRow, supportedEntityActions } from '@/lib/entities/entity-actions-registry'
import { DelegateWorkBadge } from '@/components/work/delegate-work-badge'
import type { ReminderEntityType } from '@/lib/reminders/types'
import { cn } from '@/lib/utils'
import { DISPLAY_PROPERTIES } from '@/lib/views/types'
import type { ViewEntityType, EditableDescriptor } from '@/lib/views/types'
import {
  RELATIONSHIP_TYPE_OPTIONS, RELATIONSHIP_STRENGTH_OPTIONS,
  EMPLOYEE_COUNT_OPTIONS, EMAIL_FOLDER_OPTIONS,
  PROJECT_STATUS_OPTIONS, INITIATIVE_STATUS_OPTIONS,
  STRENGTH_COLORS,
} from '@/lib/views/property-options'
import {
  PriorityCellTrigger, StatusCellTrigger, MemberCellTrigger,
  ProjectCellTrigger, InitiativeCellTrigger, CompanyCellTrigger,
  LabelCellTrigger, DateCellTrigger, EnumCellTrigger,
  BooleanCellTrigger, TextEditCellTrigger,
  type PickerContext, type AttachedLabel,
} from '@/components/views/properties'
import { cancelHoverPrefetch, prefetchDetailOnHoverIntent } from '@/components/views/detail-prefetch'
import { entryEvidenceUrl, hostOf } from '@/lib/prospecting/evidence'
import {
  foundOnlyKnownPeople,
  knownPeopleLines,
  knownPeopleSummary,
  readPeopleSearch,
} from '@/lib/prospecting/people-search'
import { fitLabel } from '@/lib/prospecting/fit'
import { useProspectListActivity } from '@/lib/prospecting/list-activity'
import {
  FIT_UNSCORED_CLASS,
  FIT_UNSCORED_TITLE,
  fitScoreClass,
  FIT_SCORE_UNIT,
  fitScoreTitle,
} from '@/lib/prospecting/fit-display'
import { PROSPECT_PURPOSE_LABELS } from '@/lib/prospecting/types'
import type { ProspectListPurpose } from '@/lib/prospecting/types'
import {
  lastRunOf,
  runNewCount,
  runTimestamp,
  type LastRun,
} from '@/lib/prospecting/run-summary'
import { ActionPlatformCell } from '@/components/tasks/action-platform-cell'

/** Signature of the patch callback: item id + partial field updates to PATCH. */
export type PatchItemFn = (id: string, fields: Record<string, unknown>) => void

/**
 * Row kinds that can carry a reminder. `ViewEntityType` is the wider set (it
 * includes contacts, companies, email threads and flows, which reminders do not
 * cover) so the two enums are narrowed here rather than cast — a row of an
 * unsupported kind simply gets no context menu, and adding a kind to the
 * reminder CHECK constraint is the only thing that widens this.
 *
 * Only the three list surfaces Linear exposes ⇧H on are mounted for now;
 * captures and documents are supported by the schema and would only need to be
 * added here once their lists get the same affordance.
 */
const REMINDABLE_ROW_TYPES = ['action', 'project', 'initiative'] as const

function remindableEntityType(entityType: ViewEntityType): ReminderEntityType | null {
  return (REMINDABLE_ROW_TYPES as readonly string[]).includes(entityType)
    ? (entityType as ReminderEntityType)
    : null
}

interface EntityRowProps {
  item: Record<string, unknown>
  entityType: ViewEntityType
  displayProperties: string[]
  isSelected: boolean
  /**
   * Row activation. Must be referentially stable (the parent already memoizes
   * it) so `React.memo` can skip re-rendering rows on unrelated parent updates
   * — the click/aux-click handlers are derived from it internally. Passing a
   * fresh inline closure here would defeat the memo.
   */
  onItemSelect: (id: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>) => void
  /** Whether this item is checked for bulk selection */
  isChecked?: boolean
  /** Whether bulk selection mode is active (any items checked) */
  selectionActive?: boolean
  /** Toggle bulk selection for this item */
  onToggleCheck?: (id: string) => void
  /**
   * When provided, properties marked `editable` in DISPLAY_PROPERTIES render
   * as pickers that invoke `onPatch(itemId, { apiField: newValue })`.
   * When omitted, every property renders as a read-only chip (legacy behavior).
   */
  onPatch?: PatchItemFn
  /** Lookup data for pickers — members, projects, workflow states per team, etc. */
  pickerContext?: PickerContext
  /** Gate editing per row/field. Defaults to "editable if onPatch provided". */
  canEdit?: (item: Record<string, unknown>, field: string) => boolean
  /** Nesting depth (0 = top-level); used by tree-expand views to indent children. */
  depth?: number
  /** Whether this row has expandable children (from item.has_children). */
  hasChildren?: boolean
  /** Whether the row is currently expanded (its children are rendered below). */
  isExpanded?: boolean
  /** Called when the user toggles the chevron. */
  onToggleExpand?: (id: string) => void
  /**
   * This row entered or left compose mode.
   *
   * The row is inside a VIRTUALIZED list, whose slots are absolutely positioned
   * at a fixed height — so a row that silently grows into the compose strip
   * draws over its neighbours instead of pushing them down. The list needs to
   * know which row is composing in order to size that one slot; the row cannot
   * fix this on its own.
   *
   * Takes the row ID so the list can pass ONE stable callback to every row.
   * It is depended on by an unmount effect below, so a per-row closure would
   * re-run that effect on every render and cancel compose immediately.
   */
  onComposeChange?: (itemId: string, composing: boolean) => void
}

function EntityRowImpl({
  item, entityType, displayProperties, isSelected, onItemSelect,
  isChecked, selectionActive, onToggleCheck,
  onPatch, pickerContext, canEdit,
  depth = 0, hasChildren, isExpanded, onToggleExpand, onComposeChange,
}: EntityRowProps) {
  const itemId = item.id as string
  const showCheckbox = selectionActive || isChecked

  /**
   * Compose mode, readable SYNCHRONOUSLY.
   *
   * Mirrors the `composing` state below. It exists because the row's click
   * handler has to know the answer during the same event batch in which compose
   * was entered — see `onClick`, where a stale render-scope value would let the
   * click through and undo the pick.
   */
  const composingRef = React.useRef(false)

  /**
   * The reminder context menu is open (or was open a moment ago and is closing).
   * A ref rather than state for exactly the reason `composingRef` is: the click
   * that dismisses the menu is dispatched in the same batch as the close, so a
   * render-scope boolean would still read `false` and let the row activate.
   * It is cleared on a timeout, not synchronously, so the trailing click has
   * already been swallowed by the time the row is a link again.
   */
  const menuOpenRef = React.useRef(false)
  const menuCloseTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleMenuOpenChange = React.useCallback((open: boolean) => {
    if (menuCloseTimer.current) clearTimeout(menuCloseTimer.current)
    if (open) {
      menuOpenRef.current = true
      return
    }
    // Outlive the dismissal click, then let the row be a link again.
    menuCloseTimer.current = setTimeout(() => { menuOpenRef.current = false }, 0)
  }, [])
  React.useEffect(
    () => () => { if (menuCloseTimer.current) clearTimeout(menuCloseTimer.current) },
    [],
  )

  // Derive the click handlers from the stable `onItemSelect` + this row's own
  // (stable) identity. Building them here — rather than as inline closures in
  // the parent — keeps `React.memo` below effective across parent re-renders.
  const onClick = React.useCallback(
    (e: React.MouseEvent) => {
      // A ROW IN COMPOSE MODE IS NOT A LINK.
      //
      // Picking a provider in the mark's menu ends with Radix closing that menu
      // through `flushSync` + a synthetic click, and that click lands on the
      // ROW — the menu's own DOM is already gone by the time it dispatches, so
      // there is nothing left to stop it at the source. The row then did what a
      // row click does and opened the detail panel, which unmounted the strip
      // that the very same gesture had just mounted. Compose entered and was
      // destroyed in one commit, so picking Jira on a list row looked like a
      // dead click that merely opened the panel — the reported bug.
      //
      // Reading the flag at CALL time (not closing over it) is what makes this
      // correct on the very first such click: `composing` flips in the same
      // batch, and a stale closure would still see `false`.
      if (composingRef.current) return
      // Same story for the reminder context menu: dismissing it ends with a
      // click that Radix lets through to the element underneath — which is the
      // row, because the row IS the trigger. Without this, picking "Tomorrow"
      // would save the reminder AND open the detail panel.
      if (menuOpenRef.current) return
      onItemSelect(itemId, getTitle(entityType, item), e, item)
    },
    [onItemSelect, itemId, entityType, item],
  )
  const onAuxClick = React.useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault()
        onItemSelect(itemId, getTitle(entityType, item), e, item)
      }
    },
    [onItemSelect, itemId, entityType, item],
  )

  // Filter out 'identifier' from display properties for actions since it's shown in the leading area
  const filteredProps = entityType === 'action'
    ? displayProperties.filter(p => p !== 'identifier')
    : displayProperties

  /**
   * COMPOSE MODE — the row's property strip becomes the push form.
   *
   * The row tracks only WHETHER compose is on; the form itself is rendered by
   * `ActionPlatformCell` (the menu hands it back through `renderCompose`), and
   * the cell's own grid position is what puts it across the row. Tracking the
   * boolean here is what lets the row take its property chips DOWN — the two
   * sets mean different things (what this action IS, versus where this push is
   * going) and a row cannot hold both without doubling its width. They come
   * back the moment compose ends, because this is state and not a navigation.
   *
   * `React.useState` in a component that early-returns per entityType would be
   * a hooks-order violation, so it lives here at the top level and costs
   * non-action rows one unused slot.
   */
  const [composing, setComposing] = React.useState(false)

  /**
   * Set the row's own flag AND tell the list, which owns the slot height.
   *
   * One funnel so the two can never disagree — a row drawing the strip while
   * the virtualizer still believes it is 40px tall is exactly the overlap this
   * fixes.
   */
  const handleComposeChange = React.useCallback(
    (next: boolean) => {
      // The ref FIRST, and synchronously: the click that ends the menu is
      // dispatched inside the same batch as this call, and it reads the ref.
      composingRef.current = next
      setComposing(next)
      onComposeChange?.(itemId, next)
    },
    [onComposeChange, itemId],
  )

  // Leaving compose by UNMOUNT — the row scrolled out of the virtualizer's
  // window, or the list re-filtered underneath an open form — still has to
  // release the tall slot, or the gap outlives the form that justified it.
  //
  // Both dependencies are stable (the list memoizes the callback; the id is
  // this row's identity), so this effect runs exactly once per mount. That
  // matters: a changing dependency here would run the CLEANUP mid-compose and
  // end it on the next render.
  React.useEffect(
    () => () => {
      if (composingRef.current) onComposeChange?.(itemId, false)
    },
    [onComposeChange, itemId],
  )

  /**
   * Right-click → "Remind me".
   *
   * Radix's ContextMenu root is UNCONTROLLED by design — it exposes no `open`
   * prop, because the browser's contextmenu event is the only thing that opens
   * it. So the picker, which lives inside the submenu and finishes on its own
   * `onDone`, has no controlled state to flip: a cmdk row is not a
   * ContextMenuItem, so Radix never hears the selection and the menu hangs
   * open over a reminder that already saved.
   *
   * Escape is the dismissal Radix DOES listen for, on the content it has
   * focused. Remounting the menu with a `key` would close it too, but the row
   * is the trigger's `asChild` child — remounting would tear the row's DOM
   * down mid-interaction and fire its compose-unmount effect. Dispatching the
   * key event leaves the entire tree in place.
   */
  const menuRef = React.useRef<HTMLDivElement | null>(null)
  const closeMenu = React.useCallback(() => {
    const target = menuRef.current ?? document.activeElement
    target?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
  }, [])
  const reminderEntityType = remindableEntityType(entityType)

  // The one entity actions menu, on the row's right-click (entity-actions-menu.tsx).
  const rowTitle = getTitle(entityType, item)
  const rowWorkspaceId = typeof item.workspace_id === 'string' ? item.workspace_id : null
  const entityRef = React.useMemo(
    () => ({ type: entityType, id: itemId, label: rowTitle, workspaceId: rowWorkspaceId }),
    [entityType, itemId, rowTitle, rowWorkspaceId],
  )
  const rowArchived = isArchivedRow(entityType, item)
  const rowStatus = typeof item.status === 'string' ? item.status : null
  const entityMenuState = React.useMemo(() => ({ archived: rowArchived, status: rowStatus }), [rowArchived, rowStatus])
  const hasEntityActions = supportedEntityActions(entityType).some((a) => a !== 'open')
  const { openRename, renameDialog } = useEntityRenameDialog(entityRef)

  const row = (
    <div
      // A capture's row, for UI automation (src/lib/automation/README.md).
      {...(entityType === 'capture' ? { 'data-testid': 'capture-row', 'data-capture-id': itemId } : {})}
      onClick={onClick}
      onAuxClick={onAuxClick}
      // Warm the detail-panel cache so clicking through feels instant — once
      // the pointer RESTS on the row (~100ms), so sweeping the cursor down a
      // list warms only the rows it stops on. Deduped + cached inside, so a row
      // costs at most one request per session.
      onMouseEnter={() => prefetchDetailOnHoverIntent(entityType, item)}
      onMouseLeave={() => cancelHoverPrefetch(item)}
      style={depth > 0 ? { paddingLeft: `${16 + depth * 20}px` } : undefined}
      className={cn(
        'group flex items-center gap-2 px-4 py-2 transition-colors text-sm rounded-lg',
        // The row is only a click target while it is a ROW. In compose mode the
        // pointer belongs to the fields, and a grab cursor over a date input is
        // a lie about what the click will do.
        composing ? 'cursor-default' : 'cursor-pointer',
        // `overflow-hidden` keeps long titles from bleeding past the rounded
        // corners — but it also clips the compose strip's project popover, which
        // opens BELOW the field. The strip owns its own overflow (it is the
        // horizontal scroller), so the row yields while it is up.
        composing ? 'overflow-visible' : 'overflow-hidden',
        'hover:bg-muted/50',
        isSelected && 'bg-muted',
        isChecked && 'bg-primary/5',
      )}
    >
      {/* Chevron (tree expand) — always rendered at fixed width so rows align */}
      {onToggleExpand && (
        <div className="shrink-0 w-4 -ml-1">
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleExpand(itemId) }}
              className="h-4 w-4 flex items-center justify-center text-muted-foreground hover:text-foreground"
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
            >
              <ChevronRight className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')} />
            </button>
          )}
        </div>
      )}

      {/* Checkbox: visible on hover or when selection is active */}
      <div
        className={cn(
          'shrink-0 flex items-center justify-center w-5 h-5 -ml-1',
          showCheckbox ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
        onClick={(e) => {
          e.stopPropagation()
          onToggleCheck?.(itemId)
        }}
      >
        <Checkbox
          checked={isChecked}
          onCheckedChange={() => onToggleCheck?.(itemId)}
          className="h-4 w-4 cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      <EntityLeading
        entityType={entityType}
        item={item}
        composing={composing}
        onComposeChange={handleComposeChange}
      />
      {/* PROSPECT CANDIDATES compose their own body — see ProspectEntryRowBody
          for why the generic title + chip-strip layout cannot hold a sentence
          without eating the company name. Every other entity type falls
          through to the path below, unchanged. */}
      {entityType === 'prospect_list' ? (
        // A LIST is not a candidate: two of its three numbers come from an
        // enrichment object and an embedded run rather than from columns, so
        // the generic chip strip would render them blank. See the body's own
        // doc for why.
        <ProspectListRowBody item={item} displayProperties={filteredProps} />
      ) : entityType === 'prospect_list_entry' ? (
        // PEOPLE AND COMPANIES ARE DIFFERENT ROWS, not one row with some cells
        // blanked. A person has no domain, no fit tier (fit lives on the
        // account it hangs off) and two facts a company row has no slot for —
        // whether we could verify the employer, and whether we have an email —
        // so a shared body would be four `kind === 'person'` branches deep and
        // would still leave the People tab looking like a company list with
        // holes in it.
        item.kind === 'person' ? (
          <ProspectPersonRowBody item={item} displayProperties={filteredProps} />
        ) : (
          <ProspectEntryRowBody item={item} displayProperties={filteredProps} />
        )
      ) : (
      <>
      {/* The title stays put while composing — it is what the row IS, and losing
          it would leave a line of dropdowns with nothing saying which action
          they belong to. It gives up its flex-1 so the strip gets the width. */}
      {/* `min-w-[8rem]` is a FLOOR, not a width. `flex-1 min-w-0` alone lets a
          wide `shrink-0` chip group starve the title to nothing — observed on
          a prospect row whose `fit_rationale` was a full sentence and rendered
          the company name as "Q…". Prospect rows now compose their own body
          above and no longer reach this path, but the same starvation is
          reachable by any entity whose chips get wide (a long project name, a
          full label set), so the floor stays: a flex item's min-width wins over
          its siblings' shrink-0, and the name is the last thing to give. */}
      <span
        className={cn(
          'truncate min-w-0 font-medium',
          composing ? 'max-w-[200px] shrink-0' : 'flex-1 min-w-[8rem]',
        )}
      >
        {entityType === 'flow' && flowBotName(item) ? (
          // Its bot's name first, the loop's name under it (bots-v3 Phase 3).
          <span className="flex min-w-0 flex-col leading-tight" data-flow-bot-title="">
            <span className="truncate">{flowBotName(item)}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">{getTitle(entityType, item)}</span>
          </span>
        ) : (
          getTitle(entityType, item)
        )}
        {entityType === 'contact' && pickerContext?.currentMemberId && pickerContext.currentMemberId === (item.member_id as string) && (
          <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0 align-middle">Me</Badge>
        )}
        {/* Only the creator is ever served a private capture or document row
            (migrations 223 and 369), so this is a reminder, not an access
            signal. `visibility` is optional on the row: a list fetched before
            the column shipped simply has no badge. */}
        {(entityType === 'capture' || entityType === 'document') && item.visibility === 'private' && (
          <EyeOff
            className="ml-1.5 inline h-3 w-3 shrink-0 align-middle text-muted-foreground"
            aria-label={`Only you can see this ${entityType}`}
          >
            <title>{`Only you can see this ${entityType}`}</title>
          </EyeOff>
        )}
        {/* Where this row lives, when that isn't where the user is. Draws
            nothing at all in the ordinary single-workspace list — see
            RowWorkspaceBadge, which owns the rule. It sits INSIDE the title
            span so it travels with the title's truncation rather than
            competing with the property chips for the row's width. */}
        <RowWorkspaceBadge item={item} className="ml-1.5" />
        {/* An agent working the action as its delegate: where its job stands
            ("step 3 of 5", or "working" for a teammate who can't see the job). */}
        {entityType === 'action' && !!item.assignee_ai_member_id && (
          <DelegateWorkBadge
            actionId={item.id as string}
            agentRunStatus={item.agent_run_status as string | null | undefined}
            className="ml-1.5"
          />
        )}
      </span>
      {/* The Dial8 chips, DOWN while the push form is up. `EntityLeading` is
          drawing the form itself (see its `onComposeChange` doc) — this side
          only has to get out of its way. */}
      {/* `shrink-0` keeps the chips at their natural width — correct for the
          fixed-shape chips every entity on this path shows. `min-w-0` lets a
          cell that sets its own `max-w`/`truncate` actually bind, instead of
          the group forcing the row wider than the title can survive. */}
      {!composing && (
        <div className="flex min-w-0 items-center gap-1.5 shrink-0">
          {filteredProps.map(prop => (
            <PropertyCell
              key={prop}
              item={item}
              property={prop}
              entityType={entityType}
              onPatch={onPatch}
              pickerContext={pickerContext}
              canEdit={canEdit}
            />
          ))}
        </div>
      )}
      </>
      )}
    </div>
  )

  // Contact rows carry an "Add to sequence" item (the mounted contact list —
  // unified-view-layout — listens for the event and opens the shared picker).
  const hasSequenceItem = entityType === 'contact'

  // Rows with no menu content render exactly as before — no Radix wrapper,
  // no extra state cost, and no change to any existing interaction.
  if (!reminderEntityType && !hasSequenceItem && !hasEntityActions) return row

  return (
    <>
    <ContextMenu modal={false} onOpenChange={handleMenuOpenChange}>
      {/* `asChild`: the row IS the trigger. A wrapper element here would sit
          between the virtualizer's slot and the flex row and break the layout. */}
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent ref={menuRef} className="w-48">
        {reminderEntityType && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <AlarmClock className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
              Remind me
              {/* `mr-2`: SubTrigger appends its own `ml-auto` chevron, and the
                  shortcut's `ml-auto` eats the free space first — without this
                  the two glyphs end up touching. */}
              <ContextMenuShortcut className="mr-2">⇧H</ContextMenuShortcut>
            </ContextMenuSubTrigger>
            {/* p-0 because the Command inside brings its own padding. */}
            <ContextMenuSubContent className="w-[360px] p-0">
              <ReminderPickerContent
                entityType={reminderEntityType}
                entityId={itemId}
                onDone={closeMenu}
              />
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {hasSequenceItem && (
          <ContextMenuItem onSelect={() => emitAddToSequence([itemId])}>
            <Send className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
            Add to sequence
          </ContextMenuItem>
        )}
        {/* The one entity actions menu (Open is the row's own click). */}
        {hasEntityActions && (
          <EntityActionsMenuItems
            entity={entityRef}
            state={entityMenuState}
            variant="context"
            omit={ROW_OMIT}
            onRename={openRename}
            leadingSeparator={!!reminderEntityType || hasSequenceItem}
            from="list_row"
          />
        )}
      </ContextMenuContent>
    </ContextMenu>
    {renameDialog}
    </>
  )
}

/** A list row's menu leaves out Open: a click on the row opens it, in its list's own way. */
const ROW_OMIT = ['open'] as const

/**
 * Memoized so an unrelated parent re-render (e.g. a realtime UPDATE patch that
 * swaps the data array reference) only re-renders the rows whose props actually
 * changed — not all ~500 rows a grouped view can mount. This relies on every
 * prop being referentially stable per row: the callers pass memoized handlers,
 * and the row derives its own click handlers from the stable `onItemSelect`
 * (see the prop doc above). Default shallow comparison is correct here.
 */
export const EntityRow = React.memo(EntityRowImpl)

/** A loop row's bot name (its embedded teammate), or null when it has none the reader can see. */
function flowBotName(item: Record<string, unknown>): string | null {
  const name = (item.bot as { name?: unknown } | null | undefined)?.name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

export function getTitle(entityType: ViewEntityType, item: Record<string, unknown>): string {
  switch (entityType) {
    case 'agent':
    case 'skill':
      return (item.name as string) || 'Untitled'
    case 'action': return (item.title as string) || 'Untitled'
    case 'capture': return (item.title as string) || 'Untitled Capture'
    case 'contact': return (item.full_name as string) || 'Unknown'
    case 'company': return (item.name as string) || 'Unknown'
    case 'deal': return (item.name as string) || 'Untitled deal'
    // No stored subject (344): a sender-based title.
    case 'email_thread': return item.from_email ? `Email from ${item.from_email as string}` : 'Email'
    case 'document': return (item.title as string) || 'Untitled'
    case 'initiative': return (item.name as string) || 'Untitled'
    case 'project': return (item.name as string) || 'Untitled'
    case 'flow': return (item.name as string) || 'Untitled flow'
    case 'sequence': return (item.name as string) || 'Untitled sequence'
    case 'eval_suite': return (item.name as string) || 'Untitled suite'
    case 'eval_case': return (item.name as string) || 'Untitled case'
    // A CLAIM HAS NO NAME — its text IS the claim, and it is a sentence rather
    // than a label. It is returned whole: the row clamps it with CSS, and the
    // detail breadcrumb and tab label read this same string, so truncating here
    // would put an ellipsis everywhere the claim is ever named. Whitespace is
    // collapsed because extracted text carries newlines from its source
    // document, and a raw newline in a one-line row renders as a gap.
    case 'claim':
      return ((item.text as string) || '').replace(/\s+/g, ' ').trim() || 'Empty claim'
    case 'eval_run':
      // A RUN HAS NO NAME COLUMN. `runLabel` composes its identity out of the
      // mode and the absolute start time — "Batch run · Sep 8, 3:38 PM" — the
      // same helper the suite page's run rows, the tab bar and Recently viewed
      // all use, so one run never reads as two different things depending on
      // which screen reached it.
      return runLabel({
        mode: (item.mode as 'batch' | 'live') ?? 'batch',
        started_at: (item.started_at as string | null) ?? null,
      })
    // A list has a real `name` column with a NOT NULL + unique-per-workspace
    // constraint behind it, so the fallback is a formality — but the title
    // feeds the tab label and the detail breadcrumb, and neither may be blank.
    case 'prospect_list': return (item.name as string) || 'Untitled list'
    case 'prospect_list_entry': {
      // The candidate's identity lives in the `candidate` jsonb (the entry row
      // has no name column — it is not a CRM record until it is saved).
      // Name, then domain, then the key it was deduped under — so a company
      // Exa named but could not resolve still reads as something, and a title
      // is NEVER empty (the panel breadcrumb and the tab label both read this).
      //
      // A PERSON falls back to its TITLE before its key: an unnamed person
      // whose card gave "VP of Revenue Operations" is legible, whereas the
      // key it was deduped under is a linkedin slug or an email — technically
      // unique and useless as a heading.
      const c = (item.candidate ?? {}) as { name?: string; domain?: string; title?: string }
      const key = typeof item.candidate_key === 'string' ? item.candidate_key : ''
      if (item.kind === 'person') {
        return c.name?.trim() || c.title?.trim() || key.trim() || 'Unknown person'
      }
      return c.name?.trim() || c.domain?.trim() || key.trim() || 'Unknown candidate'
    }
  }
}

function getInitials(name: string): string {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
}

function EntityLeading({
  entityType,
  item,
  composing = false,
  onComposeChange,
}: {
  entityType: ViewEntityType
  item: Record<string, unknown>
  /** The row is in compose mode — the leading slot yields its fixed width. */
  composing?: boolean
  /**
   * Compose mode began or ended, so the row can take its property chips down.
   * The FORM is rendered here (it is the platform cell's own output); this only
   * tells the row to make room.
   */
  onComposeChange?: (composing: boolean) => void
}) {
  switch (entityType) {
    case 'action': {
      // Platform mark, then identifier: whose item is this, then which item is
      // it. Both sit in FIXED-WIDTH slots so the titles beside them line up down
      // the list. The mark's own width is not fixed — the stack grows ~8px per
      // extra provider (14px marks overlapped by 6px), and an action in two
      // trackers would otherwise push its identifier and title right of its
      // neighbours' — so it gets a 30px slot, the widest the current three
      // providers can produce, and left-aligns inside it. A fourth pushable
      // provider would make MAX_STACKED/'+N' reachable and this width would need
      // revisiting.
      //
      // COMPOSE is rendered by the cell but must NOT be confined to the 30px
      // slot — it is a full-width strip. The menu returns trigger and form as
      // siblings, so the cell as a whole becomes a `display: contents` wrapper:
      // the mark lands in its fixed column, the strip lands directly on the
      // ROW's flex line beside it, and the row's left edge never shifts when
      // compose opens. `contents` is what lets one component emit children into
      // two different layout positions without a portal.
      return (
        <>
          <span
            className={cn(
              'flex shrink-0 items-center',
              // Only a column when there is nothing else to place. In compose
              // mode the wrapper has to disappear from layout entirely so the
              // strip can take the row's width.
              composing ? 'contents' : 'w-[30px]',
            )}
          >
            <ActionPlatformCell
              item={item}
              onCompose={(node) => node}
              onComposeStart={(provider) => onComposeChange?.(provider !== null)}
            />
          </span>
          {!composing && (
            <span className="text-[11px] text-muted-foreground font-mono w-14 truncate shrink-0">{item.identifier as string}</span>
          )}
        </>
      )
    }
    case 'email_thread':
      return item.is_unread ? <span className="h-2 w-2 rounded-full bg-blue-500 shrink-0" /> : <span className="w-2 shrink-0" />
    case 'contact':
      return (
        <Avatar className="h-6 w-6 shrink-0">
          <AvatarFallback className="text-[10px]">{getInitials((item.full_name as string) || '?')}</AvatarFallback>
        </Avatar>
      )
    case 'company':
      return <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
    case 'deal': {
      const kind = (item.stage as { kind?: string } | null)?.kind
      return (
        <CircleDollarSign
          className={cn('h-4 w-4 shrink-0', kind === 'won' ? 'text-emerald-500' : kind === 'lost' ? 'text-muted-foreground/50' : 'text-muted-foreground')}
        />
      )
    }
    case 'capture':
      return <span className="text-sm shrink-0">📹</span>
    case 'document':
      return <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
    case 'project':
      return <ProjectIcon icon={item.icon as string | null} size="sm" />
    case 'initiative': {
      const icon = item.icon as string | null
      if (icon && isEmoji(icon)) return <span className="text-sm shrink-0">{icon}</span>
      return <Target className="h-4 w-4 text-muted-foreground shrink-0" />
    }
    case 'flow': {
      // A loop's lightning glyph, tinted by enabled state.
      const enabled = item.enabled !== false
      return (
        <Zap
          className={cn('h-4 w-4 shrink-0', enabled ? 'text-amber-500' : 'text-muted-foreground/50')}
        />
      )
    }
    case 'prospect_list_entry': {
      // Telescope glyph (same as the nav rail's Prospecting item), tinted by
      // stage: emerald once saved, muted once dismissed.
      const stage = item.stage as string | undefined
      // A PERSON gets the same initials avatar a CRM contact gets, for the
      // reason the People tab exists at all: it is a roster of people, and a
      // column of identical telescopes reads as a column of search results.
      // The avatar is also what makes the two tabs distinguishable at a
      // glance when a user lands on the wrong one.
      if (item.kind === 'person') {
        const person = (item.candidate ?? {}) as { name?: string }
        return (
          <Avatar className="h-6 w-6 shrink-0">
            <AvatarFallback
              className={cn(
                'text-[10px]',
                stage === 'dismissed' && 'text-muted-foreground/50',
              )}
            >
              {getInitials(person.name?.trim() || '?')}
            </AvatarFallback>
          </Avatar>
        )
      }
      return <ProspectCompanyGlyph domain={rowCandidate(item).domain ?? ''} stage={stage} />
    }
    case 'prospect_list': {
      // Telescope, tinted SKY while a run is in flight — the same colour the
      // "N runs active" header pill and the pulsing dot on the row body use,
      // so a scanning eye picks the working lists out of the column without
      // reading a word.
      //
      // Two sources, because they answer at different speeds: the module store
      // is the index page's 5-second active-run poll (what catches a run Scout
      // starts beside this list), and the row's own embedded newest run is the
      // fallback that makes the glyph correct before the first poll settles —
      // and on any surface that mounts these rows without publishing.
      return <ProspectListGlyph item={item} />
    }
    case 'eval_suite': {
      // The Library's own category glyph for what the suite grades, so an
      // agent suite and a skill suite are distinguishable at a glance and read
      // as the same thing they do on the Library page.
      const Icon = LIBRARY_CATEGORY_ICONS[item.target_kind === 'skill' ? 'skill' : 'agent']
      return <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    }
    case 'eval_case': {
      // A flask, tinted by POLARITY — the one fact about a case that changes
      // what its result means. A negative control expects the agent to do
      // NOTHING, so a green result on it and a green result on a positive case
      // are opposite claims; the amber tint is what stops the two reading as
      // the same row while scanning. Same idiom as the flow Zap and the
      // sequence Send: the glyph carries the state, not a second chip.
      const negative = item.polarity === 'negative'
      return (
        <FlaskConical
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            negative ? 'text-amber-500' : 'text-muted-foreground',
          )}
        />
      )
    }
    case 'eval_run': {
      // A play glyph, tinted only by liveness. NOT an OutcomeChip: the run's
      // verdict is a property cell with its own colour vocabulary, and putting
      // a second coloured verdict in the leading slot would give one row two
      // chips saying the same thing in two shapes.
      const live = item.is_live === true
      return (
        <Play
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            live ? 'text-emerald-500' : 'text-muted-foreground/70',
          )}
        />
      )
    }
    case 'sequence': {
      // Send glyph tinted by lifecycle state (mirrors the flow Zap): green =
      // actively sending, amber = paused, muted = draft/archived.
      const status = item.status as string | undefined
      return (
        <Send
          className={cn(
            'h-4 w-4 shrink-0',
            status === 'active'
              ? 'text-emerald-500'
              : status === 'paused'
                ? 'text-amber-500'
                : 'text-muted-foreground/50',
          )}
        />
      )
    }
    default:
      return null
  }
}

/**
 * The leading glyph on a COMPANY candidate row: the company's own favicon.
 *
 * WHY A FAVICON AND NOT THE TELESCOPE IT REPLACES. A column of twenty
 * identical telescopes carries no information — every row on this page is a
 * prospect, so the icon that says "prospect" says nothing. The favicon is the
 * one thing about the row a user recognises before reading, which is what a
 * leading icon is for, and it makes the list scan like a list of companies
 * rather than a list of search results.
 *
 * IT IS THE COMPANY'S OWN DOMAIN, never the citation host. The trailing
 * citation link (gated behind "Why") shows the favicon of the page that
 * SURFACED the candidate — a TechCrunch article, a directory — which is a
 * different fact and would be a lie in the identity slot.
 *
 * THE FALLBACK IS THE OLD TELESCOPE, stage-tinted exactly as before, for the
 * two cases a favicon cannot cover: an unresolved candidate with no domain at
 * all, and a domain whose favicon 404s or is blocked. Both are common enough
 * that a broken-image glyph would show up on real lists, and the tinted
 * telescope still carries the saved/dismissed state the favicon cannot.
 */
function ProspectCompanyGlyph({
  domain,
  stage,
}: {
  domain: string
  stage: string | undefined
}) {
  // Keyed off the domain so recycling a row onto a different company retries
  // the fetch instead of inheriting the previous row's failure.
  const [failed, setFailed] = React.useState(false)
  React.useEffect(() => {
    setFailed(false)
  }, [domain])

  const trimmed = domain.trim()
  if (trimmed && !failed) {
    return (
      <img
        data-prospect-favicon={trimmed}
        src={`https://www.google.com/s2/favicons?domain=${trimmed}&sz=32`}
        alt=""
        loading="lazy"
        className="h-4 w-4 shrink-0 rounded-[3px]"
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <Telescope
      data-prospect-favicon-fallback=""
      className={cn(
        'h-4 w-4 shrink-0',
        stage === 'saved'
          ? 'text-emerald-500'
          : stage === 'dismissed'
            ? 'text-muted-foreground/40'
            : 'text-muted-foreground/70',
      )}
    />
  )
}

/** Fixed column widths per property — keeps attributes aligned across rows */
const COLUMN_WIDTHS: Record<string, number> = {
  identifier: 70,
  status: 100,
  assignee: 32,
  lead: 32,
  priority: 72,
  due_at: 68,
  due_date: 68,
  target_date: 68,
  start_date: 68,
  project: 110,
  initiative: 110,
  labels: 100,
  company: 100,
  job_title: 100,
  relationship_type: 80,
  relationship_strength: 80,
  progress: 88,
  last_interaction_at: 68,
  last_message_at: 68,
  created_at: 68,
  updated_at: 68,
  started_at: 68,
  interaction_count: 36,
  message_count: 36,
  contact_count: 36,
  participant_count: 36,
  action_count: 36,
  folder: 72,
  domain: 100,
  industry: 80,
  owner: 32,
  from_email: 140,
  is_unread: 24,
  auto_classified: 72,
  created_by: 80,
  // Flow columns
  trigger: 180,
  action_target: 160,
  team: 100,
  last_run: 96,
  enabled: 64,
  // Eval suite columns
  target_kind: 72,
  suite_kind: 88,
  case_count: 60,
  last_outcome: 72,
  last_run_mode: 56,
  last_run_at: 68,
  judge_model: 110,
  // Sequence columns (headline enrollment counts)
  enrolled: 40,
  active: 40,
  replied: 40,
  reply_rate: 56,
  // Prospecting columns
  fit_score: 96,
  fit_rationale: 220,
  stage: 92,
  kind: 72,
  identity_state: 88,
  dismissed_reason: 110,
}

/** Candidate lifecycle chip labels (migration 248's `stage` CHECK). */
const PROSPECT_STAGE_LABELS: Record<string, string> = {
  discovered: 'Discovered',
  shortlisted: 'Shortlisted',
  saved: 'Saved',
  dismissed: 'Dismissed',
}

/** Consistent pill/chip style for attribute values */
const chipClass = 'inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground whitespace-nowrap'

/**
 * The stage chip. A SAVED row is on the list; whether the CRM has it yet is
 * the list's publish state (migration 259), and the chip says which with a
 * dashed border and its title rather than a second word — "Saved" is the
 * stage, "not published" is a fact about the list.
 */
function stageChip(stage: string, publishedAt: unknown) {
  const label = PROSPECT_STAGE_LABELS[stage] ?? stage
  if (stage !== 'saved') return <span className={chipClass}>{label}</span>
  const published = typeof publishedAt === 'string' && publishedAt !== ''
  return (
    <span
      data-prospect-published={published ? 'true' : 'false'}
      title={
        published
          ? 'On the list and in your CRM'
          : 'On the list — reaches your CRM when the list is published'
      }
      className={cn(chipClass, !published && 'border-dashed')}
    >
      {label}
    </span>
  )
}

// ============================================================
// Prospect candidate rows (§10, "Row anatomy")
// ============================================================

/**
 * A prospect row does NOT go through the generic `title + right-aligned chip
 * strip` layout, and this is the fix for a bug seen on the first real run:
 * `fit_rationale` is a SENTENCE, not a chip. Rendered into the generic strip —
 * which is `shrink-0` and has no width of its own — a long rationale took the
 * whole row and squeezed the `flex-1 truncate` company name down to a single
 * letter ("Q…" for Querylane). `COLUMN_WIDTHS` above never constrained it; nothing
 * reads that map.
 *
 * So the branch below composes the row itself, in the §10 order, with an
 * explicit width contract:
 *
 *   [tier] [name + domain (min-w, truncates LAST)] [rationale (min-w-0, flex-1,
 *   truncate, full text on hover)] [signal chips] [employees] [stage] [source]
 *
 * The NAME cell gets `basis`/`min-w` and the rationale gets `min-w-0 flex-1`,
 * so when the row runs out of room the sentence gives way first and the
 * identity survives — the invariant a prospect list is useless without.
 *
 * Everything else in this file is untouched: other entity types keep the
 * generic path exactly as before.
 */

/** What one candidate carries in `prospect_list_entry.candidate` (jsonb). Kept
 *  structurally local rather than importing `ProspectCandidate` from the
 *  feature folder — the views system must not depend on a page package, and
 *  the row only reads six fields. */
interface RowCandidate {
  name?: string | null
  domain?: string | null
  one_liner?: string | null
  title?: string | null
  found_via?: string | null
  /** Company-only: when the people engine last searched this company (stamped
   *  found or not). Read against the live people run's start to take the
   *  searching orb off a row whose search is over. */
  people_searched_at?: string | null
  // ── person-only ──
  linkedin_url?: string | null
  /** NULL until an email is actually found — most discovered people have a
   *  LinkedIn URL and nothing else, and the row says so. */
  email?: string | null
  /**
   * DENORMALISED at insert by the people engine.
   *
   * A person entry's `company_id` is NULL by construction (migration 248's
   * CHECK) and `PROSPECT_ENTRY_VIEW_SELECT` in `src/lib/views/query-engine.ts`
   * selects no join, so the parent account's name cannot be read off the row
   * any other way. Writing it into `candidate` at insert time costs one string
   * and keeps the People tab readable with the existing query; the alternative
   * — a self-join on `parent_entry_id` in the views select — would put a
   * feature-specific join into the shared engine for one cell.
   */
  company_name?: string | null
}

function rowCandidate(item: Record<string, unknown>): RowCandidate {
  const raw = item.candidate
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as RowCandidate) : {}
}

/** A string field out of the research blob (`{ [key]: { value, source_url } }`
 *  — the same shape as `company.metadata.enrichment.fields`). */
function researchValue(item: Record<string, unknown>, key: string): string | null {
  const blob = item.research
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return null
  const fields = (blob as { fields?: unknown }).fields
  const bag = (fields && typeof fields === 'object' ? fields : blob) as Record<string, unknown>
  const entry = bag[key]
  if (typeof entry === 'string') return entry.trim() || null
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const value = (entry as { value?: unknown }).value
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * Save / Dismiss from a row.
 *
 * The list-detail page owns both handlers (they carry consequences the row
 * cannot: Save writes CRM records and reports per-entry outcomes, Dismiss must
 * collect a REASON, two of which suppress workspace-wide). Nothing reusable
 * existed — phase 1 wired them only into the entry panel, through a closure —
 * so the row reaches them the way contact rows reach the sequence picker:
 * `emitAddToSequence`'s documented CustomEvent pattern. The row states an
 * intent; the mounted page decides what it means.
 *
 * LISTENER LIVES IN `list-detail.tsx` (Package A). Until it is added, these
 * events are inert — which is the correct failure mode for a hover affordance:
 * nothing happens, nothing breaks, and no half-written CRM record.
 */
export const PROSPECT_ENTRY_ACTION_EVENT = 'dial8:prospect-entry-action'

/**
 * `sequence` is Save-THEN-enroll, and it is one intent rather than two because
 * the row cannot do the first half: `AddToSequenceDialog` needs a contact id,
 * and a prospect person has none until Save promotes them (§8). The page owns
 * that ordering; the row only says which people the user pointed at.
 *
 * `confirmUnverified` rides on a SAVE only, and only ever for ONE id: it is
 * the per-row answer to "we could not verify this person at <company> — save
 * anyway?". Bulk save holds `needs_review` people back by design, and a flag
 * that could arrive with twenty ids would be that gate with a bypass button.
 */
export interface ProspectEntryActionDetail {
  /** `profile` runs the full profile (and score) for one company; `people`
   *  is the row's Find people button — the people search for one company. */
  action: 'save' | 'dismiss' | 'sequence' | 'profile' | 'people'
  entryIds: string[]
  /** Save only: promote this `needs_review` person despite the identity gate. */
  confirmUnverified?: boolean
}

/**
 * Where a row's intent goes. The page listens on window; a prospect list in a
 * chat card (src/components/chat-cards/pages/prospecting-card.tsx) provides
 * its own target, so a row in the card reaches the card's list page alone and
 * the real page beside it never acts on it twice (one save, not two).
 */
export const ProspectEntryActionTargetContext = React.createContext<EventTarget | null>(null)

/** The target this subtree's rows emit to, and its list page listens on. */
export function useProspectEntryActionTarget(): EventTarget | null {
  return React.useContext(ProspectEntryActionTargetContext)
}

export function emitProspectEntryAction(
  action: 'save' | 'dismiss' | 'sequence' | 'profile' | 'people',
  entryIds: string[],
  options: { confirmUnverified?: boolean } = {},
  target: EventTarget | null = null,
) {
  ;(target ?? window).dispatchEvent(
    new CustomEvent<ProspectEntryActionDetail>(PROSPECT_ENTRY_ACTION_EVENT, {
      detail: {
        action,
        entryIds,
        ...(options.confirmUnverified ? { confirmUnverified: true } : {}),
      },
    }),
  )
}

// ── The Sequenced map, published to the rows ───────────────────────────────

/**
 * Sequence membership for the saved contacts on the open list, keyed by
 * `contact_id` (§8: DERIVED at read time from `sequence_enrollment`, never a
 * column on the entry).
 *
 * WHY A MODULE-LEVEL STORE AND NOT A PROP. The row renderer is mounted deep
 * inside the shared views system by `UnifiedViewLayout`, which passes a row
 * only its item and the view's display properties — threading a
 * feature-specific map through that chain would put prospecting into the
 * generic list's signature for one chip. So the page PUBLISHES the map and the
 * rows subscribe, the same shape the views system already uses for its refetch
 * nudge. `useSyncExternalStore` means a republish repaints every mounted row
 * with no re-render of the list itself.
 *
 * It is a snapshot of ONE list at a time and the page clears it on unmount, so
 * a stale map cannot leak a chip onto a different list's rows.
 */
export interface ProspectSequencedState {
  status: 'active' | 'exited'
  sequence_id: string
  sequence_name: string
}

let sequencedMap: Record<string, ProspectSequencedState> = {}
const sequencedListeners = new Set<() => void>()

/** Publish (or clear, with `{}`) the map the person rows read. */
export function publishProspectSequenced(next: Record<string, ProspectSequencedState>) {
  sequencedMap = next
  for (const listener of sequencedListeners) listener()
}

function subscribeSequenced(listener: () => void): () => void {
  sequencedListeners.add(listener)
  return () => {
    sequencedListeners.delete(listener)
  }
}

function readSequenced(): Record<string, ProspectSequencedState> {
  return sequencedMap
}

function useProspectSequenced(): Record<string, ProspectSequencedState> {
  // The server snapshot is the same identity every call — a fresh `{}` would
  // loop React's hydration check.
  return React.useSyncExternalStore(subscribeSequenced, readSequenced, readSequenced)
}

// ── Which lists have a run in flight, published to the rows ────────────────

/**
 * The ids of the prospect lists that have a LIVE run right now.
 *
 * WHY A STORE AND NOT THE ROW'S OWN DATA. The row already carries the list's
 * newest run, embedded by the views query (`prospecting_run[0]`) — and that
 * would be enough if the index refetched. It does not: the views query runs on
 * mount and on an explicit refetch nudge, whereas the thing that actually
 * knows a run started is `useActiveRuns`, a 5-second poll the index page owns.
 * Scout starts runs from the chat strip beside this list without unmounting it,
 * so a row waiting for its own query to come round again would sit dark for
 * the whole run — the exact bug §B5a fixed on the cards this list replaces.
 *
 * So the page PUBLISHES the live set and the rows subscribe, the same shape
 * (and the same reasoning) as {@link publishProspectSequenced}: threading a
 * prospecting-specific set through `UnifiedViewLayout`'s generic row props
 * would put this feature into the shared list's signature for one dot.
 *
 * The embedded run is still read as the FALLBACK, so a row is correct before
 * the first poll settles and correct on a surface that publishes nothing.
 *
 * The page clears it on unmount (publish an empty set), so a stale id cannot
 * light a dot on a list whose run finished while the user was elsewhere.
 */
let prospectListLive: ReadonlySet<string> = new Set()
const prospectListLiveListeners = new Set<() => void>()

/** Publish (or clear, with an empty set) the live-list ids the rows read. */
export function publishProspectListLive(next: ReadonlySet<string>) {
  prospectListLive = next
  for (const listener of prospectListLiveListeners) listener()
}

function subscribeProspectListLive(listener: () => void): () => void {
  prospectListLiveListeners.add(listener)
  return () => {
    prospectListLiveListeners.delete(listener)
  }
}

function readProspectListLive(): ReadonlySet<string> {
  return prospectListLive
}

function useProspectListLive(): ReadonlySet<string> {
  // Same identity every call on the server snapshot — a fresh `new Set()`
  // would loop React's hydration check.
  return React.useSyncExternalStore(
    subscribeProspectListLive,
    readProspectListLive,
    readProspectListLive,
  )
}

/**
 * The run statuses that put a PULSING DOT on a list row.
 *
 * Narrower than `run-summary`'s `isRunLive`, deliberately, and the difference
 * is `needs_input`. That helper answers "should the poller keep asking?", for
 * which a run parked on a question is still live. The dot answers "is work
 * happening right now?", for which it is not — a run waiting on a person will
 * not move until they act, and a pulse promising progress that cannot arrive
 * is the one place this row would actively mislead.
 */
const PROSPECT_LIST_DOT_STATUSES: readonly string[] = ['queued', 'running', 'canceling']

function runIsWorking(run: LastRun | null): boolean {
  return typeof run?.status === 'string' && PROSPECT_LIST_DOT_STATUSES.includes(run.status)
}

/**
 * Is THIS list running right now?
 *
 * The published set first (the index's 5s poll, which is what catches a run
 * Scout just started), then the row's own embedded newest run. A row on a
 * surface that publishes nothing still lights correctly from the embed; a row
 * whose embed is a stale completed run still lights from the poll. Neither
 * source alone is sufficient, which is why both are read.
 */
function useProspectListIsLive(item: Record<string, unknown>): boolean {
  const liveIds = useProspectListLive()
  const id = typeof item.id === 'string' ? item.id : ''
  if (id !== '' && liveIds.has(id)) return true
  return runIsWorking(lastRunOf(item))
}

/** The leading glyph on a prospect LIST row: a telescope, sky while running. */
function ProspectListGlyph({ item }: { item: Record<string, unknown> }) {
  const live = useProspectListIsLive(item)
  return (
    <Telescope
      /* ALWAYS present, 'true' or 'false' — never absent. The glyph is how a
         test (and a debugging human) addresses this row's liveness, and an
         attribute that disappears when the answer is "no" makes "not live" and
         "no glyph rendered" indistinguishable. */
      data-prospect-list-live={live ? 'true' : 'false'}
      aria-label={live ? 'A run is in progress' : undefined}
      className={cn('h-4 w-4 shrink-0', live ? 'text-sky-500' : 'text-muted-foreground/70')}
    />
  )
}

/**
 * "2h ago" — the relative half of the run chip.
 *
 * It lives here rather than in `run-summary.ts` because that module is
 * deliberately clock-free (it is imported by server code and pinned by pure
 * tests), and a formatter that reads `Date.now()` is exactly what such a
 * module must not export. Same ladder the index cards used.
 */
function relativeRunTime(iso: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

/**
 * A prospect LIST row (the Prospecting index).
 *
 *   [telescope] [name] [purpose] [N candidates] [N saved] [last run] [archived?]
 *
 * WHY A BESPOKE BODY AND NOT THE GENERIC CHIP STRIP. Three of these cells are
 * not columns: the two counts come from an `entry_counts` object the views
 * query route attaches in a post-query enrichment block, and the run chip
 * comes from an EMBEDDED to-many relation (`prospecting_run[0]`) plus the live
 * store above. The generic `PropertyCell` reads a flat field off the item and
 * renders it, so all three would render blank — and the run chip in particular
 * changes SHAPE (a pulsing dot, not a value) exactly when it matters most.
 *
 * This body replaces the card grid that used to be this index. Everything the
 * card said is still said, in one line rather than four: the stage bar was the
 * one casualty, and it was a decoration for a number the row now states.
 *
 * EVERY CELL EXCEPT THE NAME IS GATED on the view's display properties, the
 * same contract every other entity honours — a picker tick that changes
 * nothing is worse than a property that was never offered. The name is the
 * fixed skeleton: a list row without its name is not a shorter row, it is an
 * unclickable one.
 */
function ProspectListRowBody({
  item,
  displayProperties,
}: {
  item: Record<string, unknown>
  displayProperties: string[]
}) {
  const shows = (field: string) => displayProperties.includes(field)
  const live = useProspectListIsLive(item)

  const name = (typeof item.name === 'string' && item.name.trim()) || 'Untitled list'
  const purpose = item.purpose as ProspectListPurpose | undefined
  const purposeLabel = purpose ? PROSPECT_PURPOSE_LABELS[purpose] : null

  const counts = (
    item.entry_counts && typeof item.entry_counts === 'object' && !Array.isArray(item.entry_counts)
      ? item.entry_counts
      : null
  ) as Record<string, unknown> | null
  const countOf = (key: string): number => {
    const v = counts?.[key]
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const total = countOf('total')
  /**
   * SAVED means the entries that became CRM records — companies AND people.
   *
   * The card this replaces showed people alone when there were any and
   * companies otherwise, which made the number mean two different things on
   * two adjacent rows. One chip that says what it counted (in its title) is
   * legible down a column; a chip whose noun changes per row is not.
   */
  const savedCompanies = countOf('saved')
  const savedPeople = countOf('saved_people')
  const saved = savedCompanies + savedPeople

  const run = lastRunOf(item)
  const status = typeof run?.status === 'string' ? run.status : null
  const newCount = runNewCount(run)
  const when = relativeRunTime(runTimestamp(run))

  /**
   * The finished run's own line, assembled here rather than taken from
   * `runSummaryLabel` because the row appends a RELATIVE TIME the pure module
   * cannot produce, and because "Stopped early" is rendered as its own amber
   * chip beside the count rather than in place of it (§9: a capped run kept
   * every partial result, and replacing the count with the reason hides it).
   */
  const finishedLabel =
    status === 'failed'
      ? 'Failed'
      : status === 'canceled'
        ? 'Canceled'
        : [
            newCount > 0 ? `${newCount} new` : 'Nothing new',
            when,
          ]
            .filter(Boolean)
            .join(' · ')

  const archived = item.status === 'archived'

  return (
    <>
      {/* IDENTITY. `min-w-[7rem]` + `shrink` (not `shrink-0`): the name may
          compress under real pressure but starts from a width that shows a
          list name, and it is the LAST thing to give — the same contract the
          candidate rows use one level down. */}
      <span
        data-prospect-list-name
        className="min-w-[7rem] shrink basis-[18rem] truncate font-medium"
        title={name}
      >
        {name}
      </span>

      {/* The spacer that right-aligns the chips, matching every other row. */}
      <span className="min-w-0 flex-1" />

      <span className="flex shrink-0 items-center gap-1.5">
        {shows('purpose') && purposeLabel && (
          <span className={chipClass} data-prospect-list-purpose={purpose}>
            {purposeLabel}
          </span>
        )}

        {shows('candidates') && (
          <span className={cn(chipClass, 'tabular-nums')} data-prospect-list-candidates>
            {total === 0
              ? 'No candidates'
              : `${total} ${total === 1 ? 'candidate' : 'candidates'}`}
          </span>
        )}

        {/* Nothing saved yet is not a fact worth a chip — it is the state every
            new list is in, and a column of "0 saved" is noise. */}
        {shows('saved') && saved > 0 && (
          <span
            className={cn(chipClass, 'tabular-nums text-emerald-600 dark:text-emerald-400')}
            data-prospect-list-saved
            title={
              savedPeople > 0 && savedCompanies > 0
                ? `${savedCompanies} ${savedCompanies === 1 ? 'company' : 'companies'} and ${savedPeople} ${savedPeople === 1 ? 'person' : 'people'} added to your CRM`
                : savedPeople > 0
                  ? `${savedPeople} ${savedPeople === 1 ? 'person' : 'people'} added to your CRM`
                  : `${savedCompanies} ${savedCompanies === 1 ? 'company' : 'companies'} added to your CRM`
            }
          >
            {saved} saved
          </span>
        )}

        {/* THE RUN CHIP. A list that has been run and one that has not are
            different objects; a list with no run shows nothing here rather
            than a "never run" chip that adds no information. */}
        {shows('last_run') && (live || run) && (
          <span
            className={cn(chipClass, 'hidden md:inline-flex', live && 'text-foreground/80')}
            data-prospect-list-run={live ? 'live' : (status ?? 'none')}
            title={live ? 'A run is in progress' : undefined}
          >
            {live && (
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500/70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500" />
              </span>
            )}
            {live ? 'Finding…' : finishedLabel}
          </span>
        )}

        {/* budget_exhausted is an OUTCOME, not a failure (§9) — the run kept
            every partial result, so it is said BESIDE the count rather than
            replacing it. */}
        {shows('last_run') && !live && status === 'budget_exhausted' && (
          <span
            className={cn(chipClass, 'text-amber-600 dark:text-amber-500')}
            title="The run stopped early and kept everything it had found"
          >
            Stopped early
          </span>
        )}

        {shows('updated_at') && (
          <span className={cn(chipClass, 'hidden lg:inline-flex')} title="Last updated">
            {relativeRunTime(typeof item.updated_at === 'string' ? item.updated_at : null)}
          </span>
        )}
        {shows('created_at') && (
          <span className={cn(chipClass, 'hidden lg:inline-flex')} title="Created">
            {relativeRunTime(typeof item.created_at === 'string' ? item.created_at : null)}
          </span>
        )}

        {/* Only ARCHIVED earns a chip: 'active' is every row by default (the
            query filters to it unless the user asks otherwise), and a column
            of "Active" says nothing. */}
        {shows('status') && archived && <span className={chipClass}>Archived</span>}
      </span>
    </>
  )
}

/** Hover-revealed icon button — same grammar as the Details tab's copy
 *  affordance (invisible until the row is hovered, always reachable by
 *  keyboard through focus-visible). */
function RowIconButton({
  label,
  onPress,
  children,
  className,
}: {
  label: string
  onPress: () => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        // The row is the click target for "open this candidate" — a hover
        // action must not also navigate.
        e.stopPropagation()
        e.preventDefault()
        onPress()
      }}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors',
        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
    >
      {children}
    </button>
  )
}

function ProspectEntryRowBody({
  item,
  /**
   * The view's configured display properties, honoured here for the same
   * reason every other entity type honours them: a checkbox in the picker that
   * ticks and changes nothing is worse than a property that was never offered.
   *
   * WHAT IS AND IS NOT OPTIONAL. The identity cell and the rationale beside it
   * are the row's fixed skeleton — they are what the row IS, and a candidate
   * row with the company name switched off is not a shorter row, it is an
   * unusable one. Everything else (the fit chip, the stage chip, the matched
   * signals, confidence, the dismissal reason) is gated on membership, so the
   * picker's ticks mean what they say.
   */
  displayProperties,
}: {
  item: Record<string, unknown>
  displayProperties: string[]
}) {
  const actionTarget = useProspectEntryActionTarget()
  const candidate = rowCandidate(item)
  const itemId = item.id as string
  const shows = (field: string) => displayProperties.includes(field)
  /** What the list page is doing right now — the row's only way to tell an
   *  unscored company that is ABOUT to be scored from one nobody is scoring. */
  const activity = useProspectListActivity()
  const stage = shows('stage') ? (item.stage as string | null | undefined) : null
  /** The row's own writes still key off the REAL stage, never the displayed
   *  one: hiding the stage chip must not resurrect a Dismiss button on a row
   *  that is already dismissed. */
  const actualStage = item.stage as string | null | undefined
  /** The full profile's 0–100 rating; null until the company is enriched
   *  (fit.ts — discovery does not score, so null is "not profiled", never
   *  "a bad fit"). */
  const score = typeof item.fit_score === 'number' ? (item.fit_score as number) : null
  const unresolved = item.identity_state === 'unresolved'
  /** The people found at this company, attached inline by the views route and
   *  rendered as child rows beneath this one. The count is the row's own
   *  hint that there is something under the chevron. */
  const peopleCount = Array.isArray(item.children) ? item.children.length : 0
  /**
   * Is the live PEOPLE run searching THIS company right now? Targeted by the
   * run, nothing found beneath it yet, and — the per-company resolution — no
   * `people_searched_at` stamp newer than the run's start (the stamp is what
   * settles a company where nobody was found; the start-time check is for a
   * company searched before, found empty, and targeted again). Dismissed and
   * domain-less rows are never searched, so never "searching". A stamp that
   * will not parse keeps the orb until the run settles, which is the honest
   * fallback.
   */
  const searchedAt =
    typeof candidate.people_searched_at === 'string' ? Date.parse(candidate.people_searched_at) : NaN
  const peopleRun = activity.findingPeople
  /** The live people run has already searched this company (found nobody, or
   *  the row would have people). Its orb is off, and its button waits: the
   *  run will not search it twice, so a click would be a no-op join. */
  const searchedByLiveRun =
    peopleRun !== null && Number.isFinite(searchedAt) && searchedAt >= Date.parse(peopleRun.since)
  const findingPeople =
    peopleRun !== null &&
    peopleRun.ids.has(itemId) &&
    peopleCount === 0 &&
    actualStage !== 'dismissed' &&
    !unresolved &&
    !searchedByLiveRun
  /** The last people search returned people and kept NONE — every hit was
   *  already known (the engine's own stamp, `candidate.people_search`). Said
   *  on the row, so a retry is a decision rather than a guess: this used to
   *  read as an empty slot and a Find people button, and got pressed three
   *  times at $0.012 a go for the same duplicate. */
  const peopleSearch = readPeopleSearch(candidate)
  const knownOnly =
    peopleCount === 0 && actualStage !== 'dismissed' && foundOnlyKnownPeople(peopleSearch)
  /** Find people cannot start anything right now: a discovery or profile run
   *  holds the list, or the live people run already searched this company. */
  const findPeopleWaits = activity.runLive && (peopleRun === null || searchedByLiveRun)

  // NEVER EMPTY: name, then domain, then the candidate_key the row was
  // deduped under. A row with no label at all is unclickable in practice.
  const name =
    (typeof candidate.name === 'string' && candidate.name.trim()) ||
    (typeof candidate.domain === 'string' && candidate.domain.trim()) ||
    (typeof item.candidate_key === 'string' && (item.candidate_key as string).trim()) ||
    'Unknown candidate'
  const domain = typeof candidate.domain === 'string' ? candidate.domain.trim() : ''
  // Only show the domain beside the name when it is not already the name.
  const showDomain = domain !== '' && domain !== name

  /**
   * A `result_entity` candidate was lifted free from Exa's `results[].entities[]`
   * — it carries a DESCRIPTION of the company, not a judgement about fit. The
   * run engine puts that text in the same `fit_rationale`-adjacent slot, and
   * rendering it as a rationale would present marketing copy as our reasoning.
   * So it is labelled "About" and drops the chip claims. Observed live.
   */
  const fromResultEntity = candidate.found_via === 'result_entity'
  const rationale =
    (typeof item.fit_rationale === 'string' && item.fit_rationale.trim()) ||
    (fromResultEntity && typeof candidate.one_liner === 'string' && candidate.one_liner.trim()) ||
    ''

  /**
   * THE WHOLE "WHY" STRIP IS ONE TOGGLE.
   *
   * The rationale sentence, the employee range and the citation link all
   * answer the same question — why is this row here — and they are the
   * content that made a 40px row unreadable. They live in the entry panel
   * beside the list, and the picker's "Why" property brings the inline strip
   * back. They hang off `fit_rationale` because that IS the question they
   * answer.
   */
  const showsWhy = shows('fit_rationale')
  const employees = showsWhy
    ? researchValue(item, 'employee_range') ??
      researchValue(item, 'employee_count_range') ??
      null
    : null
  const evidenceUrl = showsWhy ? entryEvidenceUrl(item) : null
  const evidenceHost = evidenceUrl ? hostOf(evidenceUrl) : null

  const dismissedReason = shows('dismissed_reason')
    ? (item.dismissed_reason as string | null | undefined)
    : null

  return (
    <>
      {/* IDENTITY. `min-w-[7rem]` + `shrink` (not `shrink-0`) is the contract:
          the cell may compress under real pressure, but it starts from a width
          that shows a company name and it is the LAST thing to give — the
          rationale beside it has `min-w-0` and yields first. */}
      <span
        data-prospect-identity
        className="flex min-w-[7rem] shrink basis-[16rem] items-baseline gap-1.5 overflow-hidden"
      >
        <span
          data-prospect-name
          className={cn(
            'min-w-0 truncate font-medium',
            unresolved && 'text-muted-foreground',
          )}
          title={name}
        >
          {name}
        </span>
        {showDomain ? (
          // The domain SHRINKS and truncates: it is the secondary half of the
          // identity, so a long one (`verylongcompanyname.example.com`) must
          // not win width from the name it is annotating. `max-w-[45%]` caps
          // it even when there is room, so the name always keeps the majority
          // of the cell.
          <span
            className="hidden min-w-0 max-w-[45%] shrink truncate text-[11px] text-muted-foreground sm:inline"
            title={domain}
          >
            {domain}
          </span>
        ) : unresolved ? (
          <span className="hidden shrink-0 text-[11px] italic text-muted-foreground/70 sm:inline">
            no domain found
          </span>
        ) : null}
      </span>

      {/* THE SCORE SLOT. A profiled row shows the full profile's 0–100 rating
          and its word, then — the row's one action — Find people, for a
          profiled company that has none yet. An unscored row says "Scoring…"
          while the profile run that will score it is live (scores land and the
          list re-sorts without anyone pressing anything), and a quiet dash
          when nothing is running: the strip's Enrich fallback picks those up.
          Dismissed and domain-less rows get the dash too. Turning Fit score
          off in the picker hides the slot. */}
      {shows('fit_score') && (
        <span className="flex shrink-0 items-center gap-1.5">
          {score !== null ? (
            <span
              title={fitScoreTitle(score)}
              aria-label={fitScoreTitle(score)}
              data-fit-score={score}
              data-fit-label={fitLabel(score) ?? 'none'}
              className={cn(
                'inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium tabular-nums',
                fitScoreClass(score),
              )}
            >
              <span>{score}</span>
              <span className="hidden font-normal sm:inline">{FIT_SCORE_UNIT}</span>
            </span>
          ) : activity.profiling && actualStage !== 'dismissed' && !unresolved ? (
            <span
              data-fit-score="pending"
              title="Being scored now — the full profile is running"
              aria-label="Scoring"
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px]',
                FIT_UNSCORED_CLASS,
              )}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              Scoring…
            </span>
          ) : (
            <span
              title={FIT_UNSCORED_TITLE}
              aria-label="Not scored"
              data-fit-score="none"
              className={cn(
                'inline-flex h-6 items-center rounded-full border px-2 text-[11px]',
                FIT_UNSCORED_CLASS,
              )}
            >
              —
            </span>
          )}
          {/* THE ORB. While the live people run is searching this company the
              button's place holds the searching orb — the rail's own signal,
              moved onto the row the user pressed (Liam, 2026-09-06: "show
              that icon on each of the lines until it resolves"). It comes off
              when people land beneath the row, when the engine's per-company
              stamp says this search is over, or when the run settles.

              Otherwise, Find people needs a company worth contacting: scored
              above zero (a 0 is the user's own exclusion rule, or a company
              the profile rated a non-fit), no people yet, not dismissed.
              While a PEOPLE run is live the button stays live too: pressing it
              JOINS that run (createRun appends to it — queue-on-click, Liam,
              2026-09-06), and this row gets its orb when the run's target
              list comes back with it. While a discovery or profile run is
              live the button stays where it is but DISABLED — one live run
              per list, and a button that 409s is worse than none, but a
              button that vanishes from every other row the moment one is
              pressed reads as the layout breaking. */}
          {findingPeople && (
            <span
              data-prospect-finding-people
              role="img"
              title={`Finding people at ${name}`}
              aria-label={`Finding people at ${name}`}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center"
            >
              <ThinkingOrb state="searching" size={20} theme="auto" aria-hidden />
            </span>
          )}
          {!findingPeople && knownOnly && peopleSearch && (
            <span
              data-prospect-people-known
              title={knownPeopleLines(peopleSearch).join('\n')}
              className="hidden max-w-[180px] truncate text-[10px] text-muted-foreground sm:inline"
            >
              {knownPeopleSummary(peopleSearch)}
            </span>
          )}
          {!findingPeople &&
            score !== null &&
            score > 0 &&
            peopleCount === 0 &&
            actualStage !== 'dismissed' &&
            !unresolved && (
              <button
                type="button"
                data-prospect-find-people
                disabled={findPeopleWaits}
                title={
                  searchedByLiveRun
                    ? 'Searched by the run that is going — nobody found yet; try again once it finishes'
                    : peopleRun !== null
                      ? `Find the people to contact at ${name} — joins the search that is running`
                      : activity.runLive
                        ? 'One search at a time on this list — available once the current one finishes'
                        : `Find the people to contact at ${name}`
                }
                aria-label={`Find people at ${name}`}
                onClick={(e) => {
                  // The row is the click target for "open this candidate" —
                  // the button must not also open the panel.
                  e.stopPropagation()
                  e.preventDefault()
                  emitProspectEntryAction('people', [itemId], {}, actionTarget)
                }}
                className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border px-2 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
              >
                <Users className="h-3 w-3" />
                Find people
              </button>
            )}
        </span>
      )}

      {/* THE SENTENCE. `min-w-0 flex-1 truncate` — this is what gives way.
          Turning "Why" off in the picker replaces it with the same empty
          spacer an unscored row gets, so the identity keeps its width and the
          chips stay right-aligned. */}
      {rationale && showsWhy ? (
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
          {fromResultEntity && (
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/60">
              About
            </span>
          )}
          <span
            className="min-w-0 truncate text-[11px] text-muted-foreground"
            title={rationale}
          >
            {rationale}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}

      <span className="flex shrink-0 items-center gap-1.5">
        {employees && (
          <span className={cn(chipClass, 'hidden md:inline-flex')} title={`${employees} employees`}>
            {employees}
          </span>
        )}

        {peopleCount > 0 && (
          <span
            data-prospect-people-count
            className={chipClass}
            title={`${peopleCount} ${peopleCount === 1 ? 'person' : 'people'} found here, nested below`}
          >
            {peopleCount} {peopleCount === 1 ? 'person' : 'people'}
          </span>
        )}
        {stage && stageChip(stage, item.published_at)}

        {dismissedReason && (
          <span
            className={cn(chipClass, 'hidden max-w-[9rem] truncate md:inline-flex')}
            title={`Dismissed: ${dismissedReason}`}
          >
            {dismissedReason}
          </span>
        )}

        {/* Citation — the favicon of the page that surfaced this company. */}
        {evidenceUrl && (
          <a
            href={evidenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={`Surfaced by ${evidenceHost ?? evidenceUrl}`}
            aria-label={`Open the source that surfaced this candidate (${evidenceHost ?? 'source'})`}
            className="inline-flex h-5 w-5 items-center justify-center rounded-sm hover:bg-muted"
          >
            {evidenceHost ? (
              <img
                src={`https://www.google.com/s2/favicons?domain=${evidenceHost}&sz=32`}
                alt=""
                className="h-3.5 w-3.5 rounded-[2px]"
                onError={(e) => {
                  ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                }}
              />
            ) : (
              <ExternalLink className="h-3 w-3 text-muted-foreground" />
            )}
          </a>
        )}

        {/* Hover actions. Dismissed rows cannot be dismissed again; saved rows
            cannot be saved again; an unresolved row has no domain to promote. */}
        {actualStage !== 'dismissed' && (
          <RowIconButton
            label="Dismiss"
            onPress={() => emitProspectEntryAction('dismiss', [itemId], {}, actionTarget)}
          >
            <X className="h-3.5 w-3.5" />
          </RowIconButton>
        )}
        {actualStage !== 'saved' && !unresolved && (
          <RowIconButton
            /* SAVE keeps the company ON THE LIST — and the people found
               beneath it. Nothing reaches the CRM until the list is
               published (migration 259), which is why the label stopped
               saying CRM. */
            label="Save to list"
            className="hover:text-emerald-600 dark:hover:text-emerald-400"
            onPress={() => emitProspectEntryAction('save', [itemId], {}, actionTarget)}
          >
            <Check className="h-3.5 w-3.5" />
          </RowIconButton>
        )}
      </span>
    </>
  )
}

/**
 * A PERSON row (§10, "People tab: dense table matching CRM row density —
 * checkbox, name, title, company, email state, source link, status chip").
 *
 *   [avatar] [name (never empty)] [title] [company] [verify?] [email dot]
 *   [sequenced?] [stage] [dismiss]
 *
 * The email ADDRESS and the LinkedIn link both moved to the entry panel beside
 * the list: at 40px they were the two cells that cost the name and title their
 * width, and neither is something a user reads while scanning — the dot says
 * whether there is an email (which is what predicts the sequence control), and
 * the address rides on its title for the one row being checked.
 *
 * THREE THINGS THIS ROW SAYS THAT A COMPANY ROW DOES NOT:
 *
 * 1. **Which company.** A person entry's `company_id` is NULL by construction
 *    (migration 248's CHECK: person ⇒ company_id NULL) and the views query
 *    selects no join, so the company name is DENORMALISED into
 *    `candidate.company_name` at insert time by the people engine. Without it
 *    a People tab spanning twenty accounts is a list of strangers. The domain
 *    is the fallback, because `candidate.domain` on a person IS the employer's
 *    domain (that is what the search was anchored to).
 *
 * 2. **Whether we could verify the employer.** `identity_state='needs_review'`
 *    means no field survived `demoteUnrelatedPersonSources` at high/medium
 *    against the company domain — the Devin Marsh namesake failure at 20×
 *    scale. It renders as a muted "verify" chip rather than a warning colour:
 *    the person is probably right, we just could not prove it, and these rows
 *    are excluded from bulk save anyway. Overstating it would train users to
 *    ignore it.
 *
 * 3. **Whether there is an email.** Most discovered people have a LinkedIn URL
 *    and no email (which is precisely why `findOrCreateContact` could not have
 *    created them — §1). A muted dot is the honest default and it is what
 *    makes the eventual sequence step's requirement legible before the user
 *    has built a list they cannot send to.
 *
 * SAVE IS LIVE. `createProspectContact` promotes an emailless person
 * (`findOrCreateContact` refuses them by design), so the row's hover ✓ writes
 * a real `contact` row — WITH ONE GATE: a `needs_review` person goes through a
 * per-row confirm first, because bulk save holds them back and a hover button
 * that quietly waived the identity check would be the Devin Marsh failure
 * with a nicer interface.
 *
 * ADD-TO-SEQUENCE is Save-then-enroll, one control (§8). It is DISABLED with
 * the reason on it for a person with no email — most discovered people — and
 * that is why the email state above is a fixed cell rather than an optional
 * display property: it is what predicts whether this control will work.
 *
 * THE SEQUENCED CHIP is derived at read time from `sequence_enrollment`
 * (published by the page through {@link publishProspectSequenced}); there is
 * no `stage='contacted'` and nothing on the entry to go stale.
 */
function ProspectPersonRowBody({
  item,
  displayProperties,
}: {
  item: Record<string, unknown>
  displayProperties: string[]
}) {
  const actionTarget = useProspectEntryActionTarget()
  const candidate = rowCandidate(item)
  const itemId = item.id as string
  const shows = (field: string) => displayProperties.includes(field)
  const stage = shows('stage') ? (item.stage as string | null | undefined) : null
  const actualStage = item.stage as string | null | undefined

  // NEVER EMPTY, and the fallback order is different from a company's: a
  // person with no name but a title reads as "VP of Revenue Operations",
  // which is a row a human can act on; the candidate_key (a linkedin slug or
  // an email) is the last resort.
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
  const name =
    (typeof candidate.name === 'string' && candidate.name.trim()) ||
    title ||
    (typeof item.candidate_key === 'string' && (item.candidate_key as string).trim()) ||
    'Unknown person'
  // Don't print the title twice when it stood in for the name.
  const showTitle = title !== '' && title !== name

  // Denormalised at insert (see the header); the anchor domain is the
  // fallback, and it is a real answer rather than a placeholder — it is the
  // site the search was restricted to.
  const companyName =
    (typeof candidate.company_name === 'string' && candidate.company_name.trim()) ||
    (typeof candidate.domain === 'string' && candidate.domain.trim()) ||
    ''

  const needsReview = item.identity_state === 'needs_review'
  const email = typeof candidate.email === 'string' ? candidate.email.trim() : ''

  /**
   * Sequence membership, DERIVED (§8) and keyed by the contact this entry was
   * promoted into — so it can only ever exist on a SAVED row, which is exactly
   * the semantics: an unsaved candidate has no contact to enroll.
   */
  const sequenced = useProspectSequenced()
  const contactId = typeof item.contact_id === 'string' ? item.contact_id : ''
  const sequenceState = contactId ? sequenced[contactId] : undefined

  /** In the CRM group already (migration 259): saved AND published. */
  const published = typeof item.published_at === 'string' && item.published_at !== ''

  return (
    <>
      {/* IDENTITY. Same width contract as the company row: a min-width floor
          and `shrink` rather than `shrink-0`, so the name is the LAST thing to
          give when the row runs out of room. */}
      <span
        data-prospect-identity
        className="flex min-w-[7rem] shrink basis-[14rem] items-baseline gap-1.5 overflow-hidden"
      >
        <span
          data-prospect-name
          className={cn(
            'min-w-0 truncate font-medium',
            actualStage === 'dismissed' && 'text-muted-foreground',
          )}
          title={name}
        >
          {name}
        </span>
      </span>

      {/* TITLE — the sentence-shaped cell, so it is what yields first. */}
      {showTitle ? (
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
          title={title}
        >
          {title}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}

      <span className="flex shrink-0 items-center gap-1.5">
        {/* WHICH COMPANY. Shown on the People tab even when the view is scoped
            to one account, because the tab is reachable unscoped and a person
            row with no employer is the one thing this tab must never be. */}
        {companyName && (
          <span
            className={cn(chipClass, 'hidden max-w-[10rem] truncate sm:inline-flex')}
            title={companyName}
          >
            {companyName}
          </span>
        )}

        {/* IDENTITY GATE. Muted, never a warning colour — see the header. */}
        {needsReview && (
          <span
            className={cn(chipClass, 'italic')}
            title="We could not confirm this person currently works there — check before saving"
          >
            verify
          </span>
        )}

        {/* EMAIL STATE — A DOT, not the address.
            Whether there is an email is what the row has to say (it decides
            whether the sequence control beside it will work); the address
            itself is forty characters of nothing anyone reads at 40px, and it
            is on the panel a click away. So the row keeps the STATE at one
            glyph's width and puts the address on the hover title, where a user
            checking one row still gets it without the column of them costing
            every other row its width. */}
        <span
          data-prospect-email={email ? 'present' : 'none'}
          role="img"
          aria-label={email ? `Email: ${email}` : 'No email found'}
          title={email || 'No email found — LinkedIn only'}
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            email ? 'bg-emerald-500' : 'bg-muted-foreground/40',
          )}
        />

        {/* SEQUENCED — derived at read time, never stored. `exited` says so
            rather than reading as a live enrollment: on the one row where a
            user decides whether to enroll someone again, "already in a
            sequence" and "finished a sequence" are different answers. */}
        {sequenceState && (
          <span
            data-prospect-sequenced={sequenceState.status}
            className={cn(
              chipClass,
              sequenceState.status === 'active' &&
                'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
            )}
            title={
              sequenceState.status === 'active'
                ? `Active in ${sequenceState.sequence_name}`
                : `Finished ${sequenceState.sequence_name}`
            }
          >
            {sequenceState.status === 'active' ? 'Sequenced' : 'Sequenced (done)'}
          </span>
        )}

        {stage && stageChip(stage, item.published_at)}

        {/* THE NAMESAKE GATE'S ESCAPE HATCH, inline on the row (§8). Save
            keeps an unverified person on the list like anyone else; it is
            PUBLISH that holds them back (the list publish skips them as
            needs_review). So the question sits on a saved, unpublished,
            unverified person and says what could not be proven — a hover ✓
            that silently waived the gate is the failure the gate exists to
            prevent. The page publishes that ONE person. */}
        {needsReview && actualStage === 'saved' && !published && (
          <span
            data-prospect-publish-anyway
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-[11px]"
          >
            <span className="text-muted-foreground">
              {`Could not verify at ${companyName || 'this company'}.`}
            </span>
            <button
              type="button"
              title="The list publish held this person back — write them to your CRM anyway"
              className="rounded px-1 font-medium text-foreground hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                emitProspectEntryAction('save', [itemId], { confirmUnverified: true }, actionTarget)
              }}
            >
              Publish anyway
            </button>
          </span>
        )}

        {/* ADD TO SEQUENCE — Save-then-enroll, one gesture (§8). Disabled with
            the reason ON it when there is no email: sequences send email, and
            a control that opened a dialog only to have the enrollment skip the
            person with `no_email` would report the truth too late. */}
        {actualStage !== 'dismissed' && !sequenceState && (
          email ? (
            <RowIconButton
              label="Add to sequence"
              onPress={() => emitProspectEntryAction('sequence', [itemId], {}, actionTarget)}
            >
              <Send className="h-3.5 w-3.5" />
            </RowIconButton>
          ) : (
            <span
              title="No email address — sequences send email, so this person cannot be enrolled"
              aria-label="Cannot add to sequence: no email address"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/40 opacity-0 group-hover:opacity-100"
            >
              <Send className="h-3.5 w-3.5" />
            </span>
          )
        )}

        {/* Dismiss works exactly as it does on a company row — the entry is a
            row on this list either way. */}
        {actualStage !== 'dismissed' && (
          <RowIconButton
            label="Dismiss"
            onPress={() => emitProspectEntryAction('dismiss', [itemId], {}, actionTarget)}
          >
            <X className="h-3.5 w-3.5" />
          </RowIconButton>
        )}

        {/* SAVE keeps the person — and their company — on the list. Nothing
            reaches the CRM until the list is published (migration 259), so an
            unverified person saves like anyone else; the gate is asked at
            publish time, above. */}
        {actualStage !== 'saved' && (
          <RowIconButton
            label="Save to list"
            className="hover:text-emerald-600 dark:hover:text-emerald-400"
            onPress={() => emitProspectEntryAction('save', [itemId], {}, actionTarget)}
          >
            <Check className="h-3.5 w-3.5" />
          </RowIconButton>
        )}
      </span>
    </>
  )
}

// ── Editable cell dispatcher ───────────────────────────────

/**
 * Dispatches on `descriptor.picker` to the matching CellTrigger and returns
 * the rendered element. Returns `undefined` if the picker can't be rendered
 * (e.g. missing pickerContext), so PropertyCell can fall back to read-only.
 */
function renderEditableCell({
  item, property, descriptor, id, entityType, onPatch, pickerContext,
}: {
  item: Record<string, unknown>
  property: string
  descriptor: EditableDescriptor
  id: string
  entityType: ViewEntityType
  onPatch: PatchItemFn
  pickerContext?: PickerContext
}): React.ReactNode | undefined {
  const { picker, apiField } = descriptor
  const patch = (value: unknown) => onPatch(id, { [apiField]: value })

  switch (picker) {
    case 'priority': {
      const value = item.priority as string | null | undefined
      return <PriorityCellTrigger value={value} onChange={patch} />
    }
    case 'status': {
      if (!pickerContext) return undefined
      const teamId = (item.team_id as string | undefined) || ''
      const workflowStates = pickerContext.workflowStatesByTeam[teamId] ?? []
      const value = (item.status_id as string | null | undefined)
        || ((item.workflow_state as { id?: string } | null | undefined)?.id)
      const displayName = (item.status_name as string | null | undefined)
        || ((item.workflow_state as { name?: string } | null | undefined)?.name)
        || (item.status as string | undefined)
      const displayColor = (item.status_color as string | null | undefined)
        || ((item.workflow_state as { color?: string } | null | undefined)?.color)
      const displayCategory = (item.status_category as string | null | undefined)
        || ((item.workflow_state as { category?: string } | null | undefined)?.category)
      return (
        <StatusCellTrigger
          value={value}
          workflowStates={workflowStates}
          displayName={displayName}
          displayColor={displayColor}
          displayCategory={displayCategory}
          onChange={patch}
          loading={pickerContext.loading}
        />
      )
    }
    case 'member': {
      if (!pickerContext) return undefined
      // Resolve current id + display info from common shapes used across entities.
      let value: string | null | undefined
      let displayName: string | null | undefined
      let displayAvatar: string | null | undefined
      let delegate: { id: string; name: string | null; avatar: string | null } | null = null
      if (property === 'assignee') {
        // The delegate model (decision 9): the person responsible leads, and an
        // agent working the action as its delegate rides beside them as a chip.
        const aiMemberId = item.assignee_ai_member_id as string | null | undefined
        value = item.assignee_id as string | null | undefined
        displayName = (item.assignee_name as string | null | undefined)
          || ((item.assignee as { display_name?: string } | null | undefined)?.display_name)
        displayAvatar = (item.assignee_avatar as string | null | undefined)
          || ((item.assignee as { avatar_url?: string } | null | undefined)?.avatar_url)
        delegate = aiMemberId
          ? {
              id: aiMemberId,
              name: (item.assignee_ai_member_name as string | null | undefined) ?? null,
              avatar: (item.assignee_ai_member_avatar as string | null | undefined) ?? null,
            }
          : null
      } else if (property === 'lead') {
        value = item.lead_id as string | null | undefined
        displayName = (item.lead_name as string | null | undefined)
          || ((item.lead as { display_name?: string } | null | undefined)?.display_name)
        displayAvatar = ((item.lead as { avatar_url?: string } | null | undefined)?.avatar_url)
      } else if (property === 'owner') {
        value = item.owner_id as string | null | undefined
        displayName = (item.owner_name as string | null | undefined)
          || ((item.owner as { display_name?: string } | null | undefined)?.display_name)
        displayAvatar = ((item.owner as { avatar_url?: string } | null | undefined)?.avatar_url)
      } else {
        value = item[apiField] as string | null | undefined
      }
      const emptyLabel = property === 'lead' ? 'No lead' : property === 'owner' ? 'No owner' : 'Unassigned'
      // For the action assignee, agents and people persist to different columns
      // and no longer clear each other (decision 9). Picking an agent sets the
      // delegate (picking the current one again removes it); the server makes
      // the delegator responsible when nobody is. Picking a person sets the
      // person and keeps the delegate. Unassigned clears both.
      const handleMemberChange = property === 'assignee'
        ? (memberId: string | null, kind?: 'member' | 'ai') => {
            if (kind === 'ai') {
              onPatch(id, { assignee_ai_member_id: memberId && memberId === delegate?.id ? null : memberId })
            } else if (memberId) {
              onPatch(id, { assignee_id: memberId })
            } else {
              onPatch(id, { assignee_id: null, assignee_ai_member_id: null })
            }
          }
        : patch
      // Agents are only assignable to actions — keep lead/owner human-only.
      const memberOptions = property === 'assignee'
        ? pickerContext.members
        : pickerContext.members.filter((m) => m.kind !== 'ai')
      return (
        <MemberCellTrigger
          value={value}
          members={memberOptions}
          displayName={displayName}
          displayAvatar={displayAvatar}
          emptyLabel={emptyLabel}
          onChange={handleMemberChange}
          currentMemberId={pickerContext.currentMemberId}
          delegate={delegate}
        />
      )
    }
    case 'project': {
      if (!pickerContext) return undefined
      const value = item.project_id as string | null | undefined
      const displayName = (item.project_name as string | null | undefined)
        || ((item.project as { name?: string } | null | undefined)?.name)
      return (
        <ProjectCellTrigger
          value={value}
          projects={pickerContext.projects}
          displayName={displayName}
          onChange={patch}
        />
      )
    }
    case 'initiative': {
      if (!pickerContext) return undefined
      const value = item.initiative_id as string | null | undefined
      const displayName = (item.initiative_name as string | null | undefined)
        || ((item.initiative as { name?: string } | null | undefined)?.name)
      return (
        <InitiativeCellTrigger
          value={value}
          initiatives={pickerContext.initiatives}
          displayName={displayName}
          onChange={patch}
        />
      )
    }
    case 'company': {
      if (!pickerContext) return undefined
      const value = (item.company_id as string | null | undefined)
        || ((item.company as { id?: string } | null | undefined)?.id)
      const displayName = ((item.company as { name?: string } | null | undefined)?.name)
      const displayLogo = ((item.company as { logo_url?: string } | null | undefined)?.logo_url)
      return (
        <CompanyCellTrigger
          value={value}
          companies={pickerContext.companies}
          displayName={displayName}
          displayLogo={displayLogo}
          onChange={patch}
        />
      )
    }
    case 'label': {
      const rawLabels = item.labels as unknown[] | null | undefined
      const attached: AttachedLabel[] = (rawLabels ?? [])
        .map((l: unknown) => {
          const obj = l as Record<string, unknown>
          if (obj.label) return obj.label as AttachedLabel
          if (obj.name) return obj as unknown as AttachedLabel
          return null
        })
        .filter(Boolean) as AttachedLabel[]
      const toggle = (labelId: string, isAttached: boolean) => {
        // Label toggle is non-trivial — we PATCH the labels array; the API
        // accepts label ids to add/remove. Use a special-cased patch shape.
        const nextIds = isAttached
          ? attached.filter(l => l.id !== labelId).map(l => l.id)
          : [...attached.map(l => l.id), labelId]
        onPatch(id, { label_ids: nextIds })
      }
      return (
        <LabelCellTrigger
          attached={attached}
          scope={entityScopeForLabels(entityType)}
          onToggle={toggle}
        />
      )
    }
    case 'date': {
      const raw = item[apiField] as string | null | undefined
      const overdueSensitive = apiField === 'due_at' || apiField === 'target_date'
      // target_date / start_date are `date` columns: store the picked LOCAL
      // calendar day, not the UTC date of its midnight (a day early east of UTC).
      const dateOnly = apiField === 'target_date' || apiField === 'start_date' || apiField === 'expected_close_date'
      return (
        <DateCellTrigger
          value={raw}
          overdueSensitive={overdueSensitive}
          onChange={dateOnly ? (iso) => patch(iso ? format(new Date(iso), 'yyyy-MM-dd') : null) : patch}
        />
      )
    }
    case 'enum': {
      const { options, colorMap } = resolveEnumOptions(property)
      if (!options.length) return undefined
      const value = item[apiField] as string | null | undefined
      return (
        <EnumCellTrigger value={value} options={options} colorMap={colorMap} onChange={patch} />
      )
    }
    case 'boolean': {
      const value = item[apiField] as boolean | null | undefined
      // Flow `enabled` is the row's primary status — render an always-visible
      // Active/Paused pill toggle rather than the hover-only check/minus glyph
      // the shared boolean cell uses for secondary flags like pin/star.
      if (entityType === 'flow' && apiField === 'enabled') {
        return <FlowEnabledCellTrigger value={value !== false} onChange={patch} />
      }
      const label = property.replace(/_/g, ' ')
      return <BooleanCellTrigger value={value} onChange={patch} label={label} />
    }
    case 'text': {
      const value = item[apiField] as string | null | undefined
      return <TextEditCellTrigger value={value} onChange={patch} placeholder={property.replace(/_/g, ' ')} />
    }
    default:
      return undefined
  }
}

/** Resolve the enum options + optional color map for a given property field.
 *  Exported so the views registration test can pin that every `picker: 'enum'`
 *  descriptor actually resolves to options — an unregistered field renders a
 *  read-only chip with no error. */
export function resolveEnumOptions(property: string): {
  options: Array<{ value: string; label: string }>
  colorMap?: Record<string, string>
} {
  switch (property) {
    case 'relationship_type':
      return { options: RELATIONSHIP_TYPE_OPTIONS }
    case 'relationship_strength':
      return { options: RELATIONSHIP_STRENGTH_OPTIONS, colorMap: STRENGTH_COLORS }
    case 'employee_count_range':
      return { options: EMPLOYEE_COUNT_OPTIONS }
    case 'folder':
      return { options: EMAIL_FOLDER_OPTIONS }
    case 'suite_kind':
      return { options: [{ value: 'capability', label: 'Capability' }, { value: 'regression', label: 'Regression' }] }
    // eval_case's ONE editable cell. Without this case the descriptor resolves
    // to zero options and renderEditableCell bails, leaving a read-only chip.
    case 'polarity':
      return { options: [{ value: 'positive', label: 'Positive' }, { value: 'negative', label: 'Negative' }] }
    // A claim's ONE editable cell (see DISPLAY_PROPERTIES.claim). All three
    // values are offered, including `dismissed`, even though the claim board
    // has no Dismissed column: the board cannot offer a column you drag into
    // and never out of, but the cell is how a reader dismisses a claim from a
    // list without opening it. The same options serve `action.confirmation`,
    // which is read-only and so never reaches an editable path.
    case 'confirmation':
      return {
        options: [
          { value: 'suggested', label: 'Suggested' },
          { value: 'confirmed', label: 'Confirmed' },
          { value: 'dismissed', label: 'Dismissed' },
        ],
      }
    // Project/initiative enum statuses (used only when a custom workflow is not configured)
    case 'status':
      return { options: PROJECT_STATUS_OPTIONS as unknown as Array<{ value: string; label: string }> }
    default:
      return { options: [] }
  }
}

/** Label scope derives from the entity type that owns the row. */
function entityScopeForLabels(entityType: ViewEntityType): 'action' | 'project' | 'initiative' | 'email_thread' {
  switch (entityType) {
    case 'project': return 'project'
    case 'initiative': return 'initiative'
    case 'email_thread': return 'email_thread'
    default: return 'action'
  }
}

interface PropertyCellProps {
  item: Record<string, unknown>
  property: string
  entityType: ViewEntityType
  onPatch?: PatchItemFn
  pickerContext?: PickerContext
  canEdit?: (item: Record<string, unknown>, field: string) => boolean
}

/**
 * The cells unique to an `eval_run` row.
 *
 * A plain function rather than a component: it is called from inside
 * `PropertyCell`'s body and returns `undefined` for a property it does not
 * own, so the shared switch below still handles `outcome` and the rest. That
 * `undefined` is the whole contract — see the call site for why two of these
 * properties MUST resolve before the shared switch sees them.
 */
function EvalRunCell({
  item,
  property,
}: {
  item: Record<string, unknown>
  property: string
}): React.ReactNode | undefined {
  switch (property) {
    case 'mode': {
      const mode = item.mode as 'batch' | 'live' | null
      if (!mode) return null
      return (
        <span className="text-[11px] text-muted-foreground whitespace-nowrap">
          {MODE_LABELS[mode]}
        </span>
      )
    }
    case 'speed': {
      const speed = item.speed as string | null
      if (!speed) return null
      return <span className={cn(chipClass, 'capitalize')}>{speed}</span>
    }
    case 'status': {
      const status = item.status as string | null
      if (!status) return null
      const pending = status === 'queued' || status === 'running'
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground whitespace-nowrap">
          {/* The SAME orb the run rail spins on a live run, so "this is
              moving" reads identically whether the reader is looking at the
              rail above the list or at one row inside it. `is_live` is the
              server's own liveness column (a generated column on
              status IN ('queued','running')) — never the client's guess. */}
          {pending && item.is_live === true && (
            <ThinkingOrb
              state="searching"
              size={20}
              theme="auto"
              className="-my-1 shrink-0"
              aria-hidden
            />
          )}
          <span className="capitalize">{status}</span>
        </span>
      )
    }
    case 'scores': {
      // ONE muted line: "Gate 100 · Tools 100 · Summary 100 · Proposals 60".
      // The `%` signs are dropped for width — the label beside each number
      // establishes the unit — and the full sentence for every dimension
      // lives in the `title`. '—' is NOT 0%: every check in that dimension was
      // `unknown` or `skipped`, both excluded from the denominator, and a bare
      // zero would read as a total failure of something never measured.
      const scores = item.scores as
        | Record<string, { rate?: number | null } | null>
        | null
        | undefined
      const tally = dimensionTally(scores)
      if (tally.length === 0) return null
      return (
        <span
          className="text-[11px] text-muted-foreground whitespace-nowrap"
          title={dimensionTallyText(scores)}
        >
          {tally.map((d, index) => (
            <span key={d.dimension}>
              {index > 0 && <span className="px-1">·</span>}
              {d.label}{' '}
              <span className="text-foreground/80 tabular-nums">{d.value}</span>
            </span>
          ))}
        </span>
      )
    }
    case 'cost_usd': {
      const cost = item.cost_usd as number | string | null
      if (cost === null || cost === undefined) return null
      return (
        <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
          {formatEvalCost(cost)}
        </span>
      )
    }
    case 'duration_ms': {
      const ms = item.duration_ms as number | null
      if (ms === null || ms === undefined) return null
      return (
        <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
          {formatEvalDuration(ms)}
        </span>
      )
    }
    case 'trials_per_case': {
      const n = item.trials_per_case as number | null
      if (n === null || n === undefined) return null
      return <span className={chipClass}>{n === 1 ? '1 trial' : `${n} trials`}</span>
    }
    case 'target_prompt_hash': {
      // The first eight characters, mono, full hash in the title — the git
      // short-sha convention, and the same prefix the compare view prints. It
      // is also what `applySearch` matches on, so a prefix copied off a row
      // finds that run's siblings.
      const hash = item.target_prompt_hash as string | null
      if (!hash) return null
      return (
        <span
          className="font-mono text-[11px] text-muted-foreground whitespace-nowrap"
          title={hash}
        >
          {hash.slice(0, 8)}
        </span>
      )
    }
    case 'started_at': case 'ended_at': {
      const v = item[property] as string | null
      if (!v) return null
      return (
        <span className="text-[11px] text-muted-foreground whitespace-nowrap">
          {formatRunWhen(v)}
        </span>
      )
    }
    default:
      return undefined
  }
}

function PropertyCell({ item, property, entityType, onPatch, pickerContext, canEdit }: PropertyCellProps) {
  // If inline editing is wired AND this property is declared editable for
  // this entity AND the row is permitted to edit it, render the matching
  // CellTrigger. Otherwise fall through to the legacy read-only chip path.
  const descriptor = onPatch
    ? DISPLAY_PROPERTIES[entityType].find(d => d.field === property)?.editable
    : undefined
  const editable = !!descriptor && (!canEdit || canEdit(item, property))
  if (editable && descriptor && onPatch) {
    const id = item.id as string
    const editCell = renderEditableCell({ item, property, descriptor, id, entityType, onPatch, pickerContext })
    if (editCell !== undefined) return editCell
    // Fall through to read-only if descriptor couldn't be rendered (e.g. missing context).
  }

  // ── Eval RUN cells, resolved BEFORE the shared switch ──
  //
  // Two of a run's properties collide with names the shared switch already
  // owns, and both collisions are silent rather than loud:
  //
  //   * `status` below is the ACTION workflow-state picker. It reads
  //     `pickerContext.workflowStatesByTeam` and returns `undefined` without
  //     one — so a run's plain 'running' / 'completed' enum would render an
  //     empty cell, not an error.
  //   * `started_at` below renders RELATIVE time ("2h ago"). Two runs of the
  //     same suite an hour apart are the thing being compared, and relative
  //     time on both cannot tell them apart — the whole reason the suite page
  //     prints an absolute stamp.
  //
  // Branching on entityType here keeps both shared cells untouched for every
  // other entity instead of threading an `entityType` test through each.
  if (entityType === 'eval_run') {
    const runCell = EvalRunCell({ item, property })
    if (runCell !== undefined) return runCell
  }
  if (entityType === 'deal') {
    const dealCell = DealCell({ item, property })
    if (dealCell !== undefined) return dealCell
  }

  switch (property) {
    case 'fit_score': {
      // Read-only by design — see DISPLAY_PROPERTIES.prospect_list_entry.
      const score = typeof item.fit_score === 'number' ? (item.fit_score as number) : null
      if (score === null) return null
      return (
        <span
          title={fitScoreTitle(score)}
          data-fit-score={score}
          className={cn(
            'inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium tabular-nums',
            fitScoreClass(score),
          )}
        >
          {score}
          <span className="font-normal">{FIT_SCORE_UNIT}</span>
        </span>
      )
    }
    case 'fit_rationale': {
      // Truncated in the row; the full text is the title attribute (hover) and
      // the entry detail panel renders it with its per-signal evidence.
      //
      // THE MAX-WIDTH IS LOAD-BEARING. `truncate` only truncates within a width
      // something else imposes, and this cell sits inside the row's `shrink-0`
      // chip group — so without a cap it renders at its natural width and eats
      // the title's column (observed live: "Q…" for Querylane). The `min-w-0` lets
      // it shrink below its content on a narrow row rather than overflowing.
      //
      // A `result_entity` candidate's rationale is Exa's own DESCRIPTION of the
      // company, not a why-fit — the discovery harvest lifts it free from
      // `results[].entities[]` and there is no scored reason behind it, so it
      // is rendered in the muted register with an honest hover rather than as a
      // verdict.
      //
      // NOTE: prospect rows in the LIST layout compose their own body
      // (ProspectEntryRowBody) and do not reach this cell. It remains the
      // rendering for `fit_rationale` wherever the generic PropertyCell path is
      // used — a board card's property strip, and any future scoped embed.
      const why = item.fit_rationale as string | null | undefined
      if (!why) return null
      const candidate = (item.candidate ?? {}) as { found_via?: string }
      const isDescription = candidate.found_via === 'result_entity'
      return (
        <span
          className={cn(
            'min-w-0 max-w-[16rem] truncate text-[11px]',
            isDescription ? 'text-muted-foreground/70 italic' : 'text-muted-foreground',
          )}
          title={isDescription ? `What they do: ${why}` : why}
        >
          {why}
        </span>
      )
    }
    case 'stage': {
      const stage = item.stage as string | null | undefined
      if (!stage) return null
      return <span className={chipClass}>{PROSPECT_STAGE_LABELS[stage] ?? stage}</span>
    }
    case 'kind': {
      const kind = item.kind as string | null | undefined
      if (!kind) return null
      return <span className={cn(chipClass, 'capitalize')}>{kind}</span>
    }
    case 'identifier': {
      const id = item.identifier as string | null
      if (!id) return null
      return <span className={chipClass}>{id}</span>
    }
    case 'assignee': {
      const assigneesRaw = (item.assignees as { member?: { id: string; display_name: string; avatar_url: string | null }; id?: string; display_name?: string; avatar_url?: string | null }[] | null) || []
      // Normalize: join table shape has .member, flat shape has direct fields
      const assigneesList = assigneesRaw.map((a) => a.member || a as { id: string; display_name: string; avatar_url: string | null }).filter((a) => a?.display_name)
      if (assigneesList.length > 1) {
        return (
          <div className="flex -space-x-1.5">
            {assigneesList.slice(0, 3).map((a) => (
              <Avatar key={a.id} className="h-5 w-5 border border-border/60 ring-1 ring-background">
                {a.avatar_url && <AvatarImage src={a.avatar_url} />}
                <AvatarFallback className="text-[9px] bg-muted/40">{getInitials(a.display_name)}</AvatarFallback>
              </Avatar>
            ))}
            {assigneesList.length > 3 && (
              <div className="flex h-5 w-5 items-center justify-center rounded-full border border-border/60 bg-muted text-[8px] ring-1 ring-background">
                +{assigneesList.length - 3}
              </div>
            )}
          </div>
        )
      }
      // Fallback to single assignee (legacy or single-assignee)
      const assigneeName = assigneesList[0]?.display_name
        || (item.assignee_name as string)
        || (item.assignee as { display_name?: string } | null)?.display_name
      const avatarUrl = assigneesList[0]?.avatar_url
        || (item.assignee_avatar as string)
        || (item.assignee as { avatar_url?: string } | null)?.avatar_url
      return assigneeName ? (
        <Avatar className="h-5 w-5 border border-border/60">
          {avatarUrl && <AvatarImage src={avatarUrl} />}
          <AvatarFallback className="text-[9px] bg-muted/40">{getInitials(assigneeName)}</AvatarFallback>
        </Avatar>
      ) : null
    }
    case 'created_by': {
      // Read-only creator attribution — small avatar + name, prefixed with
      // "Created by" so it reads as authorship rather than an assignment.
      const memberId = (item.created_by as string | null | undefined)
        ?? ((item.creator as { id?: string } | null | undefined)?.id)
      if (!memberId) return null
      const member = pickerContext?.members.find(m => m.id === memberId)
      const name = (item.created_by_name as string | null | undefined)
        ?? ((item.creator as { display_name?: string } | null | undefined)?.display_name)
        ?? member?.display_name
      const avatar = ((item.creator as { avatar_url?: string } | null | undefined)?.avatar_url)
        ?? member?.avatar_url ?? undefined
      if (!name) return null
      return (
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Avatar className="h-4 w-4">
            {avatar && <AvatarImage src={avatar} />}
            <AvatarFallback className="text-[8px] bg-muted/40">{getInitials(name)}</AvatarFallback>
          </Avatar>
          <span className="truncate">Created by {name}</span>
        </span>
      )
    }
    case 'priority': {
      const p = (item.priority as string) || 'none'
      if (p === 'none') return null
      const dotColors: Record<string, string> = {
        urgent: '#ef4444', high: '#f97316', medium: '#eab308', low: '#3b82f6',
      }
      return (
        <span className={cn(chipClass, 'capitalize')}>
          {p}
        </span>
      )
    }
    case 'project': {
      const projName = (item.project_name as string)
        || (item.project as { name?: string } | null)?.name
      return projName ? <span className={cn(chipClass, 'max-w-[120px] truncate')}>{projName}</span> : null
    }
    case 'status': {
      // Sequence rows use the shared status chip metadata (SEQUENCE_STATUS_META)
      // so the list, board and detail page all render the same chip.
      if (entityType === 'sequence') {
        const meta = SEQUENCE_STATUS_META[(item.status as string) ?? '']
        if (!meta) return null
        return (
          <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap', meta.className)}>
            {meta.label}
          </span>
        )
      }
      const statusName = (item.status_name as string)
        || (item.workflow_state as { name?: string } | null)?.name
        || (item.status as string)
      const STATUS_COLORS: Record<string, string> = {
        planned: '#6b7280', active: '#3b82f6', paused: '#f59e0b',
        completed: '#10b981', canceled: '#ef4444', archived: '#9ca3af',
      }
      const statusColor = (item.status_color as string)
        || (item.workflow_state as { color?: string } | null)?.color
        || STATUS_COLORS[(item.status as string)] || '#6b7280'
      if (!statusName) return null
      return (
        <span className={cn(chipClass, 'capitalize')}>
          {statusName.replace(/_/g, ' ')}
        </span>
      )
    }
    case 'labels': {
      const rawLabels = item.labels as unknown[] | null
      if (!rawLabels?.length) return null
      const labels = rawLabels.map((l: unknown) => {
        const obj = l as Record<string, unknown>
        if (obj.label) return obj.label as { id: string; name: string; color: string }
        if (obj.name) return obj as unknown as { id: string; name: string; color: string }
        return null
      }).filter(Boolean) as { id: string; name: string; color: string }[]
      if (!labels.length) return null
      return (
        <div className="flex gap-1">
          {labels.slice(0, 2).map((l, i) => (
            <span key={l.id || i} className={chipClass}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
              {l.name}
            </span>
          ))}
          {labels.length > 2 && <span className="text-[10px] text-muted-foreground">+{labels.length - 2}</span>}
        </div>
      )
    }
    case 'lead': {
      const leadName = (item.lead_name as string)
        || (item.lead as { display_name?: string; avatar_url?: string } | null)?.display_name
      const avatarUrl = (item.lead as { avatar_url?: string } | null)?.avatar_url
      return leadName ? (
        <Avatar className="h-5 w-5 border border-border/60">
          {avatarUrl && <AvatarImage src={avatarUrl} />}
          <AvatarFallback className="text-[9px] bg-muted/40">{getInitials(leadName)}</AvatarFallback>
        </Avatar>
      ) : null
    }
    case 'initiative': {
      const initName = (item.initiative_name as string)
        || (item.initiative as { name?: string } | null)?.name
      return initName ? <span className={cn(chipClass, 'max-w-[120px] truncate')}>{initName}</span> : null
    }
    case 'progress': {
      const pct = (item.progress_pct as number | undefined)
        ?? (item.progress as { percentage?: number } | null)?.percentage
      if (pct == null) return null
      return (
        <div className="flex items-center gap-1.5 w-20">
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[10px] text-muted-foreground w-7 text-right">{pct}%</span>
        </div>
      )
    }
    case 'target_date': case 'start_date': {
      const val = item[property] as string | null
      if (!val) return null
      // A `date` column (`YYYY-MM-DD`): parseISO reads local midnight, where
      // new Date() reads UTC midnight (the day before, west of UTC). Overdue
      // once the day itself has passed.
      const d = parseISO(val)
      const overdue = property === 'target_date' && d < startOfDay(new Date()) && item.status !== 'completed' && item.status !== 'canceled'
      return (
        <span className={chipClass}>
          {overdue && <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-destructive" />}
          {formatShort(d)}
        </span>
      )
    }
    case 'due_at': case 'due_date': {
      const val = item.due_at as string | null
      if (!val) return null
      const d = new Date(val)
      const overdue = d < new Date()
      return (
        <span className={chipClass}>
          {overdue && <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-destructive" />}
          {formatShort(d)}
        </span>
      )
    }
    case 'company': {
      const c = item.company as { name?: string } | null
      return c?.name ? <span className={cn(chipClass, 'max-w-[120px] truncate')}>{c.name}</span> : null
    }
    case 'relationship_type': case 'relationship_strength': case 'folder': case 'auto_classified': {
      const v = item[property] as string | null
      return v ? <span className={cn(chipClass, 'capitalize')}>{v.replace(/_/g, ' ')}</span> : null
    }
    case 'last_interaction_at': case 'last_message_at': case 'created_at': case 'updated_at': case 'started_at': {
      const v = item[property] as string | null
      if (!v) return null
      return <span className={cn(chipClass)}>{formatRelative(v)}</span>
    }
    case 'interaction_count': case 'message_count': case 'contact_count': {
      const v = item[property] as number | null
      return v != null ? <span className={chipClass}>{v}</span> : null
    }
    // ── Eval-suite cells ──
    // Every one reads a REAL column: migration 255 denormalized the summary
    // onto eval_suite behind triggers so a view can group and sort on it.
    case 'target_kind': {
      const kind = item.target_kind as string | null
      if (!kind) return null
      return <span className={chipClass}>{kind === 'skill' ? 'Skill' : 'Agent'}</span>
    }
    case 'suite_kind': {
      const kind = item.suite_kind as string | null
      if (!kind) return null
      return <span className={chipClass}>{kind === 'regression' ? 'Regression' : 'Capability'}</span>
    }
    case 'case_count': {
      const v = item.case_count as number | null
      if (v == null) return null
      return <span className={chipClass}>{v === 1 ? '1 case' : `${v} cases`}</span>
    }
    case 'last_outcome': {
      // Nothing at all when no run has settled: an OutcomeChip with its dash
      // placeholder would read as "ran, and we have no verdict", which is a
      // different fact about the suite than "never graded".
      const outcome = item.last_outcome as string | null
      if (!outcome) return null
      return <OutcomeChip outcome={outcome as 'passed' | 'scored' | 'failed' | 'errored'} />
    }
    case 'last_run_mode': {
      const mode = item.last_run_mode as 'batch' | 'live' | null
      if (!mode) return null
      return <span className="text-[11px] text-muted-foreground whitespace-nowrap">{MODE_LABELS[mode]}</span>
    }
    case 'last_run_at': {
      const v = item.last_run_at as string | null
      if (!v) return <span className="text-[11px] text-muted-foreground/60 whitespace-nowrap">Never run</span>
      return <span className="text-[11px] text-muted-foreground whitespace-nowrap">{formatRelative(v)}</span>
    }
    // ── Eval-case cells ──
    // `last_outcome` and `last_run_at` are shared with the suite above and
    // need no case of their own: migration 257 gave eval_case columns of the
    // same names and the same vocabulary, so the suite's renderings are
    // already correct for a case — including "Never run", which means exactly
    // the same thing about a case that has no settled trial.
    case 'polarity': {
      // A NEGATIVE control gets a pill; a positive one gets muted text. The
      // asymmetry is the point: negative is the exceptional, meaning-inverting
      // case (the agent is expected to do NOTHING), and a suite of only
      // positives measures recall and never precision — which is what the
      // suite page's amber banner warns about. Giving both an identical pill
      // would make the exception invisible in a scan.
      const polarity = item.polarity as string | null
      if (!polarity) return null
      if (polarity === 'negative') {
        return (
          <span className="inline-flex shrink-0 items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 whitespace-nowrap dark:text-amber-400">
            Negative
          </span>
        )
      }
      return (
        <span className="text-[11px] text-muted-foreground whitespace-nowrap">
          Positive
        </span>
      )
    }
    case 'modes': {
      // `modes` is a text[] (252) that defaults to BOTH — one tiny pill each,
      // the same vocabulary the suite page's case rows already use, so a
      // batch-only case is visibly different from one that also replays live.
      const modes = item.modes as string[] | null
      if (!Array.isArray(modes) || modes.length === 0) return null
      return (
        <span className="inline-flex shrink-0 items-center gap-1">
          {modes.map(m => (
            <span
              key={m}
              className="border-border bg-muted/40 text-muted-foreground shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] whitespace-nowrap"
            >
              {MODE_LABELS[m as 'batch' | 'live'] ?? m}
            </span>
          ))}
        </span>
      )
    }
    case 'visibility': {
      // NOTHING for the ordinary 'workspace' value. A case seeded from a
      // private capture stays creator-only (§3.2), and that is the fact worth
      // a chip; stamping every other row "Workspace" would be a column of
      // furniture saying "normal".
      const visibility = item.visibility as string | null
      if (visibility !== 'private') return null
      return (
        <span className={chipClass} title="Only you can see this case">
          <EyeOff className="h-3 w-3 shrink-0" />
          Private
        </span>
      )
    }
    case 'outcome': {
      // The RUN's verdict. Nothing at all while it has none — a chip with a
      // dash placeholder would read as "finished, and we have no verdict",
      // which is a different fact than "still running" or "cancelled". The
      // `status` cell beside it is what says which of those it is.
      const outcome = item.outcome as string | null
      if (!outcome) return null
      return <OutcomeChip outcome={outcome as 'passed' | 'scored' | 'failed'} />
    }
    case 'judge_model': {
      const model = item.judge_model as string | null
      return (
        <span className={cn('font-mono text-[11px] text-muted-foreground max-w-[110px] truncate whitespace-nowrap')}>
          {model ?? 'Default'}
        </span>
      )
    }
    // ── Sequence-specific cells ──
    // Headline numbers off enrollment_counts (merged into rows by the
    // views/query route). All read-only — nothing on a sequence row is a
    // settable field.
    case 'enrolled': case 'active': case 'replied': {
      const counts = item.enrollment_counts as
        { total?: number; active?: number; replied?: number } | null | undefined
      if (!counts) return null
      const v = property === 'enrolled' ? counts.total : property === 'active' ? counts.active : counts.replied
      if (v == null) return null
      const label = property === 'enrolled' ? 'enrolled' : property === 'active' ? 'active' : 'replied'
      return <span className={chipClass} title={`${v} ${label}`}>{v}</span>
    }
    case 'reply_rate': {
      const counts = item.enrollment_counts as
        { total?: number; replied?: number } | null | undefined
      if (!counts) return null
      return <span className={chipClass}>{replyRate(counts.replied ?? 0, counts.total ?? 0)}</span>
    }
    case 'enrollment': {
      // The SCOPED CONTACT's own enrollment — merged by the views/query route
      // only when the list carries a contact scope (contact panel → Sequences).
      // Global sequence lists never get `contact_enrollment`, so this renders
      // nothing there. Active → progress chip ("Step 2 of 3", next send in the
      // tooltip, labeled with the sequence's zone); exited → exit-reason chip
      // (same metadata the sequence detail page uses), progress in the tooltip.
      const e = item.contact_enrollment as {
        status?: string
        exit_reason?: string | null
        current_step_order?: number
        next_send_at?: string | null
        step_count?: number
      } | null | undefined
      if (!e) return null
      const pillClass = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap'
      if (e.status === 'active') {
        const progress = describeEnrollmentProgress(e.current_step_order ?? 0, e.step_count ?? 0, 'active')
        const tz = (item.timezone as string | undefined) || 'UTC'
        const title = e.next_send_at
          ? `Next send: ${humanizeSendTime(e.next_send_at, tz)} (${timezoneAbbreviation(tz)})`
          : undefined
        return (
          <span className={cn(pillClass, SEQUENCE_STATUS_META.active.className)} title={title}>
            <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-emerald-500" />
            {progress}
          </span>
        )
      }
      const meta = (e.exit_reason && EXIT_REASON_META[e.exit_reason]) || null
      const progress = describeEnrollmentProgress(e.current_step_order ?? 0, e.step_count ?? 0, 'exited')
      return (
        <span
          className={cn(pillClass, meta?.className ?? 'bg-muted text-muted-foreground border-border')}
          title={progress}
        >
          {meta?.label ?? 'Exited'}
        </span>
      )
    }
    // ── Flow-specific synthetic cells ──
    case 'trigger': {
      // Trigger summary. Workspace-scoped triggers (schedule/capture_processed)
      // get a flat label; status-change gets "Action → Done"-style.
      const triggerType = item.trigger_type as string | undefined
      if (triggerType === 'schedule' || triggerType === 'capture_processed') {
        const scfg = item.trigger_config as { cadence?: string } | null
        const label =
          triggerType === 'schedule'
            ? `Schedule${scfg?.cadence ? ` · ${scfg.cadence}` : ''}`
            : 'Capture processed'
        return (
          <span className={cn(chipClass, 'max-w-[200px] truncate gap-1')} title={label}>
            <Zap className="h-2.5 w-2.5 shrink-0 text-amber-500" />
            {label}
          </span>
        )
      }
      const cfg = item.trigger_config as
        | { entity_type?: string; from_status_id?: string | null; to_status_id?: string }
        | null
      if (!cfg) return null
      const entity = (cfg.entity_type || 'action') as keyof typeof FLOW_ENTITY_LABEL
      const entityLabel = FLOW_ENTITY_LABEL[entity] ?? 'Action'
      const to = flowStatusLabel(cfg.entity_type || 'action', cfg.to_status_id ?? '')
      return (
        <span className={cn(chipClass, 'max-w-[200px] truncate gap-1')} title={`${entityLabel} → ${to}`}>
          <Zap className="h-2.5 w-2.5 shrink-0 text-amber-500" />
          {entityLabel}
          <ChevronRight className="h-2.5 w-2.5 shrink-0 opacity-50" />
          {to}
        </span>
      )
    }
    case 'action_target': {
      const actions =
        (item.actions as Array<{ type?: string; config?: { method?: string; url?: string } }> | null) ?? []
      const extra = actions.length > 1 ? ` +${actions.length - 1}` : ''
      const first = actions[0]
      if (first?.type === 'run_skill') {
        return (
          <span className={cn(chipClass, 'max-w-[180px] truncate font-mono text-[10px]')}>
            RUN skill{extra}
          </span>
        )
      }
      if (!first?.config?.url) return null
      let host = first.config.url
      try {
        host = new URL(first.config.url).host
      } catch {
        /* keep raw string if not a parseable URL */
      }
      return (
        <span className={cn(chipClass, 'max-w-[180px] truncate font-mono text-[10px]')} title={first.config.url}>
          {(first.config.method || 'POST')} {host}{extra}
        </span>
      )
    }
    case 'team': {
      const t = item.team as { name?: string } | null
      return t?.name ? <span className={cn(chipClass, 'max-w-[120px] truncate')}>{t.name}</span> : null
    }
    case 'last_run': {
      // The query embeds the single most-recent run as flow_run[0].
      const runs = item.flow_run as Array<{ status?: string; fired_at?: string }> | null | undefined
      const run = runs && runs.length > 0 ? runs[0] : null
      if (!run) return <span className="text-[11px] text-muted-foreground/60">Never run</span>
      const ok = run.status === 'success'
      const failed = run.status === 'failed'
      return (
        <span
          className={cn(chipClass, 'gap-1')}
          title={run.fired_at ? new Date(run.fired_at).toLocaleString() : undefined}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full shrink-0',
              ok ? 'bg-emerald-500' : failed ? 'bg-destructive' : 'bg-amber-500',
            )}
          />
          {run.fired_at ? formatRelative(run.fired_at) : (run.status ?? 'pending')}
        </span>
      )
    }
    default: {
      const v = item[property]
      return v != null ? <span className={cn(chipClass, 'max-w-[120px] truncate')}>{String(v)}</span> : null
    }
  }
}

// Flow display helpers — entity-type labels + status name resolution for the
// trigger summary cell. Action statuses are workflow_state UUIDs (we can't
// resolve names in the row without the per-team picker context, so we show a
// short label); project/initiative/milestone statuses are enum strings.
const FLOW_ENTITY_LABEL: Record<string, string> = {
  action: 'Action',
  project: 'Project',
  initiative: 'Initiative',
  milestone: 'Milestone',
}

function flowStatusLabel(entityType: string, statusId: string): string {
  if (!statusId) return '—'
  // For non-action entities the stored value IS the human-readable enum.
  if (entityType !== 'action') return statusId.replace(/_/g, ' ')
  // Action status is a workflow_state UUID — show a compact placeholder; the
  // full name is visible in the canvas editor's trigger config.
  return 'status'
}

/**
 * Always-visible Active/Paused status pill for a flow's `enabled` field.
 * Clicking toggles the value via the standard inline-patch path. Unlike the
 * shared BooleanCellTrigger (which hides the "off" state until hover), this is
 * the row's primary status so both states are always shown.
 */
function FlowEnabledCellTrigger({
  value,
  onChange,
}: {
  value: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onChange(!value)
      }}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
        value
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400'
          : 'border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/70',
      )}
      aria-pressed={value}
      aria-label={value ? 'Active — click to pause' : 'Paused — click to activate'}
      title={value ? 'Active — click to pause' : 'Paused — click to activate'}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', value ? 'bg-emerald-500' : 'bg-muted-foreground/50')} />
      {value ? 'Active' : 'Paused'}
    </button>
  )
}

function formatShort(d: Date): string {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dateOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (dateOnly.getTime() === today.getTime()) return 'Today'
  if (dateOnly.getTime() === today.getTime() + 86400000) return 'Tomorrow'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatRelative(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
