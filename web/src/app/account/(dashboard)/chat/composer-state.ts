'use client'

/**
 * The main composer's state, shared by every chat that puts ChatInput on
 * screen: the main chat (ChatPanel) and the conversations that aren't it, a
 * teammate's own thread and a run's chat (ConversationComposer, bots v4 "the
 * floating chat is just as capable"). One implementation of each piece, so
 * the two never drift:
 *
 *   useComposerMentions      what's @-mentioned this turn (captures, people, companies)
 *   useComposerFiles         files and photos attached (uploaded at once, sent when ready)
 *   useComposerFolders       + → Select folder…: adds to the person's environment for
 *                            local agents (folders on their Mac, every chat; main chat only)
 *   useComposerEnvironment   the selector under the box: where this chat's work runs
 *                            (a Mac or a cloud environment; main chat only)
 *
 * and the pure pieces a send builds from them (the message's file parts, the
 * uploads' storage facts, the text of a files-only turn). No model: the server
 * picks one per turn, so no composer carries a model or a thinking level.
 *
 * A conversation that isn't the main chat sends a ComposerTurn's extras its
 * own way: a teammate's thread as the main chat's body (chatAgentTurnBody), a
 * run's chat as the run-chat route's (runChatTurnBody).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileUIPart } from 'ai'
import {
  ENVIRONMENTS_FRESH_MS,
  ENVIRONMENT_FRESH_MS,
  addEnvironmentFolder,
  checkLocalAgents,
  pickChatEnvironment,
  refreshEnvironment,
  refreshEnvironments,
  useChatEnvironment,
  useEnvironments,
  useLocalEnvironment,
  type ChatEnvironment,
  type EnvironmentItem,
  type EnvironmentsSnapshot,
} from '@/lib/local-agent/environment-client'
import { validateChatUpload } from '@/lib/chat/upload-allowlist'
import { uploadChatFile, ChatUploadError } from '@/lib/chat/upload-client'
import type { CaptureListItem } from '../views/capture-utils'
import type { MentionCompany, MentionContact } from './mention-picker'
import type { MentionRecord, MentionRecordKind } from '@/lib/search/menu-search'
import type { ChatFileAttachment } from './chat-panel'

// ── Mentions ────────────────────────────────────────────────────────────────

/** What's @-mentioned in the turn being written: captures, people, companies, and actions, docs, projects and initiatives. */
export function useComposerMentions() {
  const [attachedNotes, setAttachedNotes] = useState<CaptureListItem[]>([])
  const [attachedContacts, setAttachedContacts] = useState<MentionContact[]>([])
  const [attachedCompanies, setAttachedCompanies] = useState<MentionCompany[]>([])
  const [attachedRecords, setAttachedRecords] = useState<MentionRecord[]>([])

  // Refs, so a send that resolves its body later (or a stable callback) reads
  // the ids as they stand, not as the closure captured them.
  const attachedNoteIdsRef = useRef<string[]>([])
  useEffect(() => {
    attachedNoteIdsRef.current = attachedNotes.map((n) => n.id)
  }, [attachedNotes])
  const attachedContactIdsRef = useRef<string[]>([])
  useEffect(() => {
    attachedContactIdsRef.current = attachedContacts.map((c) => c.id)
  }, [attachedContacts])
  const attachedCompanyIdsRef = useRef<string[]>([])
  useEffect(() => {
    attachedCompanyIdsRef.current = attachedCompanies.map((c) => c.id)
  }, [attachedCompanies])
  const attachedRecordsRef = useRef<MentionRecord[]>([])
  useEffect(() => {
    attachedRecordsRef.current = attachedRecords
  }, [attachedRecords])

  const handleAttachNote = useCallback((note: CaptureListItem) => {
    setAttachedNotes((prev) => (prev.some((n) => n.id === note.id) ? prev : [...prev, note]))
  }, [])
  const handleRemoveNote = useCallback((noteId: string) => {
    setAttachedNotes((prev) => prev.filter((n) => n.id !== noteId))
  }, [])
  const handleAttachContact = useCallback((contact: MentionContact) => {
    setAttachedContacts((prev) => (prev.some((c) => c.id === contact.id) ? prev : [...prev, contact]))
  }, [])
  const handleRemoveContact = useCallback((contactId: string) => {
    setAttachedContacts((prev) => prev.filter((c) => c.id !== contactId))
  }, [])
  const handleAttachCompany = useCallback((company: MentionCompany) => {
    setAttachedCompanies((prev) => (prev.some((c) => c.id === company.id) ? prev : [...prev, company]))
  }, [])
  const handleRemoveCompany = useCallback((companyId: string) => {
    setAttachedCompanies((prev) => prev.filter((c) => c.id !== companyId))
  }, [])
  const handleAttachRecord = useCallback((record: MentionRecord) => {
    setAttachedRecords((prev) => (prev.some((r) => r.id === record.id) ? prev : [...prev, record]))
  }, [])
  const handleRemoveRecord = useCallback((recordId: string) => {
    setAttachedRecords((prev) => prev.filter((r) => r.id !== recordId))
  }, [])

  /** Sent: the chips leave the box. */
  const clearMentions = useCallback(() => {
    setAttachedNotes([])
    setAttachedContacts([])
    setAttachedCompanies([])
    setAttachedRecords([])
  }, [])

  return {
    attachedNotes,
    attachedContacts,
    attachedCompanies,
    attachedRecords,
    setAttachedNotes,
    setAttachedContacts,
    setAttachedCompanies,
    setAttachedRecords,
    attachedNoteIdsRef,
    attachedContactIdsRef,
    attachedCompanyIdsRef,
    attachedRecordsRef,
    handleAttachNote,
    handleRemoveNote,
    handleAttachContact,
    handleRemoveContact,
    handleAttachCompany,
    handleRemoveCompany,
    handleAttachRecord,
    handleRemoveRecord,
    clearMentions,
  }
}

// ── Files ───────────────────────────────────────────────────────────────────

/**
 * Files and photos attached to the turn being written (the + menu, a drop, a
 * pasted screenshot). Each is checked against the chat allowlist, then
 * uploaded straight away (uploadChatFile: the user's own chat-uploads folder);
 * a send takes the ready ones, and one still uploading stays for the next.
 *
 * `refuse`: a conversation that can't take some files (a run's chat or a
 * teammate's thread can't take photos yet) names why for each; a refused file
 * shows as an error chip with that reason, never uploaded and never sent.
 */
export function useComposerFiles({ refuse }: { refuse?: (file: File) => string | null } = {}) {
  const [attachedFiles, setAttachedFiles] = useState<ChatFileAttachment[]>([])
  const refuseRef = useRef(refuse)
  refuseRef.current = refuse

  const handleAttachFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      const id = crypto.randomUUID()

      const refused = refuseRef.current?.(file) ?? null
      if (refused) {
        setAttachedFiles((prev) => [...prev, { id, file, status: 'error' as const, error: refused }])
        continue
      }

      const check = validateChatUpload(file)
      if (!check.ok) {
        setAttachedFiles((prev) => [...prev, { id, file, status: 'error' as const, error: check.reason }])
        continue
      }

      setAttachedFiles((prev) => [...prev, { id, file, status: 'uploading' as const }])

      try {
        const data = await uploadChatFile(file)
        setAttachedFiles((prev) =>
          prev.map((f) => (f.id === id ? { ...f, status: 'ready' as const, url: data.url, storagePath: data.storagePath } : f)),
        )
      } catch (err) {
        const message = err instanceof ChatUploadError ? err.message : 'Upload failed'
        setAttachedFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status: 'error' as const, error: message } : f)))
      }
    }
  }, [])

  const handleRemoveFile = useCallback((fileId: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== fileId))
  }, [])

  /** Sent: only the sent (ready/error) files leave the box; an upload still in flight stays for the next message. */
  const clearSentFiles = useCallback(() => {
    setAttachedFiles((prev) => prev.filter((f) => f.status === 'uploading'))
  }, [])

  return { attachedFiles, setAttachedFiles, handleAttachFiles, handleRemoveFile, clearSentFiles }
}

// ── Folders (local agents) ──────────────────────────────────────────────────

/**
 * What the composer's + menu does with the person's environment
 * (docs/plans/local-agents.md): folders on their Mac the Native Intelligence agent can work
 * in, in every chat until they remove one. The composer shows no chips (Liam,
 * 2026-10-21); the side panel's Environment card lists and removes them, and
 * the chat spec tells the agent about them every turn (the `environment`
 * rider, read from the database, src/lib/chat/environment-section.ts).
 */
export interface ComposerFolders {
  /** Select folder… is offered: the desktop app, with local agents available there. */
  canPick: boolean
  /** The native picker (or the mirror refresh after it) is open. */
  picking: boolean
  /** Add a folder to the environment (the Mac's picker). */
  pickFolder: () => void
  /** Ask the desktop again whether local agents are available, and read the environment (the + menu opening). */
  recheck: () => void
}

/**
 * The + menu's Select folder…, over the shared store
 * (src/lib/local-agent/environment-client.ts, which the side panel's
 * Environment card reads too). It adds to the environment, desktop only. Off
 * (`enabled: false`): no menu item, nothing read.
 */
export function useComposerFolders({ enabled }: { enabled: boolean }): ComposerFolders {
  const { canEdit, picking } = useLocalEnvironment({ enabled })
  const recheck = useCallback(() => {
    if (!enabled) return
    void checkLocalAgents({ force: true })
    void refreshEnvironment({ maxAgeMs: ENVIRONMENT_FRESH_MS })
  }, [enabled])
  const pickFolder = useCallback(() => {
    void addEnvironmentFolder()
  }, [])
  return useMemo(
    () => ({ canPick: enabled && canEdit, picking: enabled && picking, pickFolder, recheck }),
    [enabled, canEdit, picking, pickFolder, recheck],
  )
}

// ── Environment (where the chat's work runs) ───────────────────────────────

/**
 * The composer's environment selector (components/environments/
 * environment-selector.tsx, docs/plans/environments.md §6), over the shared
 * store: the chat's environment (read once per conversation), and your
 * environments, read when the menu opens. `visible` is false while you have
 * neither a Mac nor a cloud environment (hide empty widgets): when the chat
 * has none, the list is read once to know.
 */
export interface ComposerEnvironment {
  visible: boolean
  chat: ChatEnvironment
  list: EnvironmentsSnapshot
  openMenu: () => void
  pick: (environment: EnvironmentItem) => void
}

/** Menu opens this close together read the list once. */
const MENU_READ_FRESH_MS = 2_000

export function useComposerEnvironment({ enabled, conversationId }: { enabled: boolean; conversationId: string | null }): ComposerEnvironment {
  const chat = useChatEnvironment(conversationId, { enabled })
  const list = useEnvironments({ enabled, read: false })
  const none = chat.loaded && !chat.environment
  useEffect(() => {
    if (enabled && none) void refreshEnvironments({ maxAgeMs: ENVIRONMENTS_FRESH_MS })
  }, [enabled, none])
  const openMenu = useCallback(() => {
    if (enabled) void refreshEnvironments({ maxAgeMs: MENU_READ_FRESH_MS })
  }, [enabled])
  const pick = useCallback((environment: EnvironmentItem) => void pickChatEnvironment(conversationId, environment), [conversationId])
  const visible = enabled && (!!chat.environment || list.environments.length > 0)
  return useMemo(() => ({ visible, chat, list, openMenu, pick }), [visible, chat, list, openMenu, pick])
}

/** The ready uploads a send carries. */
export function readyChatFiles(files: readonly ChatFileAttachment[]): ChatFileAttachment[] {
  return files.filter((f) => f.status === 'ready')
}

/** The ready uploads as the message's file parts (the bubble shows them; the main chat's eve turn sees the images). */
export function chatFileUIParts(ready: readonly ChatFileAttachment[]): FileUIPart[] {
  return ready
    .filter((f) => f.url)
    .map((f) => ({
      type: 'file' as const,
      mediaType: f.file.type,
      filename: f.file.name,
      url: f.url!,
    }))
}

/** One upload's storage facts: what the agent reads a text file by, or attaches a file by. */
export interface ChatFileMeta {
  storagePath: string
  fileName: string
  fileSize: number
  mimeType: string
}

/** The ready uploads' storage facts (the main chat's `systemContext.chatFiles`). */
export function chatFilesMeta(ready: readonly ChatFileAttachment[]): ChatFileMeta[] {
  return ready.map((f) => ({
    storagePath: f.storagePath as string,
    fileName: f.file.name,
    fileSize: f.file.size,
    mimeType: f.file.type,
  }))
}

/** The text of a turn that is only files. */
export function attachedFilesText(count: number): string {
  return `[Attached ${count} file${count > 1 ? 's' : ''}]`
}

// ── Stale model picks ───────────────────────────────────────────────────────

/**
 * Where the old composer remembered its thinking level per model. The server
 * picks the model now, so nothing reads it: a chat's mount drops it once.
 */
export const STALE_THINKING_STORAGE_KEY = 'ni.chat.thinking'

let staleModelPicksCleared = false

/**
 * Drop what the old model picker left in localStorage (its thinking levels;
 * the model itself was never stored), once per page load. Storage that
 * throws (a private window, blocked site data) is left alone.
 */
export function clearStaleModelPicks(): void {
  if (staleModelPicksCleared) return
  staleModelPicksCleared = true
  try {
    localStorage.removeItem(STALE_THINKING_STORAGE_KEY)
  } catch {}
}

// ── A turn from a conversation that isn't the main chat ─────────────────────

/** The armed skill, as a turn names it. */
export interface ComposerTurnSkill {
  id: string
  slug: string
  name: string
}

/** What the main composer adds to a message beside its text (ConversationComposer). */
export interface ComposerTurnExtras {
  /** The ready uploads as the message's file parts. */
  files: FileUIPart[]
  /** The same uploads' storage facts, for the server. */
  chatFiles: ChatFileMeta[]
  /** @-mentions: capture, contact and company ids, and the actions, docs, projects and initiatives. */
  mentions: { noteIds: string[]; contactIds: string[]; companyIds: string[]; records?: MentionRecord[] }
  /** The armed skill, if any. */
  skill: ComposerTurnSkill | null
  /** Sent from the desktop app (the Mac's local-agent tools are offered there). */
  isDesktopClient: boolean
}

const hasMentions = (m: ComposerTurnExtras['mentions']) =>
  m.noteIds.length > 0 || m.contactIds.length > 0 || m.companyIds.length > 0 || (m.records?.length ?? 0) > 0

/** The mentioned records' ids by kind, each key only when there are some (`<prefix>ActionIds`…). */
function recordIdsBody(records: readonly MentionRecord[] | undefined, keys: Record<MentionRecordKind, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const kind of Object.keys(keys) as MentionRecordKind[]) {
    const ids = (records ?? []).filter((r) => r.kind === kind).map((r) => r.id)
    if (ids.length) out[keys[kind]] = ids
  }
  return out
}
const SYSTEM_CONTEXT_RECORD_KEYS: Record<MentionRecordKind, string> = {
  action: 'attachedActionIds',
  document: 'attachedDocumentIds',
  project: 'attachedProjectIds',
  initiative: 'attachedInitiativeIds',
}
const RUN_CHAT_RECORD_KEYS: Record<MentionRecordKind, string> = {
  action: 'actionIds',
  document: 'documentIds',
  project: 'projectIds',
  initiative: 'initiativeIds',
}

/**
 * A teammate thread's send body (it runs on the main chat's eve runtime, so
 * it carries what a main-chat send does): the turn's system context
 * (mentions, uploads, the desktop flag) and the skill. No agent: the teammate
 * is the conversation's persona. No model: the server picks one per turn.
 */
export function chatAgentTurnBody(extras: ComposerTurnExtras): Record<string, unknown> {
  const { mentions, chatFiles } = extras
  return {
    systemContext: {
      ...(extras.isDesktopClient ? { isDesktopClient: true } : {}),
      ...(mentions.noteIds.length > 0 ? { attachedNoteIds: mentions.noteIds } : {}),
      ...(mentions.contactIds.length > 0 ? { attachedContactIds: mentions.contactIds } : {}),
      ...(mentions.companyIds.length > 0 ? { attachedCompanyIds: mentions.companyIds } : {}),
      ...recordIdsBody(mentions.records, SYSTEM_CONTEXT_RECORD_KEYS),
      ...(chatFiles.length > 0 ? { chatFiles } : {}),
    },
    ...(extras.skill ? { skillId: extras.skill.id } : {}),
  }
}

/**
 * A run chat's send body (/api/account/agent-runs/[id]/chat and
 * /api/account/activity/[id]/chat): the skill, the uploads and the mentions,
 * each checked server-side before the turn sees it.
 */
export function runChatTurnBody(extras: ComposerTurnExtras): Record<string, unknown> {
  const { mentions, chatFiles } = extras
  return {
    ...(extras.skill ? { skillId: extras.skill.id } : {}),
    ...(chatFiles.length > 0 ? { files: chatFiles } : {}),
    ...(hasMentions(mentions)
      ? {
          mentions: {
            ...(mentions.noteIds.length > 0 ? { captureIds: mentions.noteIds } : {}),
            ...(mentions.contactIds.length > 0 ? { contactIds: mentions.contactIds } : {}),
            ...(mentions.companyIds.length > 0 ? { companyIds: mentions.companyIds } : {}),
            ...recordIdsBody(mentions.records, RUN_CHAT_RECORD_KEYS),
          },
        }
      : {}),
  }
}
