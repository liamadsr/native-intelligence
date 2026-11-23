/**
 * Drive's file list as one list (docs/plans/drive-files.md, phase 2): files
 * uploaded to records, files sent in team chat and, behind their own filter,
 * files attached to the person's mail, each read from its own source with
 * that source's own rule, then shown together. Pure: the shapes, the type
 * groups the filter offers, and the merge and sort.
 */
import type { WorkspaceFile } from '@/lib/attachments/workspace-files-model'
import { viewerKindOf } from '@/lib/files/viewer-kind'
import type { DriveChatFile } from './chat-files'
import type { MailFile } from './mail-files'

export type DriveSource = 'upload' | 'team_chat' | 'email'

export const DRIVE_SOURCE_LABELS: Readonly<Record<DriveSource, string>> = {
  upload: 'Uploads',
  team_chat: 'Team chat',
  email: 'Email attachments',
}

/** The kinds the type filter offers. */
export const DRIVE_TYPES = ['pdf', 'document', 'sheet', 'slides', 'image', 'video', 'audio', 'other'] as const
export type DriveType = (typeof DRIVE_TYPES)[number]

export const DRIVE_TYPE_LABELS: Readonly<Record<DriveType, string>> = {
  pdf: 'PDFs',
  document: 'Documents',
  sheet: 'Spreadsheets',
  slides: 'Presentations',
  image: 'Images',
  video: 'Videos',
  audio: 'Audio',
  other: 'Other',
}

/** A file's type group, by its name and MIME type (the viewer's own kinds, grouped). */
export function driveTypeOf(name: string, mimeType?: string | null): DriveType {
  const lower = name.toLowerCase()
  const kind = viewerKindOf({ name, mimeType })
  switch (kind) {
    case 'pdf':
      return 'pdf'
    case 'docx':
    case 'text':
      return 'document'
    case 'sheet':
      return 'sheet'
    case 'pptx':
      return 'slides'
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    default:
      if (/\.(doc|rtf|odt|pages)$/.test(lower)) return 'document'
      if (/\.(xls|ods|numbers)$/.test(lower)) return 'sheet'
      if (/\.(ppt|odp|key)$/.test(lower)) return 'slides'
      if (/\.(heic|heif|tiff?)$/.test(lower)) return 'image'
      return 'other'
  }
}

export interface DriveItem {
  key: string
  source: DriveSource
  name: string
  mimeType: string | null
  size: number | null
  type: DriveType
  /** When it arrived (ISO). */
  createdAt: string
  /** When it last changed (an upload renamed); its arrival for a file that never changes. */
  modifiedAt: string
  /** When the person last opened it in Drive, when they have. */
  openedAt?: string | null
  /** Where it lives, in words ("Project · Website refresh", "#design", "Re: Q3 plan"). */
  where: string
  /** Who put it there, when known: a member (uploads and chat carry theirs), or a sender's address. */
  creator: { memberId?: string | null; userId?: string | null; label?: string | null }
  upload?: WorkspaceFile & { user_id?: string | null }
  chat?: DriveChatFile
  mail?: MailFile
}

export const PARENT_NOUN: Record<WorkspaceFile['parent']['type'], string> = { capture: 'Capture', action: 'Action', row: 'Row', project: 'Project', drive: 'Drive' }

export function itemFromUpload(file: WorkspaceFile & { user_id?: string | null }): DriveItem {
  return {
    key: `upload:${file.id}`,
    source: 'upload',
    name: file.file_name,
    mimeType: file.mime_type,
    size: file.file_size_bytes,
    type: driveTypeOf(file.file_name, file.mime_type),
    createdAt: file.created_at,
    modifiedAt: file.updated_at ?? file.created_at,
    where:
      file.parent.type === 'drive'
        ? file.parent.folder
          ? `Folder · ${file.parent.folder.name}`
          : 'Drive · only you'
        : `${PARENT_NOUN[file.parent.type]} · ${file.parent.label}${file.parent.table ? ` in ${file.parent.table.name}` : ''}`,
    creator: { userId: file.user_id ?? null },
    upload: file,
  }
}

export function itemFromChat(file: DriveChatFile): DriveItem {
  return {
    key: `team_chat:${file.key}`,
    source: 'team_chat',
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    type: driveTypeOf(file.name, file.mimeType),
    createdAt: file.createdAt,
    modifiedAt: file.createdAt,
    where: file.channel.kind === 'dm' ? 'Direct message' : `#${file.channel.name ?? 'channel'}`,
    creator: { memberId: file.authorMemberId },
    chat: file,
  }
}

export function itemFromMail(file: MailFile): DriveItem {
  return {
    key: `email:${file.key}`,
    source: 'email',
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    type: driveTypeOf(file.name, file.mimeType),
    createdAt: file.date ?? new Date(0).toISOString(),
    modifiedAt: file.date ?? new Date(0).toISOString(),
    where: file.subject?.trim() || '(no subject)',
    creator: { label: file.fromName || file.fromEmail },
    mail: file,
  }
}

export const DRIVE_SORTS = ['modified', 'created', 'opened', 'name', 'size'] as const
export type DriveSort = (typeof DRIVE_SORTS)[number]

export const DRIVE_SORT_LABELS: Readonly<Record<DriveSort, string>> = {
  modified: 'Last modified',
  created: 'Date added',
  opened: 'Last opened',
  name: 'Name',
  size: 'Size',
}

/**
 * Sorted copy: newest changed, newest added or most recently opened first
 * (never-opened files after, newest first), by name A–Z, or largest first;
 * ties newest first, then by key.
 */
export function sortDriveItems(items: readonly DriveItem[], sort: DriveSort): DriveItem[] {
  const t = (s: string | null | undefined) => (s ? Date.parse(s) || 0 : 0)
  const byNewest = (a: DriveItem, b: DriveItem) => t(b.createdAt) - t(a.createdAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  return [...items].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || byNewest(a, b)
    if (sort === 'size') return (b.size ?? -1) - (a.size ?? -1) || byNewest(a, b)
    if (sort === 'modified') return t(b.modifiedAt) - t(a.modifiedAt) || byNewest(a, b)
    if (sort === 'opened') return t(b.openedAt) - t(a.openedAt) || byNewest(a, b)
    return byNewest(a, b)
  })
}

/** The time a row shows for a sort: when it changed, arrived or was opened. */
export function driveItemTime(item: DriveItem, sort: DriveSort): string | null {
  if (sort === 'modified') return item.modifiedAt
  if (sort === 'opened') return item.openedAt ?? null
  return item.createdAt
}

/**
 * The items two sources' pages can show in order, newest first: every item
 * no older than the oldest item of the newest-ending source that still has
 * more (an item older than that might yet be beaten by that source's next
 * page). With no source left to read, all of them.
 */
export function mergeReady(pages: ReadonlyArray<{ items: readonly DriveItem[]; more: boolean }>): { ready: DriveItem[]; held: DriveItem[] } {
  const all = sortDriveItems(pages.flatMap((p) => p.items), 'created')
  let floor = Number.NEGATIVE_INFINITY
  for (const p of pages) {
    if (!p.more) continue
    const oldest = p.items.reduce((min, i) => Math.min(min, Date.parse(i.createdAt) || 0), Number.POSITIVE_INFINITY)
    // A source with more but nothing in hand holds everything back.
    floor = Math.max(floor, oldest === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : oldest)
  }
  const ready = all.filter((i) => (Date.parse(i.createdAt) || 0) >= floor)
  const held = all.filter((i) => (Date.parse(i.createdAt) || 0) < floor)
  return { ready, held }
}
