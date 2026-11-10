'use client'

/**
 * ConversationComposer — the main chat's composer for a conversation that
 * isn't the main chat: a teammate's own thread, a work run's chat, a loop
 * run's chat (bots v4: the floating chat Open in Native Intelligence opens is "just as
 * capable" as the main one). It is ChatInput itself, fed by the state every
 * ChatInput host keeps (composer-state.ts), so everything the main composer
 * does, it does here:
 *
 *   - skills: picked from "/". The armed skill rides the turn; a one-turn
 *     skill is released once it's sent, a sticky one (Scout) stays armed, as
 *     in the main chat.
 *   - files: the + menu, a drop, a paste (uploaded at once to the user's own
 *     chat-uploads folder, sent when ready). A conversation that can't take
 *     photos yet names why (`unavailable.photos`): the + menu shows them
 *     dimmed with that reason, and a dropped or pasted photo becomes an error
 *     chip saying it, never uploaded or sent.
 *   - @-mentions: captures, people and companies.
 *   - dictation and voice mode (the host's `voice`); a spoken turn comes
 *     through here (`spokenTurnRef`), so it carries what a typed one does.
 *   - stop.
 *
 * What a conversation can't honour, the host names in `unavailable`, and the
 * composer shows it dimmed with the reason (never dropped). The turn's text
 * and its extras (ComposerTurnExtras) go to `onSend`, which sends them the
 * conversation's own way (chatAgentTurnBody, runChatTurnBody) to the exact
 * conversation it is: the teammate's thread, the run's parked session.
 *
 * As in the main chat, a send clears the box, the chips and a one-turn skill
 * at once. One that didn't go out (`onSend` resolves false: the conversation
 * couldn't take it) gives them back, unless something new took their place.
 * A typed send waits while a reply streams, or while the conversation is
 * still opening (`holdSend`); a spoken one doesn't (voice mode stops the
 * reply first).
 *
 * The text is the host's (controlled), so a host keeps its drafts. The app's
 * one Capture and the capture page's slots stay in the main composer
 * (mainComposer false). `workspaceId` is the conversation's: its skills and
 * mentions are read there (composer-workspace.ts).
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { isDesktopApp } from '@/lib/platform'
import { isChatImageUpload } from '@/lib/chat/upload-allowlist'
import { isStickySkill } from '../prospecting/start-event'
import { ChatInput, type ChatInputUnavailable, type ChatInputVoice } from './chat-input'
import type { SkillCommand } from './chat-panel'
import { ComposerWorkspaceContext } from './composer-workspace'
import {
  attachedFilesText,
  chatFilesMeta,
  chatFileUIParts,
  clearStaleModelPicks,
  readyChatFiles,
  useComposerFiles,
  useComposerMentions,
  type ComposerTurnExtras,
} from './composer-state'

export interface ConversationComposerProps {
  /** What's typed (the host keeps it, and its drafts). */
  value: string
  onChange: (value: string) => void
  /** Send one turn the conversation's own way; resolves whether it went out (false: it's given back). */
  onSend: (text: string, extras: ComposerTurnExtras) => Promise<boolean>
  onStop: () => void
  /** A reply is on its way: typed sends wait, send's slot is stop. */
  isLoading: boolean
  /** The conversation can't take a message yet (its thread is still opening). */
  holdSend?: boolean
  placeholder?: string
  /** The conversation has messages ("Continue chat"). */
  hasMessages?: boolean
  autoFocus?: boolean
  /** False while the window or tab it's in is hidden: its pickers close. */
  isActive?: boolean
  /** Dictation and voice mode (the desktop app). */
  voice?: ChatInputVoice
  /** Controls this conversation can't honour, with the reason each is shown dimmed for. */
  unavailable?: ChatInputUnavailable
  /** The conversation's workspace: its skills and mentions are read there. */
  workspaceId?: string | null
  /** Filled with this composer's send for a spoken turn (voice mode); null once it's gone. */
  spokenTurnRef?: MutableRefObject<((text: string) => Promise<boolean>) | null>
  /** A typed message went out (a host waiting on a spoken answer stops waiting). */
  onTypedSend?: () => void
}

const NO_MENTIONS: ComposerTurnExtras['mentions'] = { noteIds: [], contactIds: [], companyIds: [] }

export function ConversationComposer({
  value,
  onChange,
  onSend,
  onStop,
  isLoading,
  holdSend = false,
  placeholder,
  hasMessages = false,
  autoFocus = false,
  isActive = true,
  voice,
  unavailable,
  workspaceId = null,
  spokenTurnRef,
  onTypedSend,
}: ConversationComposerProps) {
  const {
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
  } = useComposerMentions()
  // A photo where the conversation can't take one: refused, with the reason.
  const photosReason = unavailable?.photos?.reason ?? null
  const refuseFile = useCallback(
    (file: File) => (photosReason && isChatImageUpload(file) ? photosReason : null),
    [photosReason],
  )
  const { attachedFiles, setAttachedFiles, handleAttachFiles, handleRemoveFile, clearSentFiles } = useComposerFiles({ refuse: refuseFile })
  // The old model picker's remembered thinking levels: dropped once per page load.
  useEffect(() => {
    clearStaleModelPicks()
  }, [])
  const [activeSkill, setActiveSkill] = useState<SkillCommand | null>(null)
  const activeSkillRef = useRef(activeSkill)
  activeSkillRef.current = activeSkill

  // The latest of everything a send reads, so the callbacks handed to the
  // (memoized) ChatInput stay stable.
  const latest = useRef({ value, onChange, onSend, holdSend, isLoading, onTypedSend, attachedFiles, attachedNotes, attachedContacts, attachedCompanies, attachedRecords })
  latest.current = { value, onChange, onSend, holdSend, isLoading, onTypedSend, attachedFiles, attachedNotes, attachedContacts, attachedCompanies, attachedRecords }

  /** The turn's extras: the attachments (unless it's a quick skill's) and the skill. */
  const extrasFor = useCallback(
    (skill: SkillCommand | null, ready: ReturnType<typeof readyChatFiles> | null): ComposerTurnExtras => ({
      files: ready ? chatFileUIParts(ready) : [],
      chatFiles: ready ? chatFilesMeta(ready) : [],
      mentions: ready
        ? {
            noteIds: attachedNoteIdsRef.current,
            contactIds: attachedContactIdsRef.current,
            companyIds: attachedCompanyIdsRef.current,
            ...(attachedRecordsRef.current.length ? { records: attachedRecordsRef.current } : {}),
          }
        : NO_MENTIONS,
      skill: skill ? { id: skill.id, slug: skill.slug, name: skill.name } : null,
      isDesktopClient: isDesktopApp(),
    }),
    [attachedNoteIdsRef, attachedContactIdsRef, attachedCompanyIdsRef, attachedRecordsRef],
  )

  /** The skill once its message has gone: a one-turn skill is released, a sticky one stays armed. */
  const releaseSkillAfterSend = useCallback(() => {
    if (isStickySkill(activeSkillRef.current?.slug)) return
    activeSkillRef.current = null
    setActiveSkill(null)
  }, [])

  /** Send what's typed (`spoken`: a voice-mode turn's words instead), with everything attached. */
  const submit = useCallback(
    async (spoken: string | null): Promise<boolean> => {
      const now = latest.current
      const spokenTurn = spoken !== null
      if (now.holdSend || (!spokenTurn && now.isLoading)) return false
      const ready = readyChatFiles(now.attachedFiles)
      const typed = spokenTurn ? spoken.trim() : now.value.trim()
      if (!typed && ready.length === 0) return false
      const text = typed || attachedFilesText(ready.length)
      const skill = activeSkillRef.current
      const extras = extrasFor(skill, ready)
      const before = {
        notes: now.attachedNotes,
        contacts: now.attachedContacts,
        companies: now.attachedCompanies,
        records: now.attachedRecords,
        files: ready,
        skill,
      }

      if (!spokenTurn) {
        now.onChange('')
        now.onTypedSend?.()
      }
      clearMentions()
      clearSentFiles()
      releaseSkillAfterSend()

      const sent = await now.onSend(text, extras)
      if (!sent) {
        // Not sent: give back what nothing new has taken the place of.
        if (!spokenTurn && typed && !latest.current.value.trim()) latest.current.onChange(typed)
        setAttachedNotes((cur) => (cur.length ? cur : before.notes))
        setAttachedContacts((cur) => (cur.length ? cur : before.contacts))
        setAttachedCompanies((cur) => (cur.length ? cur : before.companies))
        setAttachedRecords((cur) => (cur.length ? cur : before.records))
        setAttachedFiles((cur) => [...before.files.filter((f) => !cur.some((c) => c.id === f.id)), ...cur])
        if (before.skill && !activeSkillRef.current) {
          activeSkillRef.current = before.skill
          setActiveSkill(before.skill)
        }
      }
      return sent
    },
    [
      extrasFor,
      clearMentions,
      clearSentFiles,
      releaseSkillAfterSend,
      setAttachedNotes,
      setAttachedContacts,
      setAttachedCompanies,
      setAttachedRecords,
      setAttachedFiles,
    ],
  )

  const handleSubmit = useCallback(() => {
    void submit(null)
  }, [submit])

  // A spoken turn (voice mode, the host's) goes out through here.
  useEffect(() => {
    if (!spokenTurnRef) return
    spokenTurnRef.current = (text: string) => submit(text)
    return () => {
      spokenTurnRef.current = null
    }
  }, [spokenTurnRef, submit])

  const handleClearSkill = useCallback(() => {
    activeSkillRef.current = null
    setActiveSkill(null)
  }, [])

  return (
    <ComposerWorkspaceContext.Provider value={workspaceId}>
      <ChatInput
        value={value}
        onChange={onChange}
        onSubmit={handleSubmit}
        onStop={onStop}
        isLoading={isLoading}
        attachedNotes={attachedNotes}
        onAttachNote={handleAttachNote}
        onRemoveNote={handleRemoveNote}
        attachedContacts={attachedContacts}
        onAttachContact={handleAttachContact}
        onRemoveContact={handleRemoveContact}
        attachedCompanies={attachedCompanies}
        onAttachCompany={handleAttachCompany}
        onRemoveCompany={handleRemoveCompany}
        attachedRecords={attachedRecords}
        onAttachRecord={handleAttachRecord}
        onRemoveRecord={handleRemoveRecord}
        attachedFiles={attachedFiles}
        onAttachFiles={handleAttachFiles}
        onRemoveFile={handleRemoveFile}
        activeSkill={activeSkill}
        onActivateSkill={setActiveSkill}
        onClearSkill={handleClearSkill}
        placeholder={placeholder}
        hasMessages={hasMessages}
        autoFocus={autoFocus}
        isActive={isActive}
        voice={voice}
        mainComposer={false}
        unavailable={unavailable}
      />
    </ComposerWorkspaceContext.Provider>
  )
}
