/**
 * What the full composer adds to a run-chat POST (bots v4; runChatTurnBody in
 * composer-state.ts), parsed and capped: the picked skill's id, the uploads'
 * storage facts and the @-mentions. Pure (no runtime imports), so the
 * run-chat routes parse a body without loading the turn builder
 * (run-chat-turn.ts), which checks and renders each piece.
 *
 * A body that still carries the removed "My captures" `searchSettings` is
 * read without it: the agent picks each search's scope itself.
 */

import { MENTION_RECORD_KEYS } from '@/lib/search/menu-search'

/** Files one turn may carry. */
export const RUN_CHAT_MAX_FILES = 8
/** Mentions of each kind one turn may carry. */
export const RUN_CHAT_MAX_MENTIONS = 10

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SKILL_ID = /^[\w-]{1,64}$/

/**
 * One upload the composer attached (its storage facts; the bytes stay in
 * storage). Only the path is trusted, once checked as the caller's own: the
 * size and type are the client's word, never used to decide what's read.
 */
export interface RunChatFileRef {
  storagePath: string
  fileName: string
  fileSize: number
  mimeType: string
}

/** The @-mentions a run-chat turn carries: captures, people and companies, and the records (each kind only when there are some). */
export interface RunChatMentions {
  captureIds: string[]
  contactIds: string[]
  companyIds: string[]
  actionIds?: string[]
  documentIds?: string[]
  projectIds?: string[]
  initiativeIds?: string[]
  dealIds?: string[]
  flowIds?: string[]
  fileIds?: string[]
  calendarEventIds?: string[]
  studioVideoIds?: string[]
}

/** The record kinds a run-chat turn mentions by id, as their body keys (MENTION_RECORD_KEYS' run names). */
const RECORD_MENTION_KEYS = Object.values(MENTION_RECORD_KEYS).map((k) => k.run) as Array<
  'actionIds' | 'documentIds' | 'projectIds' | 'initiativeIds' | 'dealIds' | 'flowIds' | 'fileIds' | 'calendarEventIds' | 'studioVideoIds'
>

/** What the composer adds to a run-chat POST, parsed. */
export interface RunChatTurnExtras {
  skillId?: string
  files?: RunChatFileRef[]
  mentions?: RunChatMentions
}

/**
 * The composer's extras off a run-chat POST body (runChatTurnBody), or the
 * reason it's malformed (the route answers 400). Unknown keys (search
 * settings among them) are ignored. A file's declared size and type are kept
 * as the client's word only: the turn builder reads the stored object's own.
 */
export function parseRunChatTurnExtras(b: Record<string, unknown>): RunChatTurnExtras | { error: string } {
  const out: RunChatTurnExtras = {}

  if (b.skillId !== undefined) {
    if (typeof b.skillId !== 'string' || !SKILL_ID.test(b.skillId)) return { error: 'skillId must be a skill id' }
    out.skillId = b.skillId
  }

  if (b.files !== undefined) {
    if (!Array.isArray(b.files)) return { error: 'files must be an array' }
    if (b.files.length > RUN_CHAT_MAX_FILES) return { error: `files may have at most ${RUN_CHAT_MAX_FILES} entries` }
    const files: RunChatFileRef[] = []
    for (const raw of b.files) {
      if (!raw || typeof raw !== 'object') return { error: 'each file must be an object' }
      const f = raw as Record<string, unknown>
      if (typeof f.storagePath !== 'string' || !f.storagePath || f.storagePath.length > 512) return { error: 'each file needs its storagePath' }
      if (typeof f.fileName !== 'string' || !f.fileName || f.fileName.length > 255) return { error: 'each file needs its fileName' }
      const fileSize = typeof f.fileSize === 'number' && Number.isFinite(f.fileSize) && f.fileSize >= 0 ? f.fileSize : 0
      const mimeType = typeof f.mimeType === 'string' ? f.mimeType.slice(0, 127) : ''
      files.push({ storagePath: f.storagePath, fileName: f.fileName, fileSize, mimeType })
    }
    if (files.length > 0) out.files = files
  }

  if (b.mentions !== undefined) {
    if (!b.mentions || typeof b.mentions !== 'object' || Array.isArray(b.mentions)) return { error: 'mentions must be an object' }
    const m = b.mentions as Record<string, unknown>
    const ids = (key: string): string[] | { error: string } => {
      const raw = m[key]
      if (raw === undefined) return []
      if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string' && UUID.test(id))) return { error: `mentions.${key} must be ids` }
      const unique = [...new Set(raw as string[])]
      if (unique.length > RUN_CHAT_MAX_MENTIONS) return { error: `mentions.${key} may have at most ${RUN_CHAT_MAX_MENTIONS} entries` }
      return unique
    }
    const captureIds = ids('captureIds')
    if ('error' in captureIds) return captureIds
    const contactIds = ids('contactIds')
    if ('error' in contactIds) return contactIds
    const companyIds = ids('companyIds')
    if ('error' in companyIds) return companyIds
    const records: Partial<Record<(typeof RECORD_MENTION_KEYS)[number], string[]>> = {}
    for (const key of RECORD_MENTION_KEYS) {
      const found = ids(key)
      if ('error' in found) return found
      if (found.length) records[key] = found
    }
    if (captureIds.length || contactIds.length || companyIds.length || Object.keys(records).length) {
      out.mentions = { captureIds, contactIds, companyIds, ...records }
    }
  }

  return out
}

/** Whether the extras carry anything for the turn. */
export function hasRunChatTurnExtras(extras: RunChatTurnExtras): boolean {
  return !!(extras.skillId || extras.files?.length || extras.mentions)
}
