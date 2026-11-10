/**
 * THE ONE ACTION LAYER: Open, Copy link, Copy ID, Rename, Archive / Restore,
 * Share to a team-chat channel, and Make a task from this, for a record of any
 * kind, as its entity actions descriptor (./entity-actions-registry.ts) says.
 * The menu (src/components/entities/entity-actions-menu.tsx) and the palette
 * call these; nothing here knows a kind by name.
 *
 * Every write goes through the kind's EXISTING route (the descriptor names
 * it), so that route's permission checks and side effects run exactly as they
 * do from the kind's own screens, and every write is told to the rest of the
 * app on the entity event bus (src/lib/entity-events.ts):
 *   - rename:  entity-updated with the new title;
 *   - archive: entity-updated with the archived value, then entity-deleted
 *              (the record leaves every list: the lists' reads leave archived
 *              rows out);
 *   - restore: entity-updated, then entity-created (the lists read again);
 *   - a task:  entity-created for it and for its new `about` edge.
 *
 * Act with undo (Liam's rule): nothing reversible asks first. A rename, an
 * archive, a restore and a share each toast with Undo; a new task toasts with
 * Open (deleting a task is an owner's or admin's, so it isn't offered as an
 * undo). A failed write toasts why and changes nothing locally.
 *
 * A record from another workspace (a list can show one) is written in its own
 * workspace: `workspaceId` rides as the `x-workspace-id` header.
 *
 * Client-safe. `deps` exists for tests; callers use the defaults.
 */
import { toast as sonner } from 'sonner'
import { copyTextToClipboard } from '@/lib/clipboard'
import { openTarget as openCardTarget, type OpenTarget } from '@/lib/chat-cards/open-card'
import { emitEntityCreated, emitEntityDeleted, emitEntityUpdated, type EntityKind } from '@/lib/entity-events'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import { MENTION_LABEL_MAX } from '@/lib/entity-links/mentionable'
import { entityActionsDescriptor, entityIdText, entityLink, type EntityActionId } from './entity-actions-registry'
import { parseSharedRecords, toastSharedRecords } from '@/lib/entity-access/share-toast'

/** A record as a surface knows it: its kind, id, and the words it shows as. */
export interface EntityRef {
  type: string
  id: string
  label: string
  /** Its workspace, when it may not be the one on screen. */
  workspaceId?: string | null
}

/** What the record's status is now, when the caller knows (an undo of an archive puts it back). */
export interface ArchiveContext {
  status?: string | null
}

/** A channel to share to, as the channels list gives it. */
export interface ShareChannel {
  id: string
  name: string | null
  kind: 'channel' | 'dm'
}

interface ToastOptions {
  description?: string
  action?: { label: string; onClick: () => void }
}

export interface EntityActionDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  toast: { success: (message: string, opts?: ToastOptions) => void; error: (message: string) => void }
  copy: (text: string) => Promise<boolean>
  openTarget: (target: OpenTarget, opts: { from: string; workspaceId?: string | null }) => boolean
  emitUpdated: (d: { entityType: EntityKind; id: string; fields: Record<string, unknown> }) => void
  emitDeleted: (d: { entityType: EntityKind; id: string }) => void
  emitCreated: (d: { entityType: EntityKind; id?: string }) => void
  origin: () => string
}

export const defaultEntityActionDeps: EntityActionDeps = {
  fetch: (input, init) => fetch(input, init),
  toast: {
    success: (message, opts) => void sonner.success(message, opts),
    error: (message) => void sonner.error(message),
  },
  copy: copyTextToClipboard,
  openTarget: (target, opts) => openCardTarget(target, opts),
  emitUpdated: (d) => emitEntityUpdated(d),
  emitDeleted: (d) => emitEntityDeleted(d),
  emitCreated: (d) => emitEntityCreated(d),
  origin: () => (typeof window === 'undefined' ? '' : window.location.origin),
}

const kind = (ref: EntityRef) => ref.type as EntityKind

/** How a record's name reads in a toast: quoted, short. */
function named(ref: EntityRef): string {
  const words = ref.label.replace(/\s+/g, ' ').trim()
  return words ? `“${words.length > 60 ? `${words.slice(0, 59)}…` : words}”` : 'it'
}

function headers(ref: EntityRef, json: boolean): Record<string, string> {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(ref.workspaceId ? { 'x-workspace-id': ref.workspaceId } : {}),
  }
}

async function send(deps: EntityActionDeps, ref: EntityRef, path: string, method: string, body?: unknown): Promise<Response | null> {
  try {
    return await deps.fetch(path, {
      method,
      headers: headers(ref, body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    return null
  }
}

/** The route's own words for a refusal (`{ error }`), else a generic line. */
async function why(res: Response | null, fallback: string): Promise<string> {
  if (!res) return fallback
  try {
    const data = (await res.clone().json()) as { error?: unknown }
    return typeof data.error === 'string' && data.error ? data.error : fallback
  } catch {
    return fallback
  }
}

const recordPath = (route: string, id: string) => `/api/account/${route}/${encodeURIComponent(id)}`

// ── Open, copy ──────────────────────────────────────────────────────────────

/** Open the record's card. False when its kind opens nothing. */
export function openEntity(ref: EntityRef, opts: { from?: string } = {}, deps: EntityActionDeps = defaultEntityActionDeps): boolean {
  const target = entityOpenTarget(ref.type, ref.id, ref.label)
  if (!target) return false
  return deps.openTarget(target, { from: opts.from ?? 'entity_menu', workspaceId: ref.workspaceId ?? null })
}

export async function copyEntityLink(ref: EntityRef, deps: EntityActionDeps = defaultEntityActionDeps): Promise<boolean> {
  const link = entityLink(ref.type, ref.id, deps.origin())
  if (!link) return false
  const ok = await deps.copy(link)
  if (ok) deps.toast.success('Link copied')
  else deps.toast.error("Couldn't copy the link")
  return ok
}

/** "<kind> <uuid>", the copy-ID button's text, for pasting into a prompt. */
export async function copyEntityId(ref: EntityRef, deps: EntityActionDeps = defaultEntityActionDeps): Promise<boolean> {
  const ok = await deps.copy(entityIdText(ref.type, ref.id))
  if (ok) deps.toast.success('ID copied')
  else deps.toast.error("Couldn't copy the ID")
  return ok
}

// ── Rename ──────────────────────────────────────────────────────────────────

async function writeTitle(ref: EntityRef, title: string, deps: EntityActionDeps): Promise<boolean> {
  const rename = entityActionsDescriptor(ref.type)?.rename
  if (!rename) return false
  const res = await send(deps, ref, recordPath(rename.route, ref.id), 'PATCH', { [rename.field]: title })
  if (!res?.ok) {
    deps.toast.error(await why(res, "Couldn't rename it"))
    return false
  }
  deps.emitUpdated({ entityType: kind(ref), id: ref.id, fields: { [rename.field]: title } })
  return true
}

/** Rename to `title` (trimmed; empty or unchanged does nothing), with Undo back to `ref.label`. */
export async function renameEntity(ref: EntityRef, title: string, deps: EntityActionDeps = defaultEntityActionDeps): Promise<boolean> {
  const next = title.replace(/\s+/g, ' ').trim()
  if (!next || next === ref.label.trim()) return false
  if (!(await writeTitle(ref, next, deps))) return false
  const before = ref.label
  deps.toast.success(`Renamed to ${named({ ...ref, label: next })}`, {
    action: {
      label: 'Undo',
      onClick: () => void writeTitle({ ...ref, label: next }, before, deps),
    },
  })
  return true
}

// ── Archive, restore ────────────────────────────────────────────────────────

async function writeArchived(ref: EntityRef, archived: boolean, ctx: ArchiveContext, deps: EntityActionDeps): Promise<{ ok: boolean; fields: Record<string, unknown> }> {
  const a = entityActionsDescriptor(ref.type)?.archive
  if (!a || a.kind === 'none') return { ok: false, fields: {} }
  let res: Response | null
  let fields: Record<string, unknown>
  if (a.kind === 'flag') {
    fields = { [a.column]: archived }
    res = await send(deps, ref, recordPath(a.route, ref.id), 'PATCH', fields)
  } else if (archived) {
    fields = { status: a.archived }
    res = a.via === 'delete'
      ? await send(deps, ref, recordPath(a.route, ref.id), 'DELETE')
      : await send(deps, ref, recordPath(a.route, ref.id), 'PATCH', fields)
  } else {
    const back = a.restorePrevious && ctx.status && ctx.status !== a.archived ? ctx.status : a.restore
    fields = { status: back }
    res = await send(deps, ref, recordPath(a.route, ref.id), 'PATCH', fields)
  }
  if (!res?.ok) {
    deps.toast.error(await why(res, archived ? "Couldn't archive it" : "Couldn't restore it"))
    return { ok: false, fields }
  }
  deps.emitUpdated({ entityType: kind(ref), id: ref.id, fields })
  // Archived: out of every list. Restored: the lists read again.
  if (archived) deps.emitDeleted({ entityType: kind(ref), id: ref.id })
  else deps.emitCreated({ entityType: kind(ref), id: ref.id })
  return { ok: true, fields }
}

/** Archive, the kind's own way, with Undo (which puts its status back). `ctx.status`: its status now. */
export async function archiveEntity(ref: EntityRef, ctx: ArchiveContext = {}, deps: EntityActionDeps = defaultEntityActionDeps): Promise<boolean> {
  const { ok } = await writeArchived(ref, true, {}, deps)
  if (!ok) return false
  deps.toast.success(`Archived ${named(ref)}`, {
    action: { label: 'Undo', onClick: () => void writeArchived(ref, false, ctx, deps) },
  })
  return true
}

/** Restore an archived record, with Undo (archive again). */
export async function restoreEntity(ref: EntityRef, ctx: ArchiveContext = {}, deps: EntityActionDeps = defaultEntityActionDeps): Promise<boolean> {
  const { ok } = await writeArchived(ref, false, ctx, deps)
  if (!ok) return false
  deps.toast.success(`Restored ${named(ref)}`, {
    action: { label: 'Undo', onClick: () => void writeArchived(ref, true, {}, deps) },
  })
  return true
}

// ── Share to a channel ──────────────────────────────────────────────────────

/** The `@label` a share posts: the words the record mention keeps (whitespace folded, at most MENTION_LABEL_MAX). */
export function shareMentionLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().slice(0, MENTION_LABEL_MAX).trim()
}

/**
 * The channels the person may post in, for the Share submenu (DMs and archived
 * channels left out). `workspaceId`: the record's workspace, when it may not be
 * the one on screen. A record is shared only in its own workspace's channels
 * (the post refuses another's), so those are the ones listed.
 */
export async function loadShareChannels(
  workspaceId: string | null = null,
  deps: EntityActionDeps = defaultEntityActionDeps,
): Promise<ShareChannel[]> {
  try {
    const res = await deps.fetch('/api/account/team-chat/channels', {
      cache: 'no-store',
      ...(workspaceId ? { headers: { 'x-workspace-id': workspaceId } } : {}),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { channels?: Array<ShareChannel & { archived_at?: string | null }> }
    return (data.channels ?? []).filter((c) => c.kind === 'channel' && !c.archived_at).map(({ id, name, kind: k }) => ({ id, name, kind: k }))
  } catch {
    return []
  }
}

/**
 * Post a message in `channel` that @-mentions the record, through team chat's
 * own post (which fences the record for the person and writes the message's
 * `mentions` edge). Undo deletes the message.
 *
 * A record the channel's readers can't all see (the person's private doc,
 * say) is shared with the channel by that post, as an @-mention in the
 * composer is (src/lib/entity-access/share.ts, source 'channel_share'): the
 * toast then says "Shared “Q3 plan” with #launch", and its Undo takes back
 * the grant as well as the message.
 */
export async function shareEntityToChannel(ref: EntityRef, channel: ShareChannel, deps: EntityActionDeps = defaultEntityActionDeps): Promise<boolean> {
  const d = entityActionsDescriptor(ref.type)
  const label = shareMentionLabel(ref.label)
  if (!d?.share || !label) return false
  const res = await send(deps, ref, `/api/account/team-chat/channels/${encodeURIComponent(channel.id)}/messages`, 'POST', {
    body: `@${label}`,
    records: [{ type: ref.type, id: ref.id, label }],
    share: true,
  })
  if (!res?.ok) {
    deps.toast.error(await why(res, "Couldn't share it"))
    return false
  }
  const data = (await res.json().catch(() => null)) as { message?: { id?: unknown } } | null
  const messageId = typeof data?.message?.id === 'string' ? data.message.id : null
  const takeBackMessage = async () => {
    if (!messageId) return true
    const r = await send(deps, ref, `/api/account/team-chat/messages/${encodeURIComponent(messageId)}`, 'DELETE')
    return !!r?.ok
  }
  // The post opened the record to the channel: the toast says so, and Undo takes back the grant too.
  const { shared, sharedWith } = parseSharedRecords(data)
  const audience = sharedWith ?? (channel.name ? `#${channel.name}` : null)
  if (toastSharedRecords(shared, audience, deps, { workspaceId: ref.workspaceId, onUndo: takeBackMessage })) return true
  deps.toast.success(`Shared to ${channel.name ? `#${channel.name}` : 'the channel'}`, {
    ...(messageId
      ? {
          action: {
            label: 'Undo',
            onClick: () => {
              void takeBackMessage().then((ok) => {
                if (!ok) deps.toast.error("Couldn't take it back")
              })
            },
          },
        }
      : {}),
  })
  return true
}

// ── Make a task from this ───────────────────────────────────────────────────

/** The new task's title: what it follows up on. */
export function taskTitleFor(label: string): string {
  const words = label.replace(/\s+/g, ' ').trim()
  return `Follow up: ${words || 'this'}`.slice(0, 200)
}

/**
 * A new task about the record: POST /api/account/actions with `about`, which
 * fences the record and links the task to it ('about'). Toasts with Open.
 * The new task's id, or null.
 */
export async function makeTaskFromEntity(ref: EntityRef, deps: EntityActionDeps = defaultEntityActionDeps): Promise<string | null> {
  if (!entityActionsDescriptor(ref.type)?.makeTask) return null
  const title = taskTitleFor(ref.label)
  const res = await send(deps, ref, '/api/account/actions', 'POST', { title, about: { type: ref.type, id: ref.id } })
  if (!res?.ok) {
    deps.toast.error(await why(res, "Couldn't make the task"))
    return null
  }
  const action = await res
    .json()
    .then((data: { action?: { id?: unknown; title?: unknown } }) => data.action ?? null)
    .catch(() => null)
  const id = typeof action?.id === 'string' ? action.id : null
  if (!id) return null
  deps.emitCreated({ entityType: 'action', id })
  deps.emitCreated({ entityType: 'entity_link' })
  deps.toast.success('Task made', {
    description: title,
    action: {
      label: 'Open',
      onClick: () => void deps.openTarget({ type: 'action', id, title }, { from: 'entity_menu', workspaceId: ref.workspaceId ?? null }),
    },
  })
  return id
}

// ── One entry point for the actions that need no more input ─────────────────

/** The actions `runEntityAction` does on its own (Rename needs a title, Share a channel). */
export type DirectEntityActionId = Exclude<EntityActionId, 'rename' | 'share'>

export function isDirectEntityAction(id: EntityActionId): id is DirectEntityActionId {
  return id !== 'rename' && id !== 'share'
}

/** Run one of the menu's actions that needs nothing more than the record. */
export async function runEntityAction(
  id: DirectEntityActionId,
  ref: EntityRef,
  ctx: ArchiveContext & { from?: string } = {},
  deps: EntityActionDeps = defaultEntityActionDeps,
): Promise<boolean> {
  switch (id) {
    case 'open':
      return openEntity(ref, { from: ctx.from }, deps)
    case 'copy_link':
      return copyEntityLink(ref, deps)
    case 'copy_id':
      return copyEntityId(ref, deps)
    case 'make_task':
      return (await makeTaskFromEntity(ref, deps)) !== null
    case 'archive':
      return archiveEntity(ref, ctx, deps)
    case 'restore':
      return restoreEntity(ref, ctx, deps)
  }
}
