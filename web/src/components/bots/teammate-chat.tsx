'use client'

/**
 * TeammateChat — a compact chat with ONE AI teammate (bots v2, Phase 1;
 * docs/plans/bots-v2.md): a log, a box to type in, send and stop, the reply
 * streaming in. The bot bubble (Phase 2) mounts it; nothing else here knows
 * about bots or where it sits (its `avatar` is whatever the host hands it).
 *
 * Conversation logic is useTeammateChat (src/hooks/use-teammate-chat.ts): the
 * teammate's own thread on the main chat's eve runtime, with its persona,
 * ceiling and memory, out of the app's chat history. Rendering reuses the main
 * chat's ChatMessage, modelled on RunChat (src/components/agent-run/run-chat.tsx);
 * its entity links open as cards in the main chat (chat-message.tsx openTarget).
 *
 * Sizing: ~320px wide and up to ~420px tall by default; pass `className` to
 * override (it is merged last). A teammate chat has no clarifying-question
 * picker (the teammate asks in plain text), so unlike RunChat there is none.
 *
 * `density="compact"`: messages align to the host bubble's composer column.
 * Yours sit on the right in the primary fill; the teammate's fill the column
 * in the bots' glass
 * (glass.ts), its face (`avatar`) inside the first card of each run. The log
 * is in the bubble's sizes (COMPACT_LOG: 13px on a 20px line, smaller headings
 * and code) and grows with what it shows until the bubble runs out of room,
 * then scrolls; where it cuts a message off, the message fades out toward
 * that edge (useLogEdgeFade), never a hard line.
 *   the stack  only the newest TEAMMATE_CHAT_STACK_SHOWN show in full, at the
 *              bottom by the box; the older ones fold up into a stack above
 *              them, behind a full-width History disclosure. They stay in the
 *              log, every one of them (a screen reader reads the whole
 *              conversation): folded to no height, not taken out. A click on
 *              the stack (or Enter on it), or focus moving into a folded
 *              message opens it into the whole history, scrolling; "Show
 *              less", focus leaving a history it opened, or a message of
 *              your own folds it back. Hovering never opens it.
 *   motion     a new message rises in at the bottom (a spring: up, from 0.96,
 *              fading in) and the one it replaces folds up into the stack; a
 *              streaming reply grows in its card. With reduced motion,
 *              nothing moves: things fade.
 *   gaps       an opened history takes the pointer, so it scrolls anywhere
 *              in the log. The host's glass sheet catches presses in gaps.
 *   actions    a reply's Copy / Read aloud float in a small pill just under
 *              its card's corner, in room kept for them, so they never cover
 *              a message; shown on hover, keyboard focus or while it's read.
 * The default density is the main chat's log (ChatMessageList), untouched.
 *
 * The box is a floating pill (both densities): what's typed, and one round
 * button at its end. Empty, in the desktop app (where there's a voice), that's
 * the mic; typing makes it send; while a reply streams, stop. While you talk
 * the pill lights as the main composer does in voice mode (VoiceModeGlow: the
 * beam along its bottom edge, swelling with the voice, the mic's or the
 * bot's, gathered into the travelling beam while it thinks), the mic stays
 * pressed, and the phase ("Listening", "Thinking…") floats in a small label
 * above the pill; a typed send or a stop sits beside the mic then. In a
 * browser (no voice) it's send.
 *
 * `autoFocus` (the bubble opening on talking, nothing waiting): its box takes
 * focus as it mounts, but only from nowhere (the page) or from something
 * around it (the dialog it opened in), never from wherever you've gone since.
 *
 * Escape in the box clears what's typed (handled: `preventDefault`, and it goes
 * no further); in an empty box it's left to the host, so a dialog around it
 * (the bot bubble) closes. Mid-composition it only ends the composition.
 *
 * What's typed and not sent is kept per teammate (useTeammateChat's drafts), so
 * the chat unmounting (the bubble closed, another teammate picked) loses
 * nothing: the next mount for that teammate gives it back; sending clears it.
 * The root says when a host shouldn't light-dismiss around it:
 * `data-teammate-chat-busy` while a reply is on its way, `data-teammate-chat-draft`
 * while the box has text (the bubble ignores a press outside then).
 *
 * The log follows the newest content only while you're at (or near) its
 * bottom: scrolled up to read, a reply streaming in leaves you where you are;
 * your own message always brings you down to it, and opening or folding the
 * stack lands you at the newest.
 *
 * Talking out loud (Phase 4, `voice`; the desktop app only — the host passes
 * nothing in a browser, where you type): the mic starts a voice conversation
 * (useVoiceMode, the composer's: transcribed on the device, the end of a turn
 * detected there), and each spoken turn is sent as a message, unless
 * `voice.interceptTurn` handled it (the bubble's "yes" / "next"). The reply is
 * read aloud as it streams (useReadAloud) in `voice.ttsVoice`; typed turns'
 * replies too when `voice.readReplies` (the Read aloud setting's auto-read
 * decides). It's one conversation per page: starting it ends the composer's
 * voice mode, and the composer's ends it. No greeting: the host has said what
 * it has. A refusal (another Native Intelligence window has the voice, modules not set up,
 * no mic) shows in the label above the box. `voice.onState` hears whether it's
 * listening and whether a reply is being read, and how to stop that reading;
 * `voice.onTypedSend`, that a typed message went out. The label (the phase and
 * the words heard, or a refusal) is visual only: an always-mounted,
 * screen-reader-only region (the composer's VoicePhaseAnnouncer) says the
 * phase and the refusal, never the words heard.
 */
import { PACKS, type AreaKey } from '@/lib/packs/registry'
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowUp, ChevronDown, History, Mic, Square } from 'lucide-react'
import { Loader } from '@/components/ui/loader'
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
  PromptInputAction,
} from '@/components/ui/prompt-input'
import { ChatMessage } from '@/app/account/(dashboard)/chat/chat-message'
import { ConversationComposer } from '@/app/account/(dashboard)/chat/conversation-composer'
import type { ChatInputUnavailable, ChatInputVoice } from '@/app/account/(dashboard)/chat/chat-input'
import type { ComposerTurnExtras } from '@/app/account/(dashboard)/chat/composer-state'
import { ReadAloudContext } from '@/app/account/(dashboard)/chat/read-aloud-button'
import { MessageFeedbackContext } from '@/app/account/(dashboard)/chat/message-feedback-buttons'
import { CHAT_PHOTOS_REASON, runChatAgentReason, teammateAgentReason } from '@/components/agent-run/run-chat-copy'
import { ChatMessageList, windowChatMessages } from '@/app/account/(dashboard)/chat/chat-message-list'
import { VoiceModeGlow } from '@/app/account/(dashboard)/chat/composer-voice-glow'
import { VoicePhaseAnnouncer } from '@/app/account/(dashboard)/chat/voice-controls'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { useReadAloud } from '@/hooks/use-read-aloud'
import { setTeammateDraft, teammateDraft, useTeammateChat, type TeammateChat as TeammateChatState, type TeammateSendOptions } from '@/hooks/use-teammate-chat'
import { RUN_CHAT_BUBBLE_REPLAY_MS, useRunChat } from '@/hooks/use-run-chat'
import { OWN_RUN_SPEAKER, aboutLineLabel, answerRunQuestion, runAnsweredLine, runChatRefusalLine, type RunChatRefusal } from '@/lib/bots/item-run-chat'
import { useVoiceAvailability, voiceBlockedLabel } from '@/hooks/use-voice-availability'
import { useVoiceMode, VOICE_PHASE_LABEL, type VoiceLiveStore } from '@/hooks/use-voice-mode'
import { voiceRefusalMessage } from '@/lib/voice/messages'
import { cn } from '@/lib/utils'
import { MessageIdentity } from '@/components/agent-ui/glass-backdrop'
import type { TeammateAboutRef } from '@/lib/chat/teammate-about-ref'
import { BOT_GLASS, BOT_GLASS_ENTER, BOT_GLASS_MUTED, BOT_GLASS_PILL, BOT_USER_BUBBLE } from '@/components/agent-ui/glass'
import { useHomeHandoff } from '@/hooks/use-home-handoff'
import { OnSkyContext } from '@/components/sky/on-sky'

/** Talking to the teammate out loud (the desktop app). */
export interface TeammateChatVoice {
  /** The voice its replies are read in (a bot's own); null: the Read aloud setting's. */
  ttsVoice: string | null
  /** Read the replies to typed turns aloud too, as auto-read does (the Read aloud setting decides). */
  readReplies: boolean
  /** A spoken turn, before it's sent: true when the host handled it, and it isn't sent. */
  interceptTurn?: (text: string) => boolean
  /** How the talk is going, whenever that changes (and idle as it goes away). */
  onState?: (state: TeammateChatVoiceState) => void
  /** A typed message went out (the host stops waiting on a spoken answer). */
  onTypedSend?: () => void
}

export interface TeammateChatVoiceState {
  /** The mic is on: a voice conversation is live. */
  listening: boolean
  /** A reply is being read aloud. */
  speaking: boolean
  /** Stop reading it. */
  stopSpeaking: () => void
}

export const TEAMMATE_CHAT_VOICE_IDLE: TeammateChatVoiceState = Object.freeze({
  listening: false,
  speaking: false,
  stopSpeaking: () => {},
})

/** How long a refusal's line stays above the box. */
export const TEAMMATE_CHAT_NOTICE_MS = 5000

/** How near the log's bottom (px) still counts as at it: a new reply follows. */
export const TEAMMATE_CHAT_STICK_PX = 48

/** Compact: how many of the newest messages show in full below the stack. */
export const TEAMMATE_CHAT_STACK_SHOWN = 2

/** How tightly it's drawn: the default, or `compact` (the bot bubble). */
export type TeammateChatDensity = 'comfortable' | 'compact'

/**
 * The log, compact (the bot bubble): what ChatMessage draws at the main chat's
 * sizes taken down to the bubble's, from here, so the main chat is untouched.
 * Its replies and your messages are MessageContent's `prose`: 16px on a 28px
 * line, paragraphs 20px apart, headings up to 30px, inline code (Markdown's
 * `font-mono` span) 14px. Here: 13px on 20px, tighter paragraphs, lists and
 * headings, 12px code; a code block (CodeBlock, `not-prose`) 12px with less
 * padding. Folded or open, the log grows with what it shows until the bubble
 * runs out of room (its column's max height; COMPACT_LOG_MAX on a tall window),
 * so the newest exchange, a tall reply and your message above it, shows whole
 * wherever it fits; past that it scrolls, its cut edges fading
 * (useLogEdgeFade).
 */
export const COMPACT_LOG_MAX = 'max-h-[min(36rem,calc(100vh-12rem))]'
export const COMPACT_LOG = [
  `${COMPACT_LOG_MAX} gap-2`,
  '[&_.prose]:text-[13px] [&_.prose]:leading-5',
  '[&_.prose_p]:my-2 [&_.prose_:is(ul,ol)]:my-2 [&_.prose_:is(ul,ol)]:ps-4 [&_.prose_li]:my-0.5 [&_.prose_li>p]:my-1',
  '[&_.prose_:is(h1,h2,h3,h4)]:mb-1 [&_.prose_:is(h1,h2,h3,h4)]:mt-3 [&_.prose_:is(h1,h2,h3,h4)]:font-semibold [&_.prose_:is(h1,h2,h3,h4)]:leading-5',
  '[&_.prose_:is(h1,h2)]:text-[14px] [&_.prose_:is(h3,h4)]:text-[13px]',
  // The first and last block sit flush with the message, as in the main chat.
  '[&_.prose>:first-child]:mt-0 [&_.prose>:last-child]:mb-0',
  '[&_.prose_:is(code,.font-mono)]:text-[12px]',
  '[&_.not-prose]:rounded-lg [&_.not-prose>div]:text-[12px] [&_.not-prose_pre]:px-3 [&_.not-prose_pre]:py-2',
].join(' ')

/** The opened history takes the pointer (it scrolls, its scrollbar drags). */
const COMPACT_LOG_OPEN = 'pointer-events-auto'

/** How far a message fades out toward an edge of the compact log where more is scrolled away, px. */
export const TEAMMATE_CHAT_FADE_PX = 24

/**
 * A glass piece fading in as it mounts (BOT_GLASS_ENTER): the fade is always
 * the glass element's own (a wrapper's opacity would switch its blur off), and
 * the motion around it is transforms only.
 */
const ENTER = cn('transition-opacity duration-200 ease-out', BOT_GLASS_ENTER)

/**
 * Inside a message card, ChatMessage's own frame steps aside (its 80% column,
 * its text's grey box): the card is the bubble.
 */
const MESSAGE_IN_CARD = '[&>div>div]:max-w-full [&>div>div>.prose]:rounded-none [&>div>div>.prose]:bg-transparent [&>div>div>.prose]:p-0'
/**
 * A reply's Copy / Read aloud (ChatMessage's hover actions) float just outside
 * its card, under its bottom-left corner (3px over its edge, so the pointer
 * crosses no gap), in a small pill of their own: never over the message. Their
 * room is kept under the card (TEAMMATE_CONTENT's bottom padding), so they
 * never sit on the next message either. Shown on hover, while one of them has
 * keyboard focus, and (ChatMessage's own) while the reply is read aloud.
 * Nearly opaque: it's no glass of its own.
 */
const ACTIONS_OUTSIDE = [
  '[&_[data-message-actions]]:absolute [&_[data-message-actions]]:bottom-0 [&_[data-message-actions]]:left-2 [&_[data-message-actions]]:z-10',
  '[&_[data-message-actions]]:gap-0 [&_[data-message-actions]]:rounded-full [&_[data-message-actions]]:border [&_[data-message-actions]]:border-black/[0.08] [&_[data-message-actions]]:bg-white/95 [&_[data-message-actions]]:p-px [&_[data-message-actions]]:shadow-[0_1px_2px_rgb(0_0_0/0.08),0_4px_10px_-4px_rgb(0_0_0/0.2)]',
  'dark:[&_[data-message-actions]]:border-white/[0.12] dark:[&_[data-message-actions]]:bg-[rgb(58_58_64/0.96)]',
  '[&_[data-message-actions]:focus-within]:opacity-100',
].join(' ')
/** Yours: on the right, the primary fill (BOT_USER_BUBBLE, which the live agent's HUD chat wears too). */
const USER_CARD = cn(
  BOT_USER_BUBBLE,
  MESSAGE_IN_CARD,
  '[&>div>div>.prose]:text-inherit',
)
/**
 * The teammate's: on the left, glass. Two layers in one box: the glass behind
 * (TEAMMATE_GLASS, which takes the pointer) and the message over it
 * (TEAMMATE_CONTENT), siblings, so each can wear its own fade at the log's
 * edge (useLogEdgeFade) without one masking the other's blur. A reply with
 * Copy / Read aloud keeps their room in the box under the glass (25px: their
 * 28px pill less the 3px over the glass's edge), so the message's fade spans
 * them too and a fading card never clips them; that room takes no pointer.
 */
const TEAMMATE_CARD = 'group/card relative w-full min-w-0'
const TEAMMATE_GLASS = cn(BOT_GLASS, 'pointer-events-auto absolute inset-0 rounded-[18px] group-has-[[data-message-actions]]/card:bottom-[25px]')
const TEAMMATE_CONTENT = cn(
  // The glass's 1px edge and its px-3 / py-2, so the text sits where it did in a one-layer card.
  'relative px-[13px] py-[9px] has-[[data-message-actions]]:pb-[34px] [&>*]:pointer-events-auto',
  MESSAGE_IN_CARD,
  ACTIONS_OUTSIDE,
)
/** A message rising in: up, from 0.96 (its card fades in by itself, ENTER). Nothing moves with reduced motion. */
const RISE_FROM = { y: 10, scale: 0.96 }
const RISE_TO = { y: 0, scale: 1 }
const RISE_SPRING = { type: 'spring', stiffness: 520, damping: 34, mass: 0.7 } as const

/** The composer's round buttons. */
const ROUND =
  'relative inline-flex shrink-0 items-center justify-center rounded-full transition-[background-color,color,box-shadow,opacity,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-95 disabled:pointer-events-none disabled:opacity-35 motion-reduce:active:scale-100'
/** Its one main button (mic, send, stop): a filled circle. */
const ROUND_MAIN = `${ROUND} h-8 w-8 bg-primary text-primary-foreground shadow-sm hover:bg-primary/90`
/** Beside the mic while you talk (send, stop): quiet. */
const ROUND_QUIET = `${ROUND} h-7 w-7 ${BOT_GLASS_MUTED} hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.1] dark:hover:text-foreground`

export interface TeammateChatProps {
  /** The AI teammate (`ai_team_member` id) to talk to. */
  teammateId: string
  /** The teammate's workspace, when known (the roster carries it); optional. */
  workspaceId?: string | null
  /** Merged last onto the root, so it can override the default size. */
  className?: string
  /** The current user's avatar, forwarded to their own messages. */
  userAvatarUrl?: string | null
  /** The current user's initials, for the avatar fallback. */
  userInitials?: string
  /** The composer placeholder; defaults to "Message <teammate>…" ("Ask <teammate> anything…" before anything's said, compact). */
  placeholder?: string
  /** Talking out loud (the desktop app): a mic, spoken turns, replies read aloud. Absent: typing only. */
  voice?: TeammateChatVoice
  /** `compact`: the bot bubble's floating messages (COMPACT_LOG, the stack); the default is the main chat's. */
  density?: TeammateChatDensity
  /** Its box takes focus as it mounts, from nowhere or from something around it (the bubble opening on talking). */
  autoFocus?: boolean
  /** Compact: the teammate's face, small beside the first of each run of its messages (the bubble hands its bot's). */
  avatar?: ReactNode
  /** The host's updates or review actions, outside the log and above the input. */
  beforeComposer?: ReactNode
  /**
   * Talking about one item a work run produced (bots-v2.md "Items continue
   * their run's chat"): what's sent, typed or said, goes to THAT run's
   * follow-up chat (useRunChat), and the log is that conversation, with a
   * quiet "About: <title>" line over the box. A run whose chat the route
   * refuses (someone else started it, no session) falls back to the
   * teammate's own thread, the line saying why. A run asking a question
   * (`asking`): what's sent answers it (answerRunQuestion), under an
   * "Answering: <title>" line; one it isn't the user's to answer goes to the
   * teammate's own thread, the line saying why. An item with no run chat (a
   * loop's run, a card; bots v3 1d) keeps the teammate's own thread, under the
   * same "About:" line, and what's sent carries the item (`context`), so the
   * teammate answers with the run attached (its verdict, cards and capture).
   * So does a run whose chat was refused. Null: the teammate's own thread.
   */
  about?: TeammateChatAbout | null
  /** The line's button: back to the teammate's own thread (false), or to the item's run chat again (true). Absent: no button. */
  onAboutChange?: (on: boolean) => void
  /**
   * The box: `pill` (the default) is the small floating box, what's typed and
   * one round button; `full` is the main chat's composer (bots v4,
   * ConversationComposer: skills, text files, @-mentions, the model and
   * thinking picker, dictation and voice mode, stop; photos
   * dimmed with the reason), for the teammate's chat in its own window
   * (TeammateChatPage). The bubble keeps the pill.
   */
  composer?: 'pill' | 'full'
  /**
   * An area face's page (one-agent plan S3): the chat is the person's
   * main-chat conversation focused on this area (useTeammateChat's
   * `focusArea`), the main agent with the area's pack, not the face's thread.
   * An item's run chat still takes over while the chat is about one.
   */
  focusArea?: AreaKey | null
  /**
   * The agent's face (one face, always-on-agent §2c): its own chat is the
   * person's home thread, which the chat strip's home tab owns, the ONE Chat
   * on it in the window (#681: two would drift apart and both send). So none
   * is mounted here: what's sent hands off to that tab (openHomeThread with
   * the text, an item's ids riding it), under a line saying where it went. An
   * item's run chat still takes over while the chat is about one. Typing
   * only (no voice) and the pill box: the strip has the full composer.
   */
  home?: boolean
}

/** The item a chat is about, and the run whose chat continues it. */
export interface TeammateChatAbout {
  /** The run whose chat continues the item; absent: it has none, and what's sent goes to the teammate's own thread with `context`. */
  runId?: string | null
  /** The item, attached to what goes to the teammate's own thread while the line's on (bots v3 1d: ids only, checked server-side). */
  context?: TeammateAboutRef | null
  /** The item's title, as the line shows it. */
  title: string
  /** You went back to the teammate's own thread for this item: the line offers the item's chat again. */
  off?: boolean
  /** The run is waiting on an answer: what's sent answers its question (its chat comes once it settles). */
  asking?: boolean
  /** The run's (the item's) workspace, where its question is read. */
  workspaceId?: string | null
  /**
   * A person's own run a bot was routed to (bots-v4 Phase 5, item-run-chat.ts
   * `own`): its chat is theirs, on the run's own limits, so the line says
   * "Your run’s chat" and the run speaks as itself, never as the bot.
   */
  own?: boolean
}

/** Why a focused conversation's agent can't be changed here (one-agent S3). */
function focusedAgentReason(area: string): string {
  return `This chat is Native Intelligence's main agent, focused on ${area}: its agent can't change here. For anything else, use the main chat.`
}

/** How answering a run's question in the box went, for the line (per run). */
type Answered = { runId: string; refusal: RunChatRefusal | null; sent: boolean }

export function TeammateChat(props: TeammateChatProps) {
  // No thumbs here: a teammate's thread isn't the main chat's conversation,
  // so the store ChatPanel provides (reached when this chat renders inside
  // it) is cleared for these messages.
  return (
    <MessageFeedbackContext.Provider value={null}>
      {props.home ? <HomeTeammateChat {...props} /> : <ThreadTeammateChat {...props} />}
    </MessageFeedbackContext.Provider>
  )
}

/** A teammate's own thread (or an area face's focused conversation). */
function ThreadTeammateChat(props: TeammateChatProps) {
  const mate = useTeammateChat({ teammateId: props.teammateId, workspaceId: props.workspaceId ?? null, focusArea: props.focusArea ?? null })
  return <TeammateChatWith {...props} mate={mate} />
}

/** The agent's face: no Chat of its own on the home thread, a hand-off to the strip's (see `home`). */
function HomeTeammateChat(props: TeammateChatProps) {
  const mate = useHomeHandoff(props.workspaceId ?? null)
  return <TeammateChatWith {...props} voice={undefined} composer="pill" mate={mate} />
}

function TeammateChatWith({ mate, teammateId, workspaceId = null, voice, about = null, onAboutChange, composer = 'pill', focusArea = null, home = false, ...view }: TeammateChatProps & { mate: TeammateChatState }) {
  const aboutRunId = about?.runId || null
  const answering = !!about && !about.off && !!about.asking && !!aboutRunId
  // Its run's chat: read once the item has been on show a moment (paging past one reads nothing).
  const run = useRunChat(about && !about.off && !about.asking ? aboutRunId : null, { replayDelayMs: RUN_CHAT_BUBBLE_REPLAY_MS })
  const name = mate.teammateName ?? 'your teammate'
  // About an item: its run's chat, once the route hasn't refused it.
  const onRun = !!about && !about.off && !about.asking && !!aboutRunId && !!run && !run.refusal
  // Asking: a reply answers the run's question; one the run won't take goes to the teammate.
  const [answered, setAnswered] = useState<Answered | null>(null)
  const answerFor = answered && about && answered.runId === aboutRunId ? answered : null
  // To the teammate's own thread while the line's on: the item rides along (bots v3 1d).
  const context = about && !about.off ? (about.context ?? null) : null
  const contextWork = context?.workItemId ?? null
  const contextCard = context?.cardId ?? null
  const mateSendMessage = mate.sendMessage
  // What the full composer added (`opts.turn`) rides along whichever way the message goes.
  const sendMate = useCallback(
    (text: string, opts?: TeammateSendOptions) =>
      mateSendMessage(text, {
        ...opts,
        ...(contextWork || contextCard ? { about: contextWork ? { workItemId: contextWork } : { cardId: contextCard! } } : {}),
      }),
    [mateSendMessage, contextWork, contextCard],
  )
  const answerRunId = answering ? aboutRunId : null
  const answerWorkspace = about?.workspaceId ?? null
  const answer = useCallback(
    async (text: string, opts?: TeammateSendOptions): Promise<boolean> => {
      if (!answerRunId) return sendMate(text, opts)
      // An answer is the text alone (the run's question takes words, not files).
      const result = await answerRunQuestion(answerRunId, answerWorkspace, text)
      if (result.ok) {
        setAnswered({ runId: answerRunId, refusal: null, sent: true })
        return true
      }
      if (!result.refusal) return false
      setAnswered({ runId: answerRunId, refusal: result.refusal, sent: false })
      return sendMate(text, opts)
    },
    [answerRunId, answerWorkspace, sendMate],
  )
  // A person's own run speaks as the run, not the bot it came through.
  const ownRun = !!about?.own
  const chat: TeammateChatState = onRun
    ? { ...run!, teammateName: ownRun ? OWN_RUN_SPEAKER : mate.teammateName, workspaceId: mate.workspaceId, conversationId: null }
    : answering && !answerFor?.refusal
      ? { ...mate, sendMessage: answer }
      : context
        ? { ...mate, sendMessage: sendMate }
        : mate
  const draftKey = onRun || (answering && !answerFor?.refusal) ? `run:${aboutRunId}` : teammateId
  const refusal = answering ? (answerFor?.refusal ?? null) : (run?.refusal ?? null)
  const aboutLine = about ? (
    <AboutLine
      title={about.title}
      off={!!about.off}
      asking={answering}
      own={ownRun}
      answered={answering && !!answerFor?.sent ? runAnsweredLine(name) : null}
      refused={refusal ? runChatRefusalLine(refusal, name) : null}
      name={name}
      onChange={onAboutChange}
    />
  ) : null
  // The full composer (bots v4): what this conversation can honour. The
  // teammate (or the run's bot) is the agent either way. No model control in
  // either: the server picks the model per turn. Neither takes photos yet: the
  // thread's eve history would keep the photo's signed link past its hour
  // (the run's would provision a sandbox), so they show dimmed.
  const full = useMemo<FullComposer | null>(() => {
    if (composer !== 'full') return null
    const runChat = onRun || answering
    return {
      workspaceId: (runChat ? about?.workspaceId : null) ?? mate.workspaceId ?? workspaceId,
      unavailable: {
        agent: {
          label: runChat && ownRun ? OWN_RUN_SPEAKER : (mate.teammateName ?? 'Agent'),
          reason: runChat
            ? runChatAgentReason(ownRun ? null : mate.teammateName)
            : focusArea
                ? focusedAgentReason(PACKS[focusArea].name)
                : teammateAgentReason(mate.teammateName),
        },
        photos: { reason: CHAT_PHOTOS_REASON },
      },
    }
  }, [composer, onRun, answering, ownRun, about?.workspaceId, mate.workspaceId, mate.teammateName, workspaceId, focusArea])
  // One voice conversation per teammate (chatKey): paging to another item
  // moves what's said to that item's run without ending the talk.
  return voice ? (
    <VoicedTeammateChat chat={chat} voice={voice} chatKey={teammateId} draftKey={draftKey} about={aboutLine} full={full} {...view} />
  ) : (
    <TeammateChatView chat={chat} draftKey={draftKey} about={aboutLine} full={full} {...view} />
  )
}

/** What the full composer offers in this conversation (TeammateChat computes it). */
interface FullComposer {
  /** Where its skills and mentions are read. */
  workspaceId: string | null
  /** What it can't honour, and why. */
  unavailable: ChatInputUnavailable
}

/**
 * The quiet line over the box while the chat is about an item: "About:
 * <title>" ("Answering: <title>" while its run asks a question; "Your run’s
 * chat: <title>" for a person's own run, aboutLineLabel), and the way
 * back to the teammate's own thread; gone back to it, "Talking to <name>" and
 * the way to the item's chat again; once an answer went, that it did; or,
 * when the item's run chat (or answer) was refused, why this goes to the
 * teammate instead.
 */
function AboutLine({
  title,
  off,
  asking = false,
  own = false,
  answered = null,
  refused,
  name,
  onChange,
}: {
  title: string
  off: boolean
  asking?: boolean
  /** A person's own run: "Your run’s chat: <title>" (aboutLineLabel). */
  own?: boolean
  answered?: string | null
  refused: string | null
  name: string
  onChange?: (on: boolean) => void
}) {
  const button = (label: string, on: boolean) =>
    onChange && (
      <button
        type="button"
        data-teammate-chat-about-switch={on ? 'item' : 'teammate'}
        onClick={() => onChange(on)}
        className="min-w-0 shrink-0 truncate rounded-full px-1.5 py-0.5 font-medium text-foreground/70 transition-colors hover:bg-black/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 dark:hover:bg-white/[0.1]"
      >
        {label}
      </button>
    )
  return (
    <div
      data-teammate-chat-about={off ? 'off' : refused ? 'refused' : answered ? 'answered' : asking ? 'asking' : 'on'}
      className={cn(BOT_GLASS_PILL, ENTER, BOT_GLASS_MUTED, 'pointer-events-auto flex min-w-0 max-w-full items-center gap-1.5 self-start py-[3px] pl-2.5 pr-1 text-[11px] leading-4')}
    >
      {refused ? (
        <span className="min-w-0 py-0.5 pr-1.5">{refused}</span>
      ) : answered ? (
        <span className="min-w-0 py-0.5 pr-1.5">{answered}</span>
      ) : off ? (
        <>
          <span className="min-w-0 shrink-0">Talking to {name}</span>
          {button(`About: ${title}`, true)}
        </>
      ) : (
        <>
          <span className="min-w-0 truncate" title={title}>
            {aboutLineLabel({ asking, own })}: {title}
          </span>
          {button(`${name}’s own chat`, false)}
        </>
      )}
    </div>
  )
}

type ViewProps = Pick<TeammateChatProps, 'className' | 'userAvatarUrl' | 'userInitials' | 'placeholder' | 'density' | 'autoFocus' | 'avatar' | 'beforeComposer'> & {
  /** Whose draft the box keeps (the teammate's id; `run:<id>` while it's about a run's item). */
  draftKey: string
  /** The "About:" line over the box, while the chat is about an item. */
  about?: ReactNode
  /** The main chat's composer instead of the pill (null: the pill). */
  full?: FullComposer | null
}

/** The voice button the view puts at the end of the box: the mic (pressed while you talk). */
interface TeammateChatMic {
  /** A voice conversation is live: the mic stays put whatever's typed or streaming. */
  talking: boolean
  node: ReactNode
}

/** The chat with a mic: a voice conversation whose turns are this chat's, its replies read aloud. */
function VoicedTeammateChat({
  chat,
  voice,
  chatKey,
  ...view
}: ViewProps & { chat: TeammateChatState; voice: TeammateChatVoice; chatKey: string }) {
  const recording = useOptionalRecordingStable()
  const capturing = !!(recording?.isRecording || recording?.isStarting)
  const readAloud = useReadAloud({
    messages: chat.messages,
    status: chat.status,
    recording: capturing,
    active: voice.readReplies,
    voice: voice.ttsVoice,
  })
  const availability = useVoiceAvailability({ recording: capturing })

  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), TEAMMATE_CHAT_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const send = chat.sendMessage
  // With the full composer, a spoken turn goes out through it (so it carries
  // what a typed one does: the armed skill, the files, the mentions).
  const spokenTurnRef = useRef<((text: string) => Promise<boolean>) | null>(null)
  const sendTurn = useCallback(
    async (text: string) => {
      const spoken = spokenTurnRef.current
      const sent = spoken ? await spoken(text) : await send(text)
      if (!sent) setNotice('Couldn’t send that. Try again in a moment.')
    },
    [send],
  )
  const voiceMode = useVoiceMode({
    canStart: availability.conversation && !availability.blocked,
    blocked: !!availability.blocked,
    active: true,
    chatKey,
    status: chat.status,
    stop: chat.stop,
    sendTurn,
    readAloud,
    greeting: false,
    interceptTurn: voice.interceptTurn,
  })

  // The host hears how the talk is going, and idle once it's gone.
  const speaking = readAloud.speakingMessageId !== null
  const stopSpeaking = readAloud.stop
  const onStateRef = useRef(voice.onState)
  onStateRef.current = voice.onState
  useEffect(() => {
    onStateRef.current?.({ listening: voiceMode.active, speaking, stopSpeaking })
  }, [voiceMode.active, speaking, stopSpeaking])
  useEffect(() => () => onStateRef.current?.(TEAMMATE_CHAT_VOICE_IDLE), [])

  // Stop also silences the reply being read.
  const chatStop = chat.stop
  const stop = useCallback(() => {
    stopSpeaking()
    chatStop()
  }, [stopSpeaking, chatStop])
  // A typed message: the host hears it went out (spoken turns go by sendTurn).
  const onTypedSendRef = useRef(voice.onTypedSend)
  onTypedSendRef.current = voice.onTypedSend
  const typedSend = useCallback(
    (text: string, opts?: TeammateSendOptions) => {
      onTypedSendRef.current?.()
      return send(text, opts)
    },
    [send],
  )

  const { start, end } = voiceMode
  const talking = voiceMode.active
  const toggleTalk = useCallback(async () => {
    if (talking) {
      end()
      return
    }
    if (availability.blocked) return
    if (!availability.conversation) {
      setNotice(voiceRefusalMessage('not_ready'))
      return
    }
    setNotice(null)
    const refusal = await start()
    // Another Native Intelligence window has the voice (busy), the mic's denied, …: say so here.
    if (refusal) setNotice(voiceRefusalMessage(refusal.code, refusal.detail))
  }, [talking, availability.blocked, availability.conversation, start, end])

  const name = chat.teammateName ?? 'this teammate'
  const label = talking ? 'Stop talking' : `Talk to ${name}`
  // Talking needs both speech models: no mic until they're ready (it stays
  // through a talk already going).
  const mic: TeammateChatMic | null = availability.conversation || talking
    ? {
        talking,
        node: (
          <PromptInputAction tooltip={availability.blocked ? voiceBlockedLabel(availability.blocked) : label}>
            <button
              type="button"
              data-teammate-chat-mic=""
              data-talking={talking ? '' : undefined}
              aria-label={label}
              aria-pressed={talking}
              disabled={!!availability.blocked}
              onClick={() => void toggleTalk()}
              className={cn(ROUND_MAIN, talking && 'shadow-[0_0_0_3px_hsl(var(--primary)/0.14)]')}
            >
              <Mic className="h-4 w-4" />
            </button>
          </PromptInputAction>
        ),
      }
    : null

  // The label above the box is for the eye: the region beside it (always
  // mounted, so its first change is read) says the phase or the refusal,
  // never the words heard as they come.
  const status = (
    <>
      {(notice || talking) && (
        <div
          data-teammate-chat-voice=""
          className={cn(BOT_GLASS_PILL, ENTER, BOT_GLASS_MUTED, 'flex min-w-0 max-w-full items-center gap-1.5 self-end px-2.5 py-[3px] text-[11px] leading-4')}
        >
          {notice ? (
            <span className="min-w-0">{notice}</span>
          ) : (
            <>
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse" />
              <span className="shrink-0">{VOICE_PHASE_LABEL[voiceMode.phase]}</span>
              <Heard live={voiceMode.live} />
            </>
          )}
        </div>
      )}
      <VoicePhaseAnnouncer voice={voiceMode} notice={notice} />
    </>
  )

  // While you talk, the box lights the way the main composer's does in voice
  // mode (VoiceModeGlow: the beam along its bottom edge, swelling with your
  // voice or the bot's, gathered into the travelling beam while it thinks;
  // off while muted).
  const glow = (
    <VoiceModeGlow live={voiceMode.live} active={talking && voiceMode.phase !== 'muted'} thinking={voiceMode.phase === 'thinking'} />
  )

  // The full composer (a window of its own): the main chat's voice controls
  // (ChatInput: the mic, voice mode, its glow and announcer), the replies'
  // read aloud buttons, and spoken turns through the composer.
  const composerVoice = useMemo<ChatInputVoice>(() => ({ availability, mode: voiceMode }), [availability, voiceMode])
  if (view.full) {
    return (
      <ReadAloudContext.Provider value={readAloud}>
        <TeammateChatView chat={{ ...chat, stop, sendMessage: typedSend }} composerVoice={composerVoice} spokenTurnRef={spokenTurnRef} {...view} />
      </ReadAloudContext.Provider>
    )
  }

  // One box whichever chat it's in (the talk above lives on): see the view's draft carry-over.
  return <TeammateChatView chat={{ ...chat, stop, sendMessage: typedSend }} mic={mic} status={status} glow={glow} {...view} />
}

/** The words heard this turn, as they come (audio rate: only this re-renders). Seen, not announced. */
function Heard({ live }: { live: VoiceLiveStore }) {
  const transcript = useSyncExternalStore(live.subscribe, () => live.get().transcript, () => null)
  const words = transcript ? `${transcript.final}${transcript.interim}`.trim() : ''
  return words ? (
    <span aria-hidden data-teammate-chat-heard="" className="min-w-0 truncate italic">
      “{words}”
    </span>
  ) : null
}

/** Whether ChatMessage draws anything for it (it draws nothing for a reply with nothing in it yet). */
function drawsSomething(message: UIMessage): boolean {
  if (message.role === 'user') return true
  return message.parts.some((part) => {
    if (part.type === 'text') return !!part.text
    if (part.type === 'reasoning') return !!part.text?.trim()
    return part.type === 'file' || part.type === 'dynamic-tool' || part.type.startsWith('tool-')
  })
}

/** A message's words, for the stack's one-line preview. */
function previewOf(message: UIMessage): string {
  const text = message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return message.role === 'user' ? `You: ${text}` : text
}

/** History opens explicitly, or for a keyboard user entering a folded message. */
type StackOpen = null | 'focus' | 'pinned'

function useStackOpen(latestUserMessageId: string | null) {
  const [open, setOpen] = useState<StackOpen>(null)
  // Sending brings the latest exchange back into view, as before.
  const [own, setOwn] = useState(latestUserMessageId)
  if (own !== latestUserMessageId) {
    setOwn(latestUserMessageId)
    if (open) setOpen(null)
  }
  return {
    open,
    toggle: () => setOpen((value) => value === null ? 'pinned' : null),
    pin: () => setOpen((value) => value === 'focus' ? 'pinned' : value),
    focusIn: (event: FocusEvent<HTMLElement>) => {
      if (event.target instanceof Element && event.target.closest('[data-teammate-chat-stacked]')) setOpen((value) => value ?? 'focus')
    },
    focusOut: (event: FocusEvent<HTMLElement>) => {
      if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOpen((value) => value === 'focus' ? null : value)
    },
  }
}

/** Where an element sits in `box`'s content (px from its top, scroll aside, transforms aside), or null when `box` isn't an offset parent of it. */
function offsetIn(el: HTMLElement, box: HTMLElement): number | null {
  let y = 0
  let at: HTMLElement | null = el
  while (at && at !== box) {
    y += at.offsetTop
    at = at.offsetParent as HTMLElement | null
  }
  return at === box ? y : null
}

/**
 * The compact log's soft edges: where the log cuts messages off (more of it
 * scrolled away above, or below), they fade out toward that edge instead of
 * ending on a hard line, the fade deepening over the first
 * TEAMMATE_CHAT_FADE_PX scrolled (none at rest at the top or bottom, where
 * the log's padding keeps them clear of the stack and the box anyway).
 *
 * Not a mask on the log: a masked ancestor switches the cards' backdrop blur
 * off. Each piece in it (`data-teammate-chat-piece`: a card, the face beside
 * one, a pill) wears its own mask instead, in its own box, worked out from
 * where it sits in the log. Only a piece an edge's fade reaches is masked (a
 * mask also clips the card's shadow and the actions under it); the rest wear
 * none. Again on a scroll, on the log's size or a piece's changing, on the
 * DOM changing in it (a message arriving, streaming, folding) and when a fold
 * ends; a folded message (in the stack) is never masked.
 */
function useLogEdgeFade(scrollRef: RefObject<HTMLDivElement | null>, enabled: boolean, onResize?: () => void) {
  // Told as sizes change, before the fade is worked out (the log follows its newest content).
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize
  useLayoutEffect(() => {
    const log = scrollRef.current
    if (!enabled || !log) return
    const F = TEAMMATE_CHAT_FADE_PX
    const masked = new Set<HTMLElement>()
    const observed = new Set<HTMLElement>()
    const setMask = (piece: HTMLElement, mask: string) => {
      if (!mask && !masked.has(piece)) return
      piece.style.setProperty('mask-image', mask)
      piece.style.setProperty('-webkit-mask-image', mask)
      if (mask) masked.add(piece)
      else masked.delete(piece)
    }
    let raf = 0
    const later = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          fade()
        })
    }
    const resized =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            onResizeRef.current?.()
            later()
          })
    const fade = () => {
      const view = log.clientHeight
      const top = log.scrollTop
      const above = Math.min(1, top / F)
      const below = Math.min(1, Math.max(0, log.scrollHeight - top - view) / F)
      const pieces = log.querySelectorAll<HTMLElement>('[data-teammate-chat-piece]')
      for (const piece of masked) if (!piece.isConnected) masked.delete(piece)
      for (const piece of observed) {
        if (piece.isConnected) continue
        resized?.unobserve(piece)
        observed.delete(piece)
      }
      for (const piece of pieces) {
        if (!observed.has(piece)) {
          resized?.observe(piece)
          observed.add(piece)
        }
        const y = offsetIn(piece, log)
        if (y === null || piece.closest('[data-teammate-chat-stacked]')) {
          setMask(piece, '')
          continue
        }
        // Its top and bottom from the log's top edge, as it shows now.
        const from = y - top
        const to = from + piece.offsetHeight
        const stops: string[] = []
        if (above > 0.01 && from < F && to > 0) stops.push(`rgb(0 0 0 / ${(1 - above).toFixed(2)}) ${-from}px`, `#000 ${F - from}px`)
        if (below > 0.01 && to > view - F && from < view) stops.push(`#000 ${view - F - from}px`, `rgb(0 0 0 / ${(1 - below).toFixed(2)}) ${view - from}px`)
        setMask(piece, stops.length ? `linear-gradient(to bottom, ${stops.join(', ')})` : '')
      }
    }
    fade()
    log.addEventListener('scroll', fade, { passive: true })
    log.addEventListener('transitionend', later)
    resized?.observe(log)
    const changed = typeof MutationObserver === 'undefined' ? null : new MutationObserver(later)
    changed?.observe(log, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] })
    return () => {
      cancelAnimationFrame(raf)
      log.removeEventListener('scroll', fade)
      log.removeEventListener('transitionend', later)
      resized?.disconnect()
      changed?.disconnect()
      for (const piece of masked) setMask(piece, '')
    }
  }, [scrollRef, enabled])
}

/** The chat itself: the log, a line above the box (`status`), and the box with its round button (`mic` there when there's a voice). */
function TeammateChatView({
  chat,
  draftKey,
  className,
  userAvatarUrl = null,
  userInitials = 'You',
  placeholder,
  density = 'comfortable',
  autoFocus = false,
  avatar = null,
  beforeComposer = null,
  mic = null,
  status = null,
  glow = null,
  about = null,
  full = null,
  composerVoice,
  spokenTurnRef,
}: ViewProps & {
  chat: TeammateChatState
  mic?: TeammateChatMic | null
  status?: ReactNode
  glow?: ReactNode
  /** The full composer's voice (the desktop app: dictation, voice mode). */
  composerVoice?: ChatInputVoice
  /** Filled with the full composer's send, for a spoken turn. */
  spokenTurnRef?: MutableRefObject<((text: string) => Promise<boolean>) | null>
}) {
  const { messages, sendMessage, status: chatStatus, stop, error, teammateName, loading, note, noteAction } = chat
  // What was typed to this teammate before (the bubble closed, another picked), kept as it changes.
  const [input, setInput] = useState(() => teammateDraft(draftKey))
  // The chat it's in changed under the box (the item on show moved on, the
  // "About:" line switched, a run's chat refused): one box, never remounted.
  // What's being typed stays, and moves to the new chat's draft; an empty box
  // takes that chat's draft. Focus stays where it is.
  const inputNow = useRef(input)
  inputNow.current = input
  const keyedTo = useRef(draftKey)
  useLayoutEffect(() => {
    const was = keyedTo.current
    if (was === draftKey) return
    keyedTo.current = draftKey
    if (inputNow.current.trim()) setTeammateDraft(was, '')
    else setInput(teammateDraft(draftKey))
  }, [draftKey])
  useEffect(() => setTeammateDraft(draftKey, input), [draftKey, input])
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const logId = useId()

  const streaming = chatStatus === 'streaming' || chatStatus === 'submitted'
  const name = teammateName ?? 'this teammate'
  const compact = density === 'compact'

  // Its box takes focus as it mounts: from nowhere, or from what's around it
  // (the dialog it opened in), never from somewhere you've gone since. An
  // effect, not the textarea's autoFocus: that runs in the commit, before a
  // dialog around it takes focus in its own layout effect, taking it back.
  useEffect(() => {
    if (!autoFocus) return
    const box = rootRef.current?.querySelector('textarea')
    const now = document.activeElement
    if (box && (!now || now === document.body || now.contains(box))) box.focus({ preventScroll: true })
    // As it mounts only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const latestUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].id
    return null
  }, [messages])

  const stack = useStackOpen(latestUserMessageId)
  const opened = stack.open !== null

  // Follow the newest content as it grows, while you're at the bottom (read
  // before the update: growing content fires no scroll); a message of your own
  // always brings you down to it.
  const stuck = useRef(true)
  const lastOwn = useRef(latestUserMessageId)
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= TEAMMATE_CHAT_STICK_PX
  }, [])
  useEffect(() => {
    const el = scrollRef.current
    const own = latestUserMessageId !== lastOwn.current
    lastOwn.current = latestUserMessageId
    if (!el || !(own || stuck.current)) return
    el.scrollTop = el.scrollHeight
    stuck.current = true
  }, [messages, loading, latestUserMessageId])
  // Compact: the log's cut edges fade (each card its own mask, so the glass
  // keeps its blur); and while you're at the bottom, content growing on its
  // own (a card's markdown settling, the log getting more room) keeps you
  // there too, before it's painted.
  const followGrowth = useCallback(() => {
    const el = scrollRef.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [])
  useLogEdgeFade(scrollRef, compact, followGrowth)
  // The stack opening or folding lands on the newest (laid out at once, before it's painted).
  const firstLayout = useRef(true)
  useLayoutEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false
      return
    }
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stuck.current = true
  }, [opened])
  const last = messages[messages.length - 1]
  const streamingMessageId = streaming && last?.role === 'assistant' ? last.id : null

  // Not while the thread is still opening (Enter would send into nothing); a
  // send that didn't go out (the thread couldn't open) gives its text back.
  const handleSubmit = useCallback(() => {
    const text = input.trim()
    if (!text || streaming || loading) return
    setInput('')
    void sendMessage(text).then((sent) => {
      if (!sent) setInput((now) => now || text)
    })
  }, [input, streaming, loading, sendMessage])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== 'Escape') return
      const composing = e.nativeEvent.isComposing
      if (!composing && !input) return
      e.preventDefault()
      e.stopPropagation()
      if (!composing) setInput('')
    },
    [input],
  )

  // The box's round button: the mic while you talk (with send or stop beside
  // it when there's one to give); else stop while a reply streams, send once
  // something's typed (or with no voice), and the mic in an empty box.
  const hasText = !!input.trim()
  const sendButton = (quiet: boolean) => (
    <PromptInputAction tooltip="Send">
      <button
        type="button"
        className={quiet ? ROUND_QUIET : ROUND_MAIN}
        disabled={!hasText || loading}
        onClick={handleSubmit}
        aria-label="Send"
      >
        <ArrowUp className="h-4 w-4" />
      </button>
    </PromptInputAction>
  )
  const stopButton = (quiet: boolean) => (
    <PromptInputAction tooltip="Stop">
      <button type="button" className={quiet ? ROUND_QUIET : ROUND_MAIN} onClick={() => stop()} aria-label="Stop">
        <Square className="h-3 w-3 fill-current" />
      </button>
    </PromptInputAction>
  )
  // Only a button taking another's place pops in, not those the box opens with.
  const composerShown = useRef(false)
  useEffect(() => {
    composerShown.current = true
  }, [])
  let main: { key: string; node: ReactNode }
  let beside: { key: string; node: ReactNode } | null = null
  if (mic?.talking) {
    main = { key: 'mic', node: mic.node }
    if (streaming) beside = { key: 'stop', node: stopButton(true) }
    else if (hasText) beside = { key: 'send', node: sendButton(true) }
  } else if (streaming) main = { key: 'stop', node: stopButton(false) }
  else if (hasText || !mic) main = { key: 'send', node: sendButton(false) }
  else main = { key: 'mic', node: mic.node }

  // The full composer (a window of its own, bots v4): the main chat's, with
  // everything it adds riding the message to this conversation (the
  // teammate's thread, or a run's chat: each store sends it its own way).
  const sendFull = useCallback(
    (text: string, extras: ComposerTurnExtras) => sendMessage(text, { turn: extras }),
    [sendMessage],
  )
  const composer = full ? (
    <div data-teammate-chat-composer="full" className="pointer-events-auto shrink-0">
      <ConversationComposer
        value={input}
        onChange={setInput}
        onSend={sendFull}
        onStop={stop}
        isLoading={streaming}
        holdSend={loading}
        placeholder={
          placeholder ??
          (messages.length > 0 ? `Message ${teammateName ?? 'teammate'}…` : `Message ${teammateName ?? 'your teammate'} — @ to mention`)
        }
        hasMessages={messages.length > 0}
        autoFocus={autoFocus}
        voice={composerVoice}
        unavailable={full.unavailable}
        workspaceId={full.workspaceId}
        spokenTurnRef={spokenTurnRef}
      />
    </div>
  ) : (
    <PromptInput
      value={input}
      onValueChange={setInput}
      onSubmit={handleSubmit}
      isLoading={streaming}
      maxHeight={128}
      // `relative`: the voice glow is an overlay inside it (ComposerVoiceGlow).
      className={cn(BOT_GLASS, ENTER, 'pointer-events-auto relative flex shrink-0 items-end gap-1 rounded-[22px] p-[5px] pl-3.5')}
    >
      <PromptInputTextarea
        placeholder={
          placeholder ??
          (compact && !loading && messages.length === 0
            ? `Ask ${teammateName ?? 'your teammate'} anything…`
            : `Message ${teammateName ?? 'teammate'}…`)
        }
        aria-label={`Message ${name}`}
        className={cn('min-h-0 min-w-0 flex-1 px-0 py-1.5 leading-5', compact ? 'text-[13px]' : 'text-sm')}
        rows={1}
        onKeyDown={handleKeyDown}
      />
      <PromptInputActions className="shrink-0 gap-1">
        {beside && (
          <PoppedIn key={beside.key} pop={composerShown.current}>
            {beside.node}
          </PoppedIn>
        )}
        <PoppedIn key={main.key} pop={composerShown.current}>
          {main.node}
        </PoppedIn>
      </PromptInputActions>
      {/* Talking: the main composer's voice glow along the pill's bottom edge
          (a click-through overlay, its beam clipped to the pill's rounding; a
          child of the glass, so its blur stays on). */}
      {glow}
    </PromptInput>
  )

  const errorLine = error && (
    <div
      role="alert"
      className={compact ? cn(BOT_GLASS, ENTER, 'self-start rounded-2xl px-3 py-1.5 text-xs text-destructive') : 'px-1 text-xs text-destructive'}
    >
      {error.message || 'Something went wrong.'}
    </div>
  )

  return (
    <div
      ref={rootRef}
      data-teammate-chat-density={density}
      data-teammate-chat-busy={streaming ? '' : undefined}
      data-teammate-chat-draft={input.trim() ? '' : undefined}
      className={cn('flex h-[420px] max-h-[70vh] w-[320px] min-h-0 flex-col', compact ? 'gap-1.5' : 'gap-2', className)}
    >
      {compact ? (
        <MessageStack
          messages={messages}
          loading={loading}
          streaming={streaming}
          streamingMessageId={streamingMessageId}
          latestUserMessageId={latestUserMessageId}
          userAvatarUrl={userAvatarUrl}
          userInitials={userInitials}
          avatar={avatar}
          name={name}
          logId={logId}
          scrollRef={scrollRef}
          onScroll={onScroll}
          stack={stack}
        />
      ) : null}
      {compact && note && !loading && messages.length === 0 && (
        <div data-teammate-chat-note="" className={cn(BOT_GLASS, ENTER, 'pointer-events-auto flex flex-col items-start gap-1.5 self-start rounded-2xl px-3 py-2 text-xs text-foreground/80')}>
          <p>{note}</p>
          {noteAction && (
            <button
              type="button"
              data-teammate-chat-note-action=""
              onClick={noteAction.run}
              className="inline-flex h-6 items-center rounded-full border border-border/60 px-2.5 text-[11px] font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {noteAction.label}
            </button>
          )}
        </div>
      )}
      {compact ? null : (
        <div
          ref={scrollRef}
          role="log"
          aria-label={`Conversation with ${name}`}
          aria-live="polite"
          aria-busy={streaming || loading}
          onScroll={onScroll}
          className="pointer-events-auto flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1"
        >
          {loading ? (
            <p className="py-4 text-center text-xs text-muted-foreground">Loading…</p>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-4">
              <p data-teammate-chat-note={note ? '' : undefined} className="text-center text-sm text-muted-foreground">
                {note ?? `Ask ${name} anything about its work.`}
              </p>
              {noteAction && (
                <button
                  type="button"
                  data-teammate-chat-note-action=""
                  onClick={noteAction.run}
                  className="pointer-events-auto inline-flex h-7 items-center rounded-full border border-border/60 px-3 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {noteAction.label}
                </button>
              )}
            </div>
          ) : (
            // Its messages are drawn in cards, never straight on the sky (even inside the main chat).
            <OnSkyContext.Provider value={false}>
              <ChatMessageList
                messages={messages}
                latestUserMessageId={latestUserMessageId}
                userAvatarUrl={userAvatarUrl}
                userInitials={userInitials}
                streamingMessageId={streamingMessageId}
              />
            </OnSkyContext.Provider>
          )}
          {/* Thinking orb while a turn is submitted but hasn't started streaming —
              the main chat's indicator. */}
          {chatStatus === 'submitted' && last?.role === 'user' && (
            <div className="flex items-center gap-3 px-1">
              <Loader variant="orb" orbState="working" size="md" />
            </div>
          )}
        </div>
      )}

      {errorLine}

      {about}

      {status}

      {beforeComposer}

      {composer}
    </div>
  )
}

/** A button taking another's place in the box pops in (`pop`: not as the box first shows). */
function PoppedIn({ pop, children }: { pop: boolean; children: ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <motion.span
      className="inline-flex"
      initial={pop ? (reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }) : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduce ? { duration: 0.15 } : { type: 'spring', stiffness: 600, damping: 30 }}
    >
      {children}
    </motion.span>
  )
}
type StackControls = ReturnType<typeof useStackOpen>

/**
 * The compact log: every message (the window ChatMessageList keeps) as its own
 * card, the older ones folded into the stack above the newest
 * TEAMMATE_CHAT_STACK_SHOWN, or all of them open, scrolling.
 */
function MessageStack({
  messages,
  loading,
  streaming,
  streamingMessageId,
  latestUserMessageId,
  userAvatarUrl,
  userInitials,
  avatar,
  name,
  logId,
  scrollRef,
  onScroll,
  stack,
}: {
  messages: UIMessage[]
  loading: boolean
  streaming: boolean
  streamingMessageId: string | null
  latestUserMessageId: string | null
  userAvatarUrl: string | null
  userInitials: string
  avatar: ReactNode
  name: string
  logId: string
  scrollRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  stack: StackControls
}) {
  const [showAll, setShowAll] = useState(false)
  const { visible, hiddenCount } = windowChatMessages(messages, showAll)
  const drawn = visible.filter(drawsSomething)
  const opened = stack.open !== null
  const folded = opened ? 0 : Math.max(0, drawn.length - TEAMMATE_CHAT_STACK_SHOWN)
  // What was there as the thread came up is history: only what arrives after rises in.
  const known = useRef<Set<string> | null>(null)
  if (known.current === null && !loading) known.current = new Set(messages.map((m) => m.id))
  const fresh = (id: string) => known.current !== null && !known.current.has(id)

  const last = messages[messages.length - 1]
  const lastDrawn = drawn[drawn.length - 1]
  // Waiting on the reply: submitted, or streaming with nothing to show yet.
  const thinking = streaming && !!last && (last.role === 'user' || !drawsSomething(last))

  return (
    <div
      data-teammate-chat-history=""
      data-stack={opened ? 'open' : 'folded'}
      className="flex min-h-0 flex-1 flex-col"
      onFocus={stack.focusIn}
      onBlur={stack.focusOut}
    >
      {(folded > 0 || opened) && drawn.length > TEAMMATE_CHAT_STACK_SHOWN && (
        <StackToggle
          count={folded + hiddenCount}
          opened={opened}
          preview={folded > 0 ? previewOf(drawn[folded - 1]) : ''}
          controls={logId}
          stack={stack}
        />
      )}
      <div
        ref={scrollRef}
        id={logId}
        role="log"
        aria-label={`Conversation with ${name}`}
        aria-live="polite"
        aria-busy={streaming || loading}
        onScroll={onScroll}
        onWheel={opened ? stack.pin : undefined}
        onPointerDown={opened ? stack.pin : undefined}
        // Room round the cards for their shadows (a scroll box clips): the
        // side padding sits outside the column. Top and bottom, room enough
        // that at rest no message sits right under the stack (or Show less)
        // or touches the box (less under a reply that ends in its actions'
        // room); scrolled, the cut edge fades (useLogEdgeFade).
        className={cn(
          'relative -mx-3 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 pb-3 pt-2.5',
          '[&:has(>[data-teammate-chat-message]:last-child_[data-message-actions])]:pb-1',
          COMPACT_LOG,
          opened ? COMPACT_LOG_OPEN : 'scrollbar-hide',
        )}
      >
        {opened && hiddenCount > 0 && (
          <button
            type="button"
            data-teammate-chat-piece=""
            onClick={() => setShowAll(true)}
            className={cn(BOT_GLASS_PILL, ENTER, BOT_GLASS_MUTED, 'pointer-events-auto self-center px-3 py-1 text-[11px] hover:text-foreground dark:hover:text-foreground')}
          >
            Show earlier messages ({hiddenCount})
          </button>
        )}
        {loading && (
          <p data-teammate-chat-piece="" className={cn(BOT_GLASS_PILL, ENTER, BOT_GLASS_MUTED, 'self-center px-3 py-1 text-[11px]')}>
            Loading…
          </p>
        )}
        {drawn.map((message, i) => {
          const teammate = message.role !== 'user'
          // Its face on the first of a run of its messages, among those showing.
          const first = teammate && (i === folded || drawn[i - 1]?.role === 'user')
          return (
            <StackedMessage
              key={message.id}
              message={message}
              stacked={i < folded}
              fresh={fresh(message.id)}
              avatar={teammate && avatar ? avatar : null}
              face={first}
              name={name}
              latestUser={message.id === latestUserMessageId}
              streaming={message.id === streamingMessageId}
              userAvatarUrl={userAvatarUrl}
              userInitials={userInitials}
            />
          )
        })}
        {/* Waiting on the reply: the main chat's thinking orb, in a card of its own. */}
        {thinking && (
          <ThinkingCard avatar={avatar} name={name} face={!lastDrawn || lastDrawn.role === 'user'} />
        )}
      </div>
    </div>
  )
}

/**
 * The stack's face, and its toggle. Folded: a card saying how many earlier
 * messages are in it, with the newest of them as a one-line preview and the
 * edges of the ones behind it peeking out above. Open: a small "Show less".
 * One button either way, so focus stays on it as it turns.
 */
function StackToggle({
  count,
  opened,
  preview,
  controls,
  stack,
}: {
  count: number
  opened: boolean
  preview: string
  controls: string
  stack: StackControls
}) {
  return (
    <div className="relative flex shrink-0 pb-1">
      <button
        type="button"
        data-teammate-chat-earlier=""
        aria-expanded={opened}
        aria-controls={controls}
        aria-label={opened ? 'Show less' : `Show ${count} earlier message${count === 1 ? '' : 's'}`}
        onClick={stack.toggle}
        className={cn(BOT_GLASS_PILL, ENTER, 'pointer-events-auto flex h-8 w-full min-w-0 items-center gap-2 px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60', BOT_GLASS_MUTED)}
      >
        {opened ? <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0" /> : <History aria-hidden className="h-3.5 w-3.5 shrink-0" />}
        <span className="shrink-0 font-medium">{opened ? 'Show less' : 'History'}</span>
        {!opened && <>
          <span aria-hidden className="min-w-0 flex-1 truncate text-left">{preview}</span>
          <span aria-hidden className="shrink-0 tabular-nums">{count}</span>
        </>}
      </button>
    </div>
  )
}

/**
 * One message, in its card. Folded into the stack it takes no room (its row
 * of a grid goes to nothing as it shrinks and fades upward) but stays in the
 * log; a new one rises in from below (`fresh`, its first mount only).
 */
const StackedMessage = memo(function StackedMessage({
  message,
  stacked,
  fresh,
  avatar,
  face,
  name,
  latestUser,
  streaming,
  userAvatarUrl,
  userInitials,
}: {
  message: UIMessage
  stacked: boolean
  fresh: boolean
  /** The teammate's face (null for yours, or with none given). */
  avatar: ReactNode
  /** The first of a run: the sender identity shows inside the card. */
  face: boolean
  name: string
  latestUser: boolean
  streaming: boolean
  userAvatarUrl: string | null
  userInitials: string
}) {
  const reduce = useReducedMotion()
  const user = message.role === 'user'
  const content = (
    <ChatMessage message={message} userAvatarUrl={userAvatarUrl} userInitials={userInitials} streaming={streaming} wholeReadAloud />
  )
  return (
    <div
      data-teammate-chat-message={message.id}
      data-teammate-chat-stacked={stacked ? '' : undefined}
      data-latest-user-message={latestUser ? '' : undefined}
      // Folding animates its height (its card fades and shrinks upward with
      // it); opening is at once, the card fading in, so the log lands on the
      // newest in one layout. With reduced motion only the fade.
      className={cn(
        'group/msg relative grid grid-cols-[minmax(0,1fr)] hover:z-10 focus-within:z-10',
        stacked
          ? '-mb-2 grid-rows-[0fr] transition-[grid-template-rows,margin] duration-300 ease-out motion-reduce:transition-none'
          : 'grid-rows-[1fr]',
      )}
    >
      <div className={cn('min-h-0', stacked && 'overflow-hidden')}>
        <div
          className={cn(
            'transition-transform duration-300 ease-out motion-reduce:transition-none',
            user ? 'origin-top-right' : 'origin-top-left',
            stacked && '-translate-y-1 scale-[0.96] motion-reduce:translate-y-0 motion-reduce:scale-100',
          )}
        >
          <motion.div
            initial={fresh && !reduce ? RISE_FROM : false}
            animate={RISE_TO}
            transition={RISE_SPRING}
            style={{ transformOrigin: user ? 'bottom right' : 'bottom left' }}
            className={cn('flex items-start gap-1.5', user ? 'justify-end' : 'justify-start')}
          >
            {user ? (
              <div data-teammate-chat-piece="" className={cn(USER_CARD, ENTER, stacked && 'opacity-0 duration-300')}>
                {content}
              </div>
            ) : (
              <div className={TEAMMATE_CARD}>
                <div
                  aria-hidden
                  data-teammate-chat-piece=""
                  className={cn(TEAMMATE_GLASS, ENTER, stacked && 'opacity-0 duration-300')}
                />
                <div data-teammate-chat-piece="" className={cn(TEAMMATE_CONTENT, ENTER, stacked && 'opacity-0 duration-300')}>
                  {avatar && face && <MessageIdentity avatar={avatar} name={name} />}
                  {content}
                </div>
              </div>
            )}
          </motion.div>
        </div>
      </div>
    </div>
  )
})

/** Waiting on the reply: the thinking orb in a small card of the teammate's. */
function ThinkingCard({ avatar, face, name }: { avatar: ReactNode; face: boolean; name: string }) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : RISE_FROM}
      animate={RISE_TO}
      transition={RISE_SPRING}
      style={{ transformOrigin: 'bottom left' }}
      className="w-full"
    >
      <div data-teammate-chat-piece="" className={cn(BOT_GLASS, ENTER, 'pointer-events-auto min-w-0 rounded-[18px] px-3 py-2')}>
        {avatar && face && <MessageIdentity avatar={avatar} name={name} />}
        <Loader variant="orb" orbState="working" size="sm" />
      </div>
    </motion.div>
  )
}

export { useTeammateChat } from '@/hooks/use-teammate-chat'
export type { TeammateChat as TeammateChatState, UseTeammateChatOptions } from '@/hooks/use-teammate-chat'
