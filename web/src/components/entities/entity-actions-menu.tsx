'use client'

/**
 * THE ONE ENTITY ACTIONS MENU: the same actions on a record of any kind,
 * wherever it shows up. Built from the app's own menu primitives, so it slides
 * into each place as that place's own menu:
 *   - EntityActionsMenu: a ⋯ button and its dropdown (a detail panel's
 *     toolbar, which a card shows as rows in its Properties popover);
 *   - EntityContextMenu: right-click on a chip or a row (team chat's record
 *     mentions, "Referenced in");
 *   - EntityActionsMenuItems: the items alone, for a menu that already exists
 *     (a list row's context menu, beside its own items).
 * Which actions show is the kind's descriptor's call
 * (src/lib/entities/entity-actions-registry.ts supportedEntityActions); what
 * each does is the action layer's (src/lib/entities/actions.ts). An action a
 * kind doesn't support never shows.
 */
import * as React from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  CircleCheck,
  Copy,
  Hash,
  Link2,
  MoreHorizontal,
  Pencil,
  Send,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PreferenceActionButton } from '@/components/views/preference-action'
import { useCanOpenCards } from '@/app/account/(dashboard)/main-chat/main-chat-context'
import {
  isDirectEntityAction,
  loadShareChannels,
  renameEntity,
  runEntityAction,
  shareEntityToChannel,
  type EntityRef,
  type ShareChannel,
} from '@/lib/entities/actions'
import { supportedEntityActions, type EntityActionId } from '@/lib/entities/entity-actions-registry'

/** What the surface knows about the record: archived or not, and its status now (an archive's undo puts it back). */
export interface EntityMenuState {
  archived?: boolean | null
  status?: string | null
}

export const ENTITY_ACTION_LABELS: Record<EntityActionId, string> = {
  open: 'Open',
  copy_link: 'Copy link',
  copy_id: 'Copy ID',
  rename: 'Rename…',
  share: 'Share to channel',
  make_task: 'Make a task',
  archive: 'Archive',
  restore: 'Restore',
}

export const ENTITY_ACTION_ICONS: Record<EntityActionId, React.ComponentType<{ className?: string }>> = {
  open: ArrowUpRight,
  copy_link: Link2,
  copy_id: Copy,
  rename: Pencil,
  share: Send,
  make_task: CircleCheck,
  archive: Archive,
  restore: ArchiveRestore,
}

/**
 * What a detail panel leaves out of its menu: Open (it IS the record, open)
 * and Rename (its title is edited in place, and a panel skips its own tab's
 * echo, so a rename from the menu would leave its title stale).
 */
export const PANEL_OMIT: readonly EntityActionId[] = ['open', 'rename']

/** The actions this record offers here (a surface with no chat to open cards in offers no Open). */
export function useEntityActions(entity: EntityRef, state: EntityMenuState = {}): EntityActionId[] {
  const canOpen = useCanOpenCards()
  return React.useMemo(
    () => supportedEntityActions(entity.type, { archived: state.archived ?? null, canOpen }),
    [entity.type, state.archived, canOpen],
  )
}

// ── The two families of primitives, behind one shape ────────────────────────

type ItemProps = { onSelect?: (e: Event) => void; disabled?: boolean; className?: string; children?: React.ReactNode; 'data-entity-action'?: string }
type Primitives = {
  Item: React.ComponentType<ItemProps>
  Separator: React.ComponentType<{ className?: string }>
  Sub: React.ComponentType<{ children?: React.ReactNode; onOpenChange?: (open: boolean) => void }>
  SubTrigger: React.ComponentType<{ children?: React.ReactNode; className?: string; 'data-entity-action'?: string }>
  SubContent: React.ComponentType<{ children?: React.ReactNode; className?: string }>
}
const DROPDOWN: Primitives = {
  Item: DropdownMenuItem as React.ComponentType<ItemProps>,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
}
const CONTEXT: Primitives = {
  Item: ContextMenuItem as React.ComponentType<ItemProps>,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
}

/** Where the separators fall: opening and copying, then changing, then archiving. */
const GROUP: Record<EntityActionId, number> = {
  open: 0,
  copy_link: 0,
  copy_id: 0,
  rename: 1,
  share: 1,
  make_task: 1,
  archive: 2,
  restore: 2,
}

export interface EntityActionsMenuItemsProps {
  entity: EntityRef
  state?: EntityMenuState
  /** Inside a DropdownMenuContent ('dropdown') or a ContextMenuContent ('context'). */
  variant: 'dropdown' | 'context'
  /** Rename… was picked: the host shows its rename dialog (useEntityRenameDialog). */
  onRename: () => void
  /** Leave these out (the surface already offers them its own way). */
  omit?: readonly EntityActionId[]
  /** A separator before the first item (the host's own items come above). */
  leadingSeparator?: boolean
  /** Where an Open came from, kept with the card. */
  from?: string
}

/** The menu's items, for a menu content the host already renders. Nothing to offer: renders nothing. */
export function EntityActionsMenuItems({ entity, state = {}, variant, onRename, omit, leadingSeparator, from }: EntityActionsMenuItemsProps) {
  const all = useEntityActions(entity, state)
  const actions = omit?.length ? all.filter((a) => !omit.includes(a)) : all
  const P = variant === 'dropdown' ? DROPDOWN : CONTEXT
  if (actions.length === 0) return null
  const ctx = { status: state.status ?? null, from: from ?? 'entity_menu' }
  return (
    <>
      {leadingSeparator && <P.Separator />}
      {actions.map((id, i) => {
        const Icon = ENTITY_ACTION_ICONS[id]
        const sep = i > 0 && GROUP[id] !== GROUP[actions[i - 1]] ? <P.Separator /> : null
        if (id === 'share') {
          return (
            <React.Fragment key={id}>
              {sep}
              <ShareSubmenu entity={entity} P={P} />
            </React.Fragment>
          )
        }
        return (
          <React.Fragment key={id}>
            {sep}
            <P.Item
              data-entity-action={id}
              onSelect={() => {
                if (id === 'rename') onRename()
                else if (isDirectEntityAction(id)) void runEntityAction(id, entity, ctx)
              }}
            >
              <Icon className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
              {ENTITY_ACTION_LABELS[id]}
            </P.Item>
          </React.Fragment>
        )
      })}
    </>
  )
}

/** Share to channel ›, its channels read when it opens (once per open). */
function ShareSubmenu({ entity, P }: { entity: EntityRef; P: Primitives }) {
  const [channels, setChannels] = React.useState<ShareChannel[] | null>(null)
  const Icon = ENTITY_ACTION_ICONS.share
  return (
    <P.Sub
      onOpenChange={(open) => {
        if (!open) return
        setChannels(null)
        void loadShareChannels().then(setChannels)
      }}
    >
      <P.SubTrigger data-entity-action="share">
        <Icon className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
        {ENTITY_ACTION_LABELS.share}
      </P.SubTrigger>
      <P.SubContent className="max-h-72 w-52 overflow-y-auto">
        {channels === null ? (
          <P.Item disabled>Loading…</P.Item>
        ) : channels.length === 0 ? (
          <P.Item disabled>No channels yet</P.Item>
        ) : (
          channels.map((c) => (
            <P.Item key={c.id} data-share-channel={c.id} onSelect={() => void shareEntityToChannel(entity, c)}>
              <Hash className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate">{c.name ?? 'Channel'}</span>
            </P.Item>
          ))
        )}
      </P.SubContent>
    </P.Sub>
  )
}

// ── Rename ──────────────────────────────────────────────────────────────────

/** A rename dialog for the record, and the function that opens it. */
export function useEntityRenameDialog(entity: EntityRef): { openRename: () => void; renameDialog: React.ReactNode } {
  const [open, setOpen] = React.useState(false)
  // Opened from a menu item: wait for the menu to close, so its focus return doesn't steal the field's.
  const openRename = React.useCallback(() => {
    setTimeout(() => setOpen(true), 0)
  }, [])
  const renameDialog = open ? <RenameEntityDialog entity={entity} onClose={() => setOpen(false)} /> : null
  return { openRename, renameDialog }
}

export function RenameEntityDialog({ entity, onClose }: { entity: EntityRef; onClose: () => void }) {
  const [title, setTitle] = React.useState(entity.label)
  const [saving, setSaving] = React.useState(false)
  const save = async () => {
    if (saving) return
    setSaving(true)
    await renameEntity(entity, title)
    setSaving(false)
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-entity-rename="">
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Name" onFocus={(e) => e.currentTarget.select()} />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !title.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── The two frames ──────────────────────────────────────────────────────────

/**
 * The ⋯ button and its dropdown: for a toolbar (a detail panel's header,
 * which a card shows as rows in its Properties popover, labelled).
 */
export function EntityActionsMenu({
  entity,
  state,
  omit,
  className,
  align = 'end',
}: {
  entity: EntityRef
  state?: EntityMenuState
  omit?: readonly EntityActionId[]
  className?: string
  align?: 'start' | 'end'
}) {
  const actions = useEntityActions(entity, state)
  const { openRename, renameDialog } = useEntityRenameDialog(entity)
  if (actions.filter((a) => !omit?.includes(a)).length === 0) return null
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <PreferenceActionButton
            label="More actions"
            variant="ghost"
            size="sm"
            className={className ?? 'h-7 w-7 p-0 text-muted-foreground hover:text-foreground'}
            data-entity-actions-trigger=""
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </PreferenceActionButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-52">
          <EntityActionsMenuItems entity={entity} state={state} omit={omit} variant="dropdown" onRename={openRename} />
        </DropdownMenuContent>
      </DropdownMenu>
      {renameDialog}
    </>
  )
}

/**
 * Right-click on `children` (a chip, a row) for the record's actions. The
 * child is the trigger itself (asChild), so nothing is added to the layout.
 */
export function EntityContextMenu({
  entity,
  state,
  omit,
  from,
  children,
}: {
  entity: EntityRef
  state?: EntityMenuState
  omit?: readonly EntityActionId[]
  from?: string
  children: React.ReactElement
}) {
  const actions = useEntityActions(entity, state)
  const { openRename, renameDialog } = useEntityRenameDialog(entity)
  if (actions.filter((a) => !omit?.includes(a)).length === 0) return children
  return (
    <>
      <ContextMenu modal={false}>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <EntityActionsMenuItems entity={entity} state={state} omit={omit} variant="context" onRename={openRename} from={from} />
        </ContextMenuContent>
      </ContextMenu>
      {renameDialog}
    </>
  )
}
