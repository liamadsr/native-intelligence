'use client'

import { createContext, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { AlertCircle, ArrowUp, AudioLines, Building2, CalendarDays, CircleCheck, FileText, Film, FolderKanban, FolderOpen, ImageIcon, Lock, MousePointerClick, Paperclip, Plus, Target, User, Workflow, Handshake, X, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { registerReloadBlocker } from '@/lib/deploy-reload'
import { Badge } from '@/components/ui/badge'
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
  PromptInputAction,
} from '@/components/ui/prompt-input'
import type { MentionCompany, MentionContact } from './mention-picker'
import { diffMentionRemovals, mentionLabel, removeMentionOccurrence } from './mention-text'
import { SlashCommandPicker } from './slash-command-picker'
import type { CommandMenuHandle } from './command-menu'
import {
  appendMention,
  findTriggerToken,
  pickSkillText,
  removeToken,
  replaceToken,
  sameTriggerToken,
  type ComposerMentionList,
  type ComposerMentionOption,
} from './command-menu-model'
import type { OfferedPage } from '@/lib/chat-cards/page-menu'
import { SEARCH_FLIGHT_KEY, flightWaiting } from '@/lib/chat/card-reply-flight'
import { OPEN_SEARCH_EVENT, flySearchBack, launchSearchFlight, searchButton } from '@/lib/chat/open-search'
import {
  MENTION_PICKER_KINDS,
  MENTION_RECORD_KINDS,
  menuRowMention,
  mentionRecordLabel,
  toMentionRecord,
  type MentionRecord,
  type MentionRecordKind,
  type MenuSearchKind,
  type MenuSearchRow,
} from '@/lib/search/menu-search'
import { ComposerSuggestionOverlay, createSuggestionDeck, prefersReducedMotion } from './composer-suggestions'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { UPLOAD_ACCEPT_ATTR, UPLOAD_TEXT_ACCEPT_ATTR } from '@/lib/chat/upload-allowlist'
import type { CaptureListItem } from '../views/capture-utils'
import type { SkillCommand, ChatFileAttachment, EditorSelection } from './chat-panel'
import { useDictation } from '@/hooks/use-dictation'
import { useInputDevices } from '@/hooks/use-input-devices'
import type { VoiceAvailability } from '@/hooks/use-voice-availability'
import { voiceBlockedLabel } from '@/hooks/use-voice-availability'
import { createClickBurst, toggleVoiceBird } from '@/components/birds/voice-bird'
import type { VoiceModeHandle } from '@/hooks/use-voice-mode'
import { insertDictation } from '@/lib/voice/dictation-text'
import {
  DictationButton,
  reportVoiceRefusal,
  DictationTail,
  StopSquareIcon,
  VoiceEndButton,
  VoiceInterruptTap,
  VoiceModeGlow,
  VoiceMuteButton,
  VoicePhaseAnnouncer,
  VoiceTranscript,
} from './voice-controls'
import { MicPicker } from './mic-picker'
import { ComposerCaptureButton, type ComposerRecording } from './composer-capture-button'
import type { ComposerEnvironment, ComposerFolders } from './composer-state'
import { EnvironmentSelector } from '@/components/environments/environment-selector'

/** The composer's voice: what the desktop can do, and the panel's voice mode.
 *  Absent (or `availability.visible` false) → no voice control at all. No
 *  `mode` (team chat: a channel is no conversation with the agent) →
 *  dictation only. */
export interface ChatInputVoice {
  availability: VoiceAvailability
  mode?: VoiceModeHandle
}

/** The composer's arrangement (ChatInput's `layout`). */
export type ChatInputLayout = 'stacked' | 'inline'

/** A control a host can't honour in its conversation. */
export type ChatInputUnavailableControl = 'agent' | 'photos' | 'files'

/**
 * The controls a host can't honour (a teammate is its own agent, a run's chat
 * can't take photos, …), each with what its pill says and the
 * short reason why. Such a control is never dropped silently: it shows dimmed
 * in its usual place, and a press on it says why (UnavailableControl).
 */
export type ChatInputUnavailable = Partial<Record<ChatInputUnavailableControl, { label?: string; reason: string }>>

// Context so any child popover can lock the expanded state open.
// Call the returned function with true when opening, false when closing.
type PopoverLockFn = (open: boolean) => void
const PopoverLockContext = createContext<PopoverLockFn>(() => {})
export const usePopoverLock = () => useContext(PopoverLockContext)

// Whether the composer is active (its window or surface shown). Every popover
// in this tree portals to <body>, so one left open while it's hidden would
// float over whatever shows instead — each closes itself when this flips false.
const InputActiveContext = createContext(true)
function useCloseWhenInactive(setOpen: (open: boolean) => void) {
  const active = useContext(InputActiveContext)
  useEffect(() => {
    if (!active) setOpen(false)
  }, [active, setOpen])
}

/**
 * How far the composer's controls sit in from the chat box's outer edge: the
 * box's 1px border and 8px padding (PromptInput's `p-2`), then the controls
 * row's own padding. The row under the box takes its insets from the same
 * number, so its first label's left edge lines up with "+".
 */
const CONTROLS_INSET_PX = 13
/** The box's border and padding (PromptInput: `border p-2`). */
const BOX_EDGE_PX = 9
/** The under-row's text buttons pad their label this much (`px-1.5`). */
const TEXT_BUTTON_PAD_PX = 6
/** The inline composer's field grows to about four lines, then scrolls. */
const INLINE_FIELD_MAX_PX = 104
/** The box's controls row: the inset, less the box's own border and padding. */
const CONTROLS_ROW_PADDING = { paddingLeft: CONTROLS_INSET_PX - BOX_EDGE_PX, paddingRight: CONTROLS_INSET_PX - BOX_EDGE_PX }
/** The row under the box: the first label's text at the inset. */
const UNDER_ROW_PADDING = { paddingLeft: CONTROLS_INSET_PX - TEXT_BUTTON_PAD_PX, paddingRight: CONTROLS_INSET_PX }

/** An accepted suggestion types out a character this often… */
const TYPE_OUT_CHAR_MS = 30
/** …but a long one still takes no longer than this in all. */
const TYPE_OUT_MAX_MS = 1200
/** The whole suggestion stays in the box this long before it sends. */
const TYPE_OUT_BEAT_MS = 200

/** A mentioned record's chip glyph. */
const RECORD_CHIP_ICONS: Record<MentionRecordKind, LucideIcon> = {
  action: CircleCheck,
  document: FileText,
  project: FolderKanban,
  initiative: Target,
  deal: Handshake,
  flow: Workflow,
  attachment: Paperclip,
  calendar_event: CalendarDays,
  studio_video: Film,
}

/**
 * May `/` here open the palette? Only from outside a text field, a menu or a
 * dialog (their `/` is theirs: a character, a typeahead), and not under a
 * modal (it hides the rest of the app, the composer too).
 */
function isPaletteShortcutTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLElement && target.isContentEditable) return false
  if (
    target instanceof Element &&
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]',
    )
  ) {
    return false
  }
  return !document.body.hasAttribute('data-scroll-locked')
}

// Memoized: ChatPanel re-renders ~20×/s while a reply streams (useChat is
// throttled to 50 ms), and this ~1.7k-line composer — plus its PromptInput
// textarea re-measure — has nothing to redraw for a streamed token. The
// panel's callback props are stable (latest-ref wrappers in chat-panel.tsx).
export const ChatInput = memo(function ChatInput({
  value,
  onChange,
  onSubmit,
  onStop,
  isLoading,
  attachedNotes,
  onAttachNote,
  onRemoveNote,
  attachedContacts = [],
  onAttachContact,
  onRemoveContact,
  attachedCompanies = [],
  onAttachCompany,
  onRemoveCompany,
  attachedRecords = [],
  onAttachRecord,
  onRemoveRecord,
  onOpenRecord,
  attachedFiles,
  onAttachFiles,
  onRemoveFile,
  activeSkill,
  onActivateSkill,
  onClearSkill,
  pages,
  onOpenPage,
  hasMessages = false,
  placeholder,
  suggestions = null,
  onAcceptSuggestion,
  editorSelection,
  onClearEditorSelection,
  autoFocus = false,
  isActive = true,
  voice,
  mainComposer = true,
  recording = null,
  unavailable,
  folders,
  environment,
  mentionList,
  layout = 'stacked',
  fileAccept,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onStop: () => void
  isLoading: boolean
  attachedNotes: CaptureListItem[]
  onAttachNote: (note: CaptureListItem) => void
  onRemoveNote: (noteId: string) => void
  /** People @-mentioned in this turn (contact chips beside the capture chips). */
  attachedContacts?: MentionContact[]
  onAttachContact?: (contact: MentionContact) => void
  onRemoveContact?: (contactId: string) => void
  /** Companies @-mentioned in this turn (company chips beside the people chips). */
  attachedCompanies?: MentionCompany[]
  onAttachCompany?: (company: MentionCompany) => void
  onRemoveCompany?: (companyId: string) => void
  /** Actions, docs, projects and initiatives @-mentioned in this turn (chips beside the rest). */
  attachedRecords?: MentionRecord[]
  onAttachRecord?: (record: MentionRecord) => void
  onRemoveRecord?: (recordId: string) => void
  /**
   * Open a record's card in the chat (the main chat's): what `/` does to a
   * record, and ⌘↵ under `@` (docs/plans/slash-search.md). Absent: records
   * only mention.
   */
  onOpenRecord?: (row: MenuSearchRow) => void
  attachedFiles: ChatFileAttachment[]
  onAttachFiles: (files: File[]) => void
  onRemoveFile: (fileId: string) => void
  activeSkill?: SkillCommand | null
  onActivateSkill?: (recipe: SkillCommand) => void
  onClearSkill?: () => void
  /**
   * The pages `/` lists before the skills (the main chat's; see
   * lib/chat-cards/page-menu.ts). Picking one hands it to onOpenPage, which
   * puts its card in the chat at once: nothing is sent.
   */
  pages?: readonly OfferedPage[]
  onOpenPage?: (page: OfferedPage) => void
  hasMessages?: boolean
  /** Overrides the composer's default placeholder for one armed turn — e.g.
   *  "Ask about the 5 selected rows…" after the Prospecting page arms the
   *  input without sending. Undefined keeps the default wording. */
  placeholder?: string
  /**
   * The empty main chat's starters (lib/chat/starters.ts, gated by the host):
   * while the box is empty the placeholder rotates between the default hint
   * and these, and Tab on one types it out and hands it to onAcceptSuggestion
   * (composer-suggestions.tsx). Null or absent (a conversation, a bot's, a
   * live meeting's, a teammate's or a run's chat): the static hint.
   */
  suggestions?: readonly string[] | null
  /** Send an accepted suggestion as the person's message (the host's starter path). */
  onAcceptSuggestion?: (prompt: string) => void
  editorSelection?: EditorSelection | null
  onClearEditorSelection?: () => void
  autoFocus?: boolean
  /** False while the composer's window or surface is hidden — closes every
   *  picker/menu/popover (they portal out of the panel and would float over
   *  whatever shows instead). */
  isActive?: boolean
  /** Dictation and voice mode (desktop only; see ChatInputVoice). */
  voice?: ChatInputVoice
  /**
   * This is the main chat's composer (default). False for a composer that
   * isn't (a teammate's or a run's floating chat): UI automation never
   * finds it.
   */
  mainComposer?: boolean
  /**
   * The recording, for Capture beside the mic (the main chat's composer:
   * composer-capture-button.tsx; Liam, 10-19, moved from the top bar). The
   * chat panel passes it; none, no Capture.
   */
  recording?: ComposerRecording | null
  /** Controls this host can't honour: shown dimmed with the reason, never dropped (ChatInputUnavailable). */
  unavailable?: ChatInputUnavailable
  /**
   * The person's environment for local agents (folders on their Mac, the
   * same in every chat; the main chat's, useComposerFolders): the + menu's
   * Select folder… when `canPick` (the desktop app, local agents available
   * there), which adds to it. No chips: the side panel's Environment card
   * lists them. Absent: no menu item.
   */
  folders?: ComposerFolders
  /**
   * Where this chat's work runs (the main chat's, useComposerEnvironment):
   * the selector under the box, while `visible`. Absent: no selector.
   */
  environment?: ComposerEnvironment
  /**
   * The host's own `@` list (team chat: the person's agent and the members),
   * in place of the record search: `@` lists these in the same menu, and a
   * pick puts `@label` in the text and tells the host (`onPick`), with no
   * chip. Absent: `@` finds records, as ever.
   */
  mentionList?: ComposerMentionList
  /**
   * `stacked` (default): the field on its own row, the controls under it.
   * `inline` (the main chat and team chat, Liam 11-09: "a single line"): one
   * row in a pill, "+" at the left, the field, then the mic and send at the
   * right; the field is one line that may grow a little (Shift+Enter, a long
   * message), then scrolls.
   */
  layout?: ChatInputLayout
  /**
   * The file picker's `accept`, for a host with its own file types (team
   * chat: files for people, src/lib/team-chat/files.ts). Absent: the AI
   * chat's (upload-allowlist.ts).
   */
  fileAccept?: string
}) {
  const inline = layout === 'inline'
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  // ── The `/` and `@` menu (command-menu-model.ts) ───────────────────────────
  // Read from the text and the caret on every edit and caret move, never
  // remembered from the keystroke that opened it. The caret is kept with the
  // text it was read from: a host's own change to the text (a send clearing
  // the box) leaves it unknown, and no menu opens on text nobody typed.
  //
  // Only the caret the menu was last READ at is state, and it changes only
  // when what it reads (the trigger, its query) does: an arrow key or a click
  // in plain text re-renders nothing (a render here re-measures the box's
  // height, a forced layout). `menuAtRef` is that state's twin, for comparing.
  const [menuAt, setMenuAt] = useState<{ value: string; caret: number }>({ value: '', caret: -1 })
  const menuAtRef = useRef(menuAt)
  // The trigger Esc put away (its start): it stays away while it's typed on,
  // and opens again once the caret leaves it and comes back.
  const [menuDismissedAt, setMenuDismissedAt] = useState<number | null>(null)
  // The field lost the focus (a press outside): the menu steps aside until it's back.
  const [fieldBlurred, setFieldBlurred] = useState(false)
  // `/` pressed outside any text field: the same menu, centred (main chat only).
  const [paletteOpen, setPaletteOpen] = useState(false)
  // The palette opened from the top bar's search button, flying in from it (open-search.ts).
  const [paletteArriving, setPaletteArriving] = useState(false)
  const menuRef = useRef<CommandMenuHandle>(null)
  const [focused, setFocused] = useState(autoFocus)
  const [openPopovers, setOpenPopovers] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  // The composer was hidden (its window or surface went inactive) → drop the
  // palette and the + menu (the inline menu shows only while it's active). The
  // sub-popovers close themselves via InputActiveContext.
  useEffect(() => {
    if (isActive) return
    setPaletteOpen(false)
    setPlusMenuOpen(false)
  }, [isActive])
  const prevValueRef = useRef(value)
  // The host sets the value too (a send clears the box): keep the "previous
  // value" in step, or the next keystroke would read the sent `/<slug>` as
  // deleted and drop a sticky skill (Scout) picked from "/".
  useEffect(() => {
    prevValueRef.current = value
  }, [value])
  const anchorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Voice (desktop only): dictation into the field, and voice mode ─────────
  const voiceAvailability = voice?.availability
  const voiceMode = voice?.mode
  const voiceVisible = !!voiceAvailability?.visible
  const voiceModeOn = voiceVisible && !!voiceMode?.active
  // The voice bird (components/birds/voice-bird.ts): five quick presses on the
  // main composer call it (voice mode, so only where voice mode can start)
  // or send it away. Counted in the root's own mousedown: no listener of its own.
  // Five in a row in one spot (mousedown's detail) within SUMMON_WINDOW_MS.
  const birdCanHatch = voiceVisible && !!voiceAvailability?.conversation && !voiceAvailability.blocked
  const summonBurstRef = useRef<ReturnType<typeof createClickBurst> | null>(null)
  const textareaHostRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // Dictated words land at the caret (over a selection), with a separating
  // space, and the caret follows them. The field keeps focus if it had it.
  const commitDictation = useCallback((text: string) => {
    const ta = anchorRef.current?.querySelector('textarea') ?? null
    const current = valueRef.current
    const start = ta ? ta.selectionStart : current.length
    const end = ta ? ta.selectionEnd : start
    const focused = !!ta && document.activeElement === ta
    const { value: next, caret } = insertDictation(current, start, end, text)
    valueRef.current = next
    prevValueRef.current = next
    onChangeRef.current(next)
    requestAnimationFrame(() => {
      const el = anchorRef.current?.querySelector('textarea')
      if (!el) return
      if (focused) el.focus()
      el.setSelectionRange(caret, caret)
    })
  }, [])
  // Enter / Send while dictating: stop, let the words land in the field, then
  // send the field. The send waits for the render that carries the merged
  // value, so the parent's onSubmit reads it. An Esc in between drops it.
  const onSubmitRef = useRef(onSubmit)
  onSubmitRef.current = onSubmit
  const sendAfterDictationRef = useRef(false)
  const [dictationSends, setDictationSends] = useState(0)
  const onDictationFinish = useCallback(({ cancelled }: { cancelled: boolean }) => {
    if (!sendAfterDictationRef.current) return
    sendAfterDictationRef.current = false
    if (!cancelled) setDictationSends((n) => n + 1)
  }, [])
  useEffect(() => {
    if (dictationSends > 0) onSubmitRef.current()
  }, [dictationSends])
  const dictation = useDictation({
    enabled:
      voiceVisible && !!voiceAvailability?.dictation && !voiceAvailability.blocked && !voiceModeOn && isActive,
    onCommit: commitDictation,
    onRefused: reportVoiceRefusal,
    onFinish: onDictationFinish,
  })
  const dictationRef = useRef(dictation)
  dictationRef.current = dictation
  // An accepted suggestion typing itself out (or holding its beat before it
  // sends): what it types, and its next step. Null otherwise.
  const typeOutRef = useRef<{ prompt: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const finishTypeOutRef = useRef<() => void>(() => {})
  const submit = useCallback(() => {
    // Enter mid type-out sends the whole suggestion now, never the part typed.
    if (typeOutRef.current) {
      finishTypeOutRef.current()
      return
    }
    const d = dictationRef.current
    if (d.active) {
      sendAfterDictationRef.current = true
      d.stop()
      return
    }
    onSubmitRef.current()
  }, [])
  // The mic picker grouped with send's slot whatever it shows (send, the
  // waveform, a stop square), so the row never changes width (desktop builds
  // with the input-device list only; elsewhere just the slot).
  // Gated on the build having voice at all, not on a mode being ready: the
  // picker also chooses the mic a capture records from.
  const micPickerOn = !!voiceAvailability?.hasVoice
  const inputDevices = useInputDevices({ enabled: micPickerOn })
  // `quiet`: the slot shows the plain voice-mode glyph (not send or stop), so
  // the pair takes the hover outline (MicPicker).
  const withMicPicker = (slot: ReactNode, quiet: boolean) =>
    micPickerOn ? (
      <MicPicker
        devices={inputDevices}
        isActive={isActive}
        busy={dictation.active || !!voiceAvailability?.blocked}
        voiceLive={voiceModeOn && voiceMode ? voiceMode.live : null}
        quiet={quiet}
      >
        {slot}
      </MicPicker>
    ) : (
      slot
    )
  // The words being dictated, once there are any: previewed at the caret.
  const dictationTail =
    dictation.active && dictation.transcript && (dictation.transcript.final || dictation.transcript.interim)
      ? dictation.transcript
      : null
  // Something to send: words, a ready file, or words being dictated.
  const hasDraft = !!value.trim() || attachedFiles.some((f) => f.status === 'ready') || !!dictationTail
  // New deploy → reload when idle (lib/deploy-reload.ts): never over unsent
  // words, files or a dictation, which the composer does not write to storage.
  const unsentRef = useRef(false)
  const unsent = !!value.trim() || attachedFiles.length > 0 || dictation.active
  useEffect(() => {
    unsentRef.current = unsent
  }, [unsent])
  useEffect(() => registerReloadBlocker(() => unsentRef.current), [])
  // Send's slot is voice mode's waveform: voice mode is ready but off, no
  // reply to stop, and nothing in the field (words, files, mentions, a
  // dictation) to send.
  const slotShowsVoice =
    !(voiceModeOn && voiceMode) &&
    !(isLoading && !hasDraft) &&
    voiceVisible &&
    !!voiceAvailability?.conversation &&
    !!voiceMode &&
    !value.trim() &&
    attachedFiles.length === 0 &&
    attachedNotes.length === 0 &&
    attachedContacts.length === 0 &&
    attachedCompanies.length === 0 &&
    attachedRecords.length === 0 &&
    !dictation.active
  // Voice mode: no label (the glow says who is talking); the field only shows
  // the words heard, and hints the tap while the agent speaks. Dictating: the
  // tail previews the words where the placeholder would be.
  const fieldPlaceholder = voiceModeOn
    ? voiceMode?.agentSpeaking
      ? 'Tap to interrupt'
      : ''
    : dictationTail
      ? ''
      : dictation.active && !value
        ? 'Listening…'
        : placeholder ?? (hasMessages ? 'Continue chat' : '@ to mention')
  // The rotating overlay is aria-hidden, so the field itself says that Tab sends a suggestion.
  const tabHintId = useId()

  // ── The rotating placeholder (composer-suggestions.tsx) ────────────────────
  // Only over an empty box with nothing staged (no file, mention, armed skill
  // or editor selection), on the default hint, with no voice in the field.
  // The overlay owns the timer; it mounts only while this holds, so typing
  // stops it and clearing the box starts it again from the hint.
  const suggestionsOn =
    !!suggestions?.length &&
    !!onAcceptSuggestion &&
    !value &&
    !hasMessages &&
    !placeholder &&
    !isLoading &&
    !voiceModeOn &&
    !dictation.active &&
    attachedFiles.length === 0 &&
    attachedNotes.length === 0 &&
    attachedContacts.length === 0 &&
    attachedCompanies.length === 0 &&
    attachedRecords.length === 0 &&
    !activeSkill &&
    !editorSelection
  // The shuffled order, kept as long as the composer (typing and clearing moves on).
  const [suggestionDeck] = useState(createSuggestionDeck)
  // The suggestion on screen (null on the hint), written by the overlay.
  const currentSuggestionRef = useRef<string | null>(null)
  const onAcceptSuggestionRef = useRef(onAcceptSuggestion)
  onAcceptSuggestionRef.current = onAcceptSuggestion
  useEffect(
    () => () => {
      if (typeOutRef.current) clearTimeout(typeOutRef.current.timer)
      typeOutRef.current = null
    },
    [],
  )
  /** Stop a type-out where it is, sending nothing. */
  const cancelTypeOut = () => {
    if (!typeOutRef.current) return
    clearTimeout(typeOutRef.current.timer)
    typeOutRef.current = null
  }
  // Tab on a suggestion: type it all out into the box at a steady rate
  // (~30 ms a character, 1.2 s at most), hold the whole text a beat, then send
  // it through the host's starter path, which clears the box as a send does.
  // Under reduced motion the whole text goes in at once, then the same beat.
  const acceptSuggestion = (prompt: string) => {
    const send = () => {
      typeOutRef.current = null
      onAcceptSuggestionRef.current?.(prompt)
    }
    const schedule = (fn: () => void, ms: number) => {
      typeOutRef.current = { prompt, timer: setTimeout(fn, ms) }
    }
    finishTypeOutRef.current = () => {
      cancelTypeOut()
      onChangeRef.current(prompt)
      send()
    }
    if (prefersReducedMotion()) {
      onChangeRef.current(prompt)
      schedule(send, TYPE_OUT_BEAT_MS)
      return
    }
    const charMs = Math.min(TYPE_OUT_CHAR_MS, TYPE_OUT_MAX_MS / prompt.length)
    // eslint-disable-next-line react-hooks/purity -- runs from the Tab keydown handler, never during render
    const startedAt = Date.now()
    const tick = () => {
      // Steady against the clock, so a late timer catches up rather than drags.
      const typed = Math.min(prompt.length, Math.max(1, Math.floor((Date.now() - startedAt) / charMs) + 1))
      onChangeRef.current(prompt.slice(0, typed))
      if (typed >= prompt.length) schedule(send, TYPE_OUT_BEAT_MS)
      else schedule(tick, charMs)
    }
    tick()
  }
  // ── The menu, read from the text and the caret ─────────────────────────────
  // The host's own options picked in this message (mentionList): done, as a
  // chip's label is, so the menu doesn't open again on "@Rosa Lind " and Enter
  // sends. Forgotten when the box empties (a send).
  const [pickedOptionLabels, setPickedOptionLabels] = useState<readonly string[]>([])
  if (value === '' && pickedOptionLabels.length > 0) setPickedOptionLabels([])
  // Labels already done (attached mentions, the armed skill): a trigger on one
  // is no trigger (findTriggerToken), so Enter after `/brief` sends.
  const doneMentions = useMemo(
    () => [
      ...attachedNotes.map((n) => n.title),
      ...attachedContacts.map((c) => mentionLabel(c)),
      ...attachedCompanies.map((c) => c.name),
      ...attachedRecords.map((r) => mentionRecordLabel(r)),
      ...pickedOptionLabels,
    ],
    [attachedNotes, attachedContacts, attachedCompanies, attachedRecords, pickedOptionLabels],
  )
  const doneTriggers = useMemo(
    () => ({ skills: activeSkill ? [activeSkill.slug] : [], mentions: doneMentions }),
    [activeSkill, doneMentions],
  )
  const caret = menuAt.value === value ? menuAt.caret : -1
  // The box's menu is `@`'s alone, to attach: `/` is the global palette's
  // (outside a text field, or ⌘K), so in the box it's only a character
  // (Liam, 10-20; docs/plans/slash-search.md).
  const boxTrigger = useCallback(
    (text: string, at: number) => {
      const token = findTriggerToken(text, at, doneTriggers)
      return token?.trigger === '@' ? token : null
    },
    [doneTriggers],
  )
  const menuToken = useMemo(() => boxTrigger(value, caret), [boxTrigger, value, caret])
  const menuOpen =
    !!menuToken && isActive && !fieldBlurred && !voiceModeOn && !paletteOpen && menuDismissedAt !== menuToken.start
  const readMenuAt = (next: { value: string; caret: number }) => {
    menuAtRef.current = next
    setMenuAt(next)
  }
  /**
   * The caret moved, or the text changed under it: what the menu reads next.
   * The state moves only when the trigger read there differs from the one the
   * current state reads for that text (sameTriggerToken).
   */
  const noteCaret = (nextValue: string, nextCaret: number) => {
    const next = boxTrigger(nextValue, nextCaret)
    const at = menuAtRef.current
    const current = at.value === nextValue ? boxTrigger(nextValue, at.caret) : null
    if (!sameTriggerToken(next, current)) readMenuAt({ value: nextValue, caret: nextCaret })
    // An Esc lasts while its trigger is typed on; leave it and it's forgotten.
    if (menuDismissedAt !== null && next?.start !== menuDismissedAt) {
      setMenuDismissedAt(null)
    }
  }
  const getTextarea = () => anchorRef.current?.querySelector('textarea') ?? null
  const handleFieldSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget
    noteCaret(ta.value, ta.selectionStart === ta.selectionEnd ? ta.selectionStart : -1)
  }

  const handleFieldKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the menu shows, its keys are its own (↑ ↓ Enter Tab Esc): the
    // field neither sends nor moves for them.
    if (menuOpen && menuRef.current?.handleKey(e)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (typeOutRef.current) {
      // Mid type-out: Tab does nothing (no second send, the focus stays);
      // Esc stops it and leaves the whole suggestion in the box to edit. Any
      // key that changes the text stops it too (handleChange), where it was.
      if (e.key === 'Tab') e.preventDefault()
      else if (e.key === 'Escape') {
        e.preventDefault()
        const { prompt } = typeOutRef.current
        cancelTypeOut()
        onChangeRef.current(prompt)
      }
      return
    }
    if (e.key !== 'Tab') return
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    const prompt = currentSuggestionRef.current
    if (!prompt || !suggestionsOn || menuOpen || paletteOpen || plusMenuOpen || openPopovers > 0) return
    e.preventDefault()
    acceptSuggestion(prompt)
  }

  const focusTextarea = useCallback(() => {
    requestAnimationFrame(() => {
      anchorRef.current?.querySelector('textarea')?.focus()
    })
  }, [])

  const dragCounterRef = useRef(0)

  // Stable callback for child popovers to lock expanded state
  const handlePopoverLock = useCallback((open: boolean) => {
    setOpenPopovers((c) => Math.max(0, c + (open ? 1 : -1)))
  }, [])

  // Track focus/blur on the textarea within the container
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null)

  // Auto-focus textarea on mount when requested (Simple View new tab)
  // Placed after blurTimeoutRef so we can clear any pending blur
  useEffect(() => {
    if (!autoFocus) return
    if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    setFocused(true)
    requestAnimationFrame(() => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
      const textarea = anchorRef.current?.querySelector('textarea')
      textarea?.focus()
    })
  }, [autoFocus])
  useEffect(() => {
    const container = anchorRef.current
    if (!container) return
    const onFocusIn = () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
      setFocused(true)
    }
    const onFocusOut = (e: FocusEvent) => {
      if (container.contains(e.relatedTarget as Node)) return
      blurTimeoutRef.current = setTimeout(() => setFocused(false), 80)
    }
    container.addEventListener('focusin', onFocusIn)
    container.addEventListener('focusout', onFocusOut)
    return () => {
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    }
  }, [])

  const handleChange = (newValue: string) => {
    // The person typed (or pasted) over an accepted suggestion typing itself
    // out: it stops where it was, and sends nothing.
    cancelTypeOut()
    const prev = prevValueRef.current
    prevValueRef.current = newValue

    // The menu reads the caret this edit left (the field's own, in the same
    // event), so the next key lands where the menu expects it.
    const ta = getTextarea()
    const nextCaret = ta && ta.value === newValue ? (ta.selectionStart === ta.selectionEnd ? ta.selectionStart : -1) : newValue.length
    setFieldBlurred(false)
    noteCaret(newValue, nextCaret)

    // Check if any inline @mention was deleted from the text. Counted per
    // label (longest-first, masked) so `@Maya` never matches inside
    // `@Maya Chen`, and two chips with the same label detach one at a time.
    // Notes, contacts and companies share one pool so a capture titled like
    // a person (or a company named like a person) doesn't double-detach when
    // a single `@Label` goes away.
    if (attachedNotes.length > 0 || attachedContacts.length > 0 || attachedCompanies.length > 0 || attachedRecords.length > 0) {
      const noteIds = new Set(attachedNotes.map((n) => n.id))
      const companyIds = new Set(attachedCompanies.map((c) => c.id))
      const recordIds = new Set(attachedRecords.map((r) => r.id))
      const removed = diffMentionRemovals(prev, newValue, [
        ...attachedNotes.map((n) => ({ id: n.id, label: n.title })),
        ...attachedContacts.map((c) => ({ id: c.id, label: mentionLabel(c) })),
        ...attachedCompanies.map((c) => ({ id: c.id, label: c.name })),
        ...attachedRecords.map((r) => ({ id: r.id, label: mentionRecordLabel(r) })),
      ])
      for (const id of removed) {
        if (noteIds.has(id)) onRemoveNote(id)
        else if (companyIds.has(id)) onRemoveCompany?.(id)
        else if (recordIds.has(id)) onRemoveRecord?.(id)
        else onRemoveContact?.(id)
      }
    }

    // Check if any inline /recipe was deleted from the text
    if (activeSkill) {
      const recipeMention = `/${activeSkill.slug}`
      if (prev.includes(recipeMention) && !newValue.includes(recipeMention)) {
        onClearSkill?.()
      }
    }

    onChange(newValue)
  }

  /**
   * The text a pick leaves, and the caret after it, focused: the menu reads
   * that caret, which sits past the space after the pick (no trigger there).
   */
  const commitPick = (next: { value: string; caret: number }) => {
    onChange(next.value)
    prevValueRef.current = next.value
    readMenuAt(next)
    setMenuDismissedAt(null)
    setFieldBlurred(false)
    requestAnimationFrame(() => {
      const textarea = getTextarea()
      if (!textarea) return
      textarea.focus()
      // Typed on since (a fast next key, a `/` straight after): the caret is
      // where that left it, not put back to the pick's.
      if (textarea.value === next.value) textarea.setSelectionRange(next.caret, next.caret)
    })
  }

  // A pick from the menu in the box replaces what was typed for it; one from
  // the palette (picked away from the box) joins the end of the draft.
  const insertMention = (label: string) => {
    const text = `@${label}`
    commitPick(!paletteOpen && menuToken ? replaceToken(value, menuToken, text) : appendMention(value, text))
    setPaletteOpen(false)
  }

  const handleNoteSelect = (note: CaptureListItem) => {
    insertMention(note.title)
    onAttachNote(note)
  }

  const handleContactSelect = (contact: MentionContact) => {
    insertMention(mentionLabel(contact))
    onAttachContact?.(contact)
  }

  const handleCompanySelect = (company: MentionCompany) => {
    insertMention(company.name)
    onAttachCompany?.(company)
  }

  const handleRecordSelect = (record: MentionRecord) => {
    insertMention(mentionRecordLabel(record))
    onAttachRecord?.(record)
  }

  // One of the host's own options: its `@label` in the text, and the host told (no chip).
  const handleOptionPick = (option: ComposerMentionOption) => {
    setPickedOptionLabels((prev) => (prev.includes(option.label) ? prev : [...prev, option.label]))
    insertMention(option.label)
    mentionList?.onPick(option)
  }

  // A record picked to go in the message: by its own kind's way in. A host
  // that mentions records itself (team chat: mentionList.records) gets the
  // row, and its `@label` goes in the words like one of its options (no chip).
  const handleMention = (row: MenuSearchRow) => {
    const hostRecords = mentionList?.records
    if (hostRecords) {
      const mention = menuRowMention(row)
      if (!mention) return
      setPickedOptionLabels((prev) => (prev.includes(mention.label) ? prev : [...prev, mention.label]))
      insertMention(mention.label)
      hostRecords.onPick(row)
      return
    }
    if (row.kind === 'capture') handleNoteSelect(row.capture)
    else if (row.kind === 'contact') handleContactSelect(row.contact)
    else if (row.kind === 'company') handleCompanySelect(row.company)
    else {
      const record = toMentionRecord(row)
      if (record) handleRecordSelect(record)
    }
  }

  // A record opened (`/`, or ⌘↵ under `@`): like a page, what was typed for
  // it leaves the draft, and its card goes into the chat at once.
  const handleRecordOpen = (row: MenuSearchRow) => {
    if (!paletteOpen && menuToken) commitPick(removeToken(value, menuToken))
    else focusTextarea()
    setPaletteOpen(false)
    onOpenRecord?.(row)
  }

  /** All mention labels currently in play — needed so chip-X removal of a
   *  short label doesn't splice it out of a longer sibling label. */
  const allMentionLabels = () => [
    ...attachedNotes.map((n) => n.title),
    ...attachedContacts.map((c) => mentionLabel(c)),
    ...attachedCompanies.map((c) => c.name),
    ...attachedRecords.map((r) => mentionRecordLabel(r)),
  ]

  const removeMentionText = (label: string) => {
    const newValue = removeMentionOccurrence(value, label, allMentionLabels())
    if (newValue !== value) {
      onChange(newValue)
      prevValueRef.current = newValue
    }
  }

  // A skill: its `/slug` stays in the draft (where it was typed, or leading
  // it) and arms the turn; deleting the text puts the skill down again.
  const handleSlashCommandSelect = (recipe: SkillCommand) => {
    const token = !paletteOpen && menuToken ? menuToken : null
    commitPick(pickSkillText(value, token, recipe.slug, activeSkill?.slug ?? null))
    setPaletteOpen(false)
    onActivateSkill?.(recipe)
  }

  // A page: what was typed for it leaves the draft (whatever else was typed
  // stays), and its card goes into the chat at once.
  const handleSlashPageSelect = (page: OfferedPage) => {
    if (!paletteOpen && menuToken) commitPick(removeToken(value, menuToken))
    else focusTextarea()
    setPaletteOpen(false)
    onOpenPage?.(page)
  }

  // Esc in the box: the menu goes, what was typed stays (as Claude's and
  // ChatGPT's do), and it stays away until the caret leaves that trigger.
  const handleMenuDismiss = () => {
    if (menuToken) setMenuDismissedAt(menuToken.start)
  }

  // ── `/` anywhere, and ⌘K: the palette (flying out of the search button) ───
  // The main chat's composer, while it's active, answers `/` pressed outside
  // any text field (a page's own `/` — mail's search — takes it first), and
  // ⌘K (Ctrl+K) pressed anywhere but under a modal: the old search's key, now
  // the same menu (docs/plans/slash-search.md); ⌘K again closes it. The
  // palette mounts and takes the focus within the key's own event, so what is
  // typed next is all in its field. Closing it gives the focus back.
  const paletteReturnFocusRef = useRef<HTMLElement | null>(null)
  const paletteShortcutOn = mainComposer && isActive && !voiceModeOn
  // A dismiss (Esc, a press outside, ⌘K, `/` or the Search pill again): the
  // palette flies back into the Search pill the way it came (open-search.ts).
  const closePalette = useCallback(() => {
    flySearchBack(document.querySelector<HTMLElement>('[data-command-menu="palette"] [role="dialog"]'))
    setPaletteOpen(false)
    const back = paletteReturnFocusRef.current
    paletteReturnFocusRef.current = null
    if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (!paletteShortcutOn) return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.isComposing || e.defaultPrevented) return
      const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey
      const cmdK = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
      if (!slash && !cmdK) return
      if (cmdK && document.querySelector('[data-command-menu="palette"]')) {
        e.preventDefault()
        closePalette()
        return
      }
      if (slash ? !isPaletteShortcutTarget(e.target) : document.body.hasAttribute('data-scroll-locked')) return
      // The composer has to be there to take what's picked (not hidden under
      // a bot's page, nor behind a modal).
      const anchor = anchorRef.current
      if (!anchor || anchor.closest('[hidden], [inert], [aria-hidden="true"]')) return
      e.preventDefault()
      paletteReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      // The search button's flight, as if it was pressed: the palette grows out of it.
      launchSearchFlight(searchButton())
      flushSync(() => {
        setPaletteArriving(flightWaiting(SEARCH_FLIGHT_KEY))
        setPaletteOpen(true)
      })
      document.querySelector<HTMLInputElement>('[data-command-menu-input]')?.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [paletteShortcutOn, closePalette])

  // The top bar's search button (open-search.ts): the same palette, flying in
  // from the button when its copy is held for it; pressed again, it closes.
  useEffect(() => {
    if (!paletteShortcutOn) return
    const onOpenSearch = (e: Event) => {
      const anchor = anchorRef.current
      if (!anchor || anchor.closest('[hidden], [inert], [aria-hidden="true"]')) return
      e.preventDefault()
      if (document.querySelector('[data-command-menu="palette"]')) {
        closePalette()
        return
      }
      paletteReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      flushSync(() => {
        setPaletteArriving(flightWaiting(SEARCH_FLIGHT_KEY))
        setPaletteOpen(true)
      })
      document.querySelector<HTMLInputElement>('[data-command-menu-input]')?.focus({ preventScroll: true })
    }
    window.addEventListener(OPEN_SEARCH_EVENT, onOpenSearch)
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, onOpenSearch)
  }, [paletteShortcutOn, closePalette])

  // What either menu can pick here: the one picker's kinds (MENTION_PICKER_KINDS),
  // each only where this composer can take it.
  const mentionKinds: MenuSearchKind[] = MENTION_PICKER_KINDS.filter((kind) =>
    kind === 'capture'
      ? true
      : kind === 'contact'
        ? !!onAttachContact
        : kind === 'company'
          ? !!onAttachCompany
          : !!onAttachRecord && (MENTION_RECORD_KINDS as readonly string[]).includes(kind),
  )
  const recordIdsOf = (kind: MenuSearchKind) => attachedRecords.filter((r) => r.kind === kind).map((r) => r.id)
  const menuPicks = {
    onSelect: handleSlashCommandSelect,
    pages: onOpenPage ? pages : undefined,
    onSelectPage: onOpenPage ? handleSlashPageSelect : undefined,
    onOpenRecord: onOpenRecord ? handleRecordOpen : undefined,
    onMentionRecord: handleMention,
    mentionKinds,
    exclude: {
      capture: attachedNotes.map((n) => n.id),
      contact: attachedContacts.map((c) => c.id),
      company: attachedCompanies.map((c) => c.id),
      ...Object.fromEntries(MENTION_RECORD_KINDS.map((kind) => [kind, recordIdsOf(kind)])),
    },
  }

  // A chat that takes no files says so in the + menu, and takes no drop or paste.
  const filesOff = !!unavailable?.files

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || [])
      if (files.length > 0) onAttachFiles(files)
      // Reset so the same file can be re-selected
      e.target.value = ''
    },
    [onAttachFiles],
  )

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (!filesOff && e.dataTransfer.types.includes('Files')) {
      setIsDragging(true)
    }
  }, [filesOff])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragging(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current = 0
      setIsDragging(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0 && !filesOff) onAttachFiles(files)
    },
    [onAttachFiles, filesOff],
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length > 0 && !filesOff) {
        e.preventDefault()
        onAttachFiles(files)
      }
    },
    [onAttachFiles, filesOff],
  )

  // The input options (search settings) stay open at all times — clicking
  // outside no longer collapses them.
  const expanded = true

  // Under the box, outside it (Liam, 2026-10-09, after Claude's own composer):
  // the agent. No agent picker anywhere (one-chat Slice 2: the main chat is
  // always the main agent); a teammate's or a run's chat may still say why with
  // a dimmed control, and without one there is no row at all. No model control
  // either: the server picks the model per turn. The main chat's environment
  // selector sits there too (docs/plans/environments.md §6), while you have one.
  const environmentOn = !!environment?.visible
  const underRowOn = !!unavailable?.agent || environmentOn

  // The field: its own row (stacked), or between "+" and the mic (inline).
  const field = (
    <div className={inline ? 'relative min-w-0 flex-1' : 'relative px-1'} ref={textareaHostRef}>
      <PromptInputTextarea
        // The rotating overlay draws the placeholder (the hint too): no
        // native one under it, so exactly one line shows. The default hint
        // stays the field's accessible hint (aria-placeholder).
        placeholder={suggestionsOn ? '' : fieldPlaceholder}
        aria-placeholder={suggestionsOn ? fieldPlaceholder : undefined}
        aria-keyshortcuts={suggestionsOn ? 'Tab' : undefined}
        aria-describedby={suggestionsOn ? tabHintId : undefined}
        // Voice mode: spoken turns are sent on their own, never merged with
        // the field, so it can't be typed into meanwhile. Its value (empty
        // when voice mode started) is left untouched.
        readOnly={voiceModeOn}
        // The main chat's composer, for UI automation
        // (src/lib/automation/README.md); a teammate's or a run's has none.
        data-testid={mainComposer ? 'chat-composer-input' : undefined}
        className={inline ? 'min-h-0 w-full px-2 py-1.5 md:text-[15px]' : 'min-h-0 w-full py-1.5'}
        rows={1}
        // Inline, the field is narrower beside its controls: a short hint still shows.
        hidePlaceholderBelow={inline ? 96 : undefined}
        onPaste={handlePaste}
        onKeyDown={handleFieldKeyDown}
        onSelect={handleFieldSelect}
        onFocus={() => setFieldBlurred(false)}
        onBlur={() => setFieldBlurred(true)}
      />
      {suggestionsOn && suggestions && (
        <ComposerSuggestionOverlay
          hint={fieldPlaceholder}
          suggestions={suggestions}
          deck={suggestionDeck}
          active={isActive}
          currentRef={currentSuggestionRef}
          hostRef={textareaHostRef}
        />
      )}
      {suggestionsOn && (
        <span id={tabHintId} className="sr-only">
          Press Tab to send a suggested question.
        </span>
      )}
      {dictationTail && <DictationTail hostRef={textareaHostRef} value={value} transcript={dictationTail} />}
      {voiceModeOn && voiceMode && (
        <>
          <VoiceTranscript hostRef={textareaHostRef} value={value} voice={voiceMode} />
          <VoiceInterruptTap voice={voiceMode} />
        </>
      )}
    </div>
  )

  return (
    <PopoverLockContext.Provider value={handlePopoverLock}>
    <InputActiveContext.Provider value={isActive}>
    <div
      ref={anchorRef}
      // The input's outer box — the chat box, and the agent row under it,
      // included.
      data-chat-input-root
      // Files dropped here go to this chat, even during a live capture
      // (anywhere else they attach to the capture: active-capture-drop.tsx).
      data-file-drop-zone=""
      // A composer that isn't the main chat's (a teammate's or a run's
      // floating chat): never taken for the main chat box (active-composer.ts).
      data-chat-input-floating={mainComposer ? undefined : ''}
      className={`relative rounded-3xl ease-out ${
        expanded
          ? 'space-y-0.5 px-2 pb-1 pt-1 transition-all duration-150'
          : 'p-0 transition-all duration-100'
      }`}
      onMouseDown={(e) => {
        // Only focus textarea when clicking empty space, not on interactive
        // children.
        const target = e.target as HTMLElement
        if (target.closest('button, a, input, [role="button"]')) return
        // Never preventDefault: a click, a selection (a triple-click's line)
        // and the field's own handlers go on as ever. The primary button only,
        // and the browser's own count of clicks in a row in one spot
        // (`detail`) must reach five too: selecting text never summons.
        if (mainComposer && e.button === 0) {
          summonBurstRef.current ??= createClickBurst()
          if (summonBurstRef.current.hit(Date.now(), e.detail)) toggleVoiceBird({ canHatch: birdCanHatch })
        }
        focusTextarea()
      }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-20 flex items-center justify-center rounded-3xl border-2 border-dashed border-primary/50 bg-primary/5">
          <div className="flex items-center gap-2 text-sm font-medium text-primary/70">
            <Paperclip className="h-4 w-4" />
            Drop files to attach
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        // A chat that can't take photos offers text files only (a dropped or
        // pasted photo is refused by the host, with the reason).
        accept={fileAccept ?? (unavailable?.photos ? UPLOAD_TEXT_ACCEPT_ATTR : UPLOAD_ACCEPT_ATTR)}
        onChange={handleFileInputChange}
      />
      <PromptInput
        value={value}
        onValueChange={handleChange}
        // Voice mode sends what is said; Enter in the (read-only) field doesn't.
        onSubmit={voiceModeOn ? undefined : submit}
        isLoading={isLoading}
        // Inline: a few lines at most, then the field scrolls.
        maxHeight={inline ? INLINE_FIELD_MAX_PX : undefined}
        // Glass: the chat scrolls on beneath the composer (chat-panel's dock),
        // and shows through it, softened. Inline (the main chat and team
        // chat): a pill, its radius half its one-line height, so it stays a
        // pill on one line and a rounded box if it grows. Team chat's has no
        // blur of its own (nothing scrolls beneath it, and it sits in a glass
        // card already).
        className={cn(
          inline
            ? '@container/chatinput relative rounded-[28px] border border-border/70 bg-background/80 px-2 py-2 shadow-sm'
            : '@container/chatinput relative rounded-3xl border border-border/70 bg-background/80 shadow-sm',
          (!inline || mainComposer) && 'backdrop-blur-xl',
        )}
        // The chat box itself (inside the root, without the agent row under it).
        data-bot-chat-box
      >
        {/* Active recipe badge */}
        {activeSkill && (
          <div className="relative -top-2.5 flex items-center px-3 pt-2">
            <Badge
              variant="secondary"
              className="gap-1.5 pl-2 pr-1"
              style={{
                backgroundColor: activeSkill.color ? `${activeSkill.color}15` : undefined,
                borderColor: activeSkill.color ? `${activeSkill.color}30` : undefined,
                color: activeSkill.color || undefined,
              }}
            >
              <span className="text-xs">{activeSkill.icon}</span>
              <span className="max-w-[150px] truncate text-xs font-medium">
                {activeSkill.name}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  // Remove inline /slug from text
                  if (activeSkill) {
                    const recipeMention = `/${activeSkill.slug}`
                    if (value.includes(recipeMention)) {
                      const newValue = value.replace(recipeMention, '').replace(/  +/g, ' ').trim()
                      onChange(newValue)
                      prevValueRef.current = newValue
                    }
                  }
                  onClearSkill?.()
                }}
                className="ml-0.5 rounded-sm p-0.5 hover:bg-muted-foreground/20"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          </div>
        )}

        {/* Attached files — inside the input box */}
        {attachedFiles.length > 0 && (
          <div className="relative -top-2.5 flex flex-wrap gap-1.5 px-3 pt-2">
            {attachedFiles.map((file) => (
              <Badge
                key={file.id}
                variant={file.status === 'error' ? 'destructive' : 'secondary'}
                className="gap-1 pl-2 pr-1"
                title={file.status === 'error' ? file.error : undefined}
              >
                {file.status === 'error' ? (
                  <AlertCircle className="h-3 w-3" />
                ) : file.file.type.startsWith('image/') ? (
                  <ImageIcon className="h-3 w-3" />
                ) : (
                  <Paperclip className="h-3 w-3" />
                )}
                <span className="max-w-[120px] truncate text-xs">
                  {file.file.name}
                </span>
                {file.status === 'uploading' && (
                  <span className="text-[10px] text-muted-foreground">…</span>
                )}
                {file.status === 'error' && (
                  <span className="max-w-[140px] truncate text-[10px]">
                    {file.error || 'Upload failed'}
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveFile(file.id)
                  }}
                  className="ml-0.5 rounded-sm p-0.5 hover:bg-muted-foreground/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        {/* Attached notes + people + companies + editor selection context — inside the input box */}
        {(attachedNotes.length > 0 || attachedContacts.length > 0 || attachedCompanies.length > 0 || attachedRecords.length > 0 || editorSelection) && (
          <div className="relative -top-2.5 flex flex-wrap gap-1.5 px-3 pt-2">
            {attachedNotes.map((note) => (
              <Badge
                key={note.id}
                variant="secondary"
                className="gap-1 pl-2 pr-1"
              >
                <FileText className="h-3 w-3" />
                <span className="max-w-[150px] truncate text-xs">
                  {note.title}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeMentionText(note.title)
                    onRemoveNote(note.id)
                  }}
                  className="ml-0.5 rounded-sm p-0.5 hover:bg-muted-foreground/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            {attachedContacts.map((contact) => (
              <Badge
                key={contact.id}
                variant="secondary"
                className="gap-1 pl-2 pr-1"
              >
                <User className="h-3 w-3" />
                <span className="max-w-[150px] truncate text-xs">
                  {mentionLabel(contact)}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeMentionText(mentionLabel(contact))
                    onRemoveContact?.(contact.id)
                  }}
                  className="ml-0.5 rounded-sm p-0.5 hover:bg-muted-foreground/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            {attachedCompanies.map((company) => (
              <Badge
                key={company.id}
                variant="secondary"
                className="gap-1 pl-2 pr-1"
              >
                <Building2 className="h-3 w-3" />
                <span className="max-w-[150px] truncate text-xs">
                  {company.name}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeMentionText(company.name)
                    onRemoveCompany?.(company.id)
                  }}
                  className="ml-0.5 rounded-sm p-0.5 hover:bg-muted-foreground/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            {attachedRecords.map((record) => {
              const Icon = RECORD_CHIP_ICONS[record.kind]
              const label = mentionRecordLabel(record)
              return (
                <Badge key={record.id} variant="secondary" className="gap-1 pl-2 pr-1" data-record-chip={`${record.kind}:${record.id}`}>
                  <Icon className="h-3 w-3" />
                  <span className="max-w-[150px] truncate text-xs">{label}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeMentionText(label)
                      onRemoveRecord?.(record.id)
                    }}
                    className="ml-0.5 rounded-sm p-0.5 hover:bg-muted-foreground/20"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )
            })}
            {editorSelection && (
              <Badge
                variant="secondary"
                className="gap-1 pl-2 pr-1 text-purple-600 dark:text-purple-400"
                style={{ backgroundColor: 'rgb(147 51 234 / 0.08)', borderColor: 'rgb(147 51 234 / 0.2)' }}
              >
                <MousePointerClick className="h-3 w-3" />
                <span className="max-w-[180px] truncate text-xs">
                  {editorSelection.selectedText.length > 40
                    ? `"${editorSelection.selectedText.slice(0, 40)}…"`
                    : `"${editorSelection.selectedText}"`}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onClearEditorSelection?.()
                  }}
                  className="ml-0.5 rounded-sm p-0.5 hover:bg-purple-500/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
          </div>
        )}

        {/* Textarea on its own full-width row so it never gets squeezed by the
            controls when the panel is narrow (inline: in the controls row). */}
        {!inline && field}

        {/* The box's one controls row: "+" at the left; the dictation mic and
            send's slot (voice mode, send or stop) at the right. The agent sits
            under the box (data-composer-under-row). */}
        <div
          data-composer-controls
          data-composer-layout={inline ? 'inline' : undefined}
          className={inline ? 'flex min-h-[38px] items-center gap-1' : 'flex items-center gap-1.5 pb-0.5'}
          style={inline ? undefined : CONTROLS_ROW_PADDING}
        >
          {/* "+" menu: files (or photos). */}
          <Popover
            open={plusMenuOpen}
            onOpenChange={(open) => {
              setPlusMenuOpen(open)
              // Local agents can be switched on (or off) on the Mac meanwhile.
              if (open) folders?.recheck()
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                aria-label="Add"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="w-60 p-2">
              {unavailable?.files ? (
                // No files here at all: the item says why, in its place.
                <div
                  data-composer-unavailable="files"
                  className="flex w-full items-start gap-2.5 rounded-2xl px-2 py-2 text-sm text-muted-foreground"
                >
                  <Paperclip className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block">{unavailable.files.label ?? 'Files and photos'}</span>
                    <span className="block text-xs">{unavailable.files.reason}</span>
                  </span>
                </div>
              ) : (
                <button
                  className="flex w-full items-center gap-2.5 rounded-2xl px-2 py-2 text-sm hover:bg-muted/50"
                  onClick={() => { setPlusMenuOpen(false); handleFileSelect() }}
                >
                  <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span>{unavailable?.photos ? 'Add files' : 'Add files or photos'}</span>
                </button>
              )}
              {/* A folder on this Mac for local agents (desktop only), added
                  to the environment for every chat: the Mac's own picker,
                  and its own confirm for edits. */}
              {folders?.canPick && (
                <button
                  className="flex w-full items-center gap-2.5 rounded-2xl px-2 py-2 text-sm hover:bg-muted/50 disabled:opacity-50"
                  data-composer-select-folder
                  disabled={folders.picking}
                  onClick={() => {
                    setPlusMenuOpen(false)
                    folders.pickFolder()
                  }}
                >
                  <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span>Select folder…</span>
                </button>
              )}
              {/* This chat can't take photos yet: it says so, in the menu
                  that would otherwise offer them. */}
              {unavailable?.photos && (
                <div
                  data-composer-unavailable="photos"
                  className="flex w-full items-start gap-2.5 rounded-2xl px-2 py-2 text-sm text-muted-foreground"
                >
                  <ImageIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block">{unavailable.photos.label ?? 'Photos'}</span>
                    <span className="block text-xs">{unavailable.photos.reason}</span>
                  </span>
                </div>
              )}
            </PopoverContent>
          </Popover>

          {/* Spacer pushes the mic and send's slot to the right (inline: the field does). */}
          {inline ? field : <div className="min-w-0 flex-1" />}

          {/* Capture (the main chat's composer, given the recording): the record
              icon left of the mic, or a recording's controls
              (composer-capture-button.tsx). */}
          {/* Below `md` only: from `md` up Capture is in the top bar's right header (top-bar/top-bar.tsx; Liam, 11-09). */}
          {mainComposer && recording && (
            <div data-composer-capture-phone-only="" className="contents md:hidden">
              <ComposerCaptureButton recording={recording} />
            </div>
          )}

          {/* Dictation: the mic sits left of send (desktop, on-device
              transcription ready). In voice mode (no dictation then) the spot
              is voice mode's mute. */}
          {voiceModeOn && voiceMode ? (
            <VoiceMuteButton voice={voiceMode} />
          ) : (
            voiceVisible &&
            voiceAvailability?.dictation && <DictationButton availability={voiceAvailability} dictation={dictation} />
          )}
          <PromptInputActions className="shrink-0">
            {withMicPicker(
              voiceModeOn && voiceMode ? (
                // Voice mode is on: the stop square reads on and ends it.
                // While a reply generates it is the only stop (two
                // identical squares would read as one control). Ending
                // voice mode leaves the reply alone, so Stop generating
                // shows right after; a new spoken turn replaces the reply
                // meanwhile.
                <VoiceEndButton voice={voiceMode} />
              ) : isLoading && !hasDraft ? (
                <PromptInputAction tooltip="Stop generating">
                  <Button
                    variant="default"
                    size="icon"
                    className="h-8 w-8 rounded-full"
                    aria-label="Stop generating"
                    onClick={onStop}
                  >
                    <StopSquareIcon />
                  </Button>
                </PromptInputAction>
              ) : slotShowsVoice && voiceAvailability && voiceMode ? (
                // Nothing to send: send becomes voice mode (same size, so
                // the swap doesn't move anything), a plain waveform glyph
                // like the mic beside it. Hovering the pair (MicPicker's
                // outline) gives it a soft grey square, unless the pointer
                // is on the chevron; send and stop keep the filled circle.
                // Until both speech models are ready there is no waveform,
                // just send.
                <PromptInputAction
                  side="bottom"
                  tooltip={voiceAvailability.blocked ? voiceBlockedLabel(voiceAvailability.blocked) : 'Use voice mode'}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    data-voice-idle=""
                    className="h-8 w-8 rounded-[10px] text-foreground/80 shadow-none transition-colors duration-150 hover:bg-muted hover:text-foreground motion-reduce:transition-none group-hover/mic:bg-muted group-has-[[data-mic-chevron]:hover]/mic:bg-transparent"
                    aria-label="Start voice mode"
                    data-voice-control="conversation"
                    disabled={!!voiceAvailability.blocked}
                    onClick={() => {
                      void voiceMode.start().then((refusal) => {
                        if (refusal) reportVoiceRefusal(refusal)
                      })
                    }}
                  >
                    <AudioLines className="h-4 w-4" />
                  </Button>
                </PromptInputAction>
              ) : (
                // Words, files or a dictation running: send (dictating,
                // it stops, lets the words land, then sends). While a
                // reply is still running it waits above the composer and
                // goes when the reply finishes (the slot is Stop again
                // once the composer is empty).
                <PromptInputAction tooltip={isLoading ? 'Send when this reply finishes' : 'Send message'}>
                  <Button
                    variant="default"
                    size="icon"
                    className={inline ? 'h-9 w-9 rounded-full' : 'h-8 w-8 rounded-full'}
                    aria-label={isLoading ? 'Send when this reply finishes' : 'Send message'}
                    disabled={!hasDraft}
                    onClick={submit}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                </PromptInputAction>
              ),
              slotShowsVoice,
            )}
          </PromptInputActions>
        </div>
        {/* Voice mode lights the composer while you talk to it (muted: off),
            and tells screen readers its state. A call never lights it: the
            call's glow is on the HUD's chat box (components/live-chat). */}
        {voiceVisible && voiceMode && (
          <>
            <VoiceModeGlow
              live={voiceMode.live}
              active={voiceModeOn && voiceMode.phase !== 'muted' && isActive}
              thinking={voiceMode.phase === 'thinking'}
            />
            <VoicePhaseAnnouncer voice={voiceMode} />
          </>
        )}
      </PromptInput>

      {/* Under the box, close to it (a 4px gap) and inset as the box's own
          controls are (CONTROLS_INSET_PX): the label lines up with "+" (Liam,
          2026-10-09). A quiet text button whose name truncates, never wraps. */}
      {underRowOn && (
        <div data-composer-under-row className="flex min-w-0 items-center gap-1 pt-0.5" style={UNDER_ROW_PADDING}>
          {environmentOn && environment && (
            <EnvironmentSelector
              chat={environment.chat}
              list={environment.list}
              onOpenMenu={environment.openMenu}
              onPick={environment.pick}
              isActive={isActive}
              onOpenChange={handlePopoverLock}
            />
          )}
          {unavailable?.agent && (
            <UnavailableControl
              control="agent"
              label={unavailable.agent.label ?? 'Agent'}
              reason={unavailable.agent.reason}
              className="shrink-[30]"
            />
          )}
          <div className="min-w-0 flex-1" />
        </div>
      )}

      {/* The `/` and `@` menu above the box, read from what's typed (one per
          trigger: a new trigger starts on All, at the top row). */}
      <SlashCommandPicker
        key={menuToken ? `${menuToken.trigger}${menuToken.start}` : 'menu'}
        open={menuOpen}
        trigger={menuToken?.trigger ?? '/'}
        query={menuToken?.query ?? ''}
        {...menuPicks}
        mentionList={mentionList ? { options: mentionList.options, onPick: handleOptionPick, records: mentionList.records } : undefined}
        onDismiss={handleMenuDismiss}
        onUnclaimedEnter={onSubmit}
        anchorRef={anchorRef}
        menuRef={menuRef}
      />
      {/* The same menu, centred: `/` pressed outside any text field. */}
      {paletteOpen && (
        <SlashCommandPicker
          key="palette"
          variant="palette"
          open
          query=""
          {...menuPicks}
          onDismiss={closePalette}
          arriving={paletteArriving}
          anchorRef={anchorRef}
        />
      )}
    </div>
    </InputActiveContext.Provider>
    </PopoverLockContext.Provider>
  )
})
ChatInput.displayName = 'ChatInput'

/**
 * A control this chat can't honour (ChatInputUnavailable), in its usual place:
 * its pill, dimmed, with a lock. A press says why in a small card instead of
 * doing anything, so the control is never just missing. The reason is also
 * its accessible description.
 */
function UnavailableControl({
  control,
  label,
  reason,
  icon,
  align = 'start',
  className = 'shrink',
}: {
  control: ChatInputUnavailableControl
  label: string
  reason: string
  icon?: ReactNode
  align?: 'start' | 'end'
  /** Its shrink weight in the row under the box (which name truncates first). */
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const popoverLock = usePopoverLock()
  useCloseWhenInactive(setOpen)
  useEffect(() => {
    popoverLock(open)
  }, [open, popoverLock])
  const reasonId = useId()
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-composer-unavailable={control}
          aria-describedby={reasonId}
          title={reason}
          className={`flex h-7 min-w-11 items-center gap-1 overflow-hidden rounded-md px-1.5 text-[13px] text-muted-foreground/60 transition-colors hover:bg-accent/40 hover:text-muted-foreground ${className}`}
        >
          {icon}
          <span className="min-w-0 truncate">{label}</span>
          <Lock className="h-3 w-3 shrink-0" aria-hidden />
          <span id={reasonId} className="sr-only">
            {reason}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align={align}
        className="w-60 p-3 text-xs text-muted-foreground"
        data-composer-unavailable-reason={control}
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Portaled, but its presses still bubble up the React tree to the
        // composer, which would focus the textarea and close it.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {reason}
      </PopoverContent>
    </Popover>
  )
}
