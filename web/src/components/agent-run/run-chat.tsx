'use client'

/**
 * RunChat — the canonical follow-up-chat surface for a settled, chattable run
 * (Loops v3 interactive work runs; a loop run's too, bots v3 Phase 4). It talks
 * to the run's PARKED eve session through the run-chat proxy (RunChatTransport)
 * and renders the conversation with the MAIN chat's components: chat-message.tsx
 * (text + Tool chips) and the QuestionPicker — so the run chat looks and behaves
 * exactly like the app's chat, not a bespoke mini-widget.
 *
 * The composer is the MAIN chat's too (bots v4: "the pop-up should have the
 * full chat capabilities"): ConversationComposer, ChatInput itself. Skills
 * (from "/"), text files (the + menu, a drop, a
 * paste), @-mentions, dictation and voice mode, stop. What a run's session
 * can't honour shows dimmed with the reason: the agent (the run is its bot's),
 * photos (no file part ever reaches a run's agent: run-chat-turn.ts) and "My
 * captures" (a run's tools are built without search settings). Every turn goes
 * to the run's exact parked session, with what the composer added checked
 * server-side (run-chat-turn.ts).
 *
 * Mount contract: <RunChat runId={run.id} /> inside the Cloud-run view
 * (cloud-run-view.tsx: the action side panel, and a teammate's run tab) or a
 * loop run's tab (teammate-chat-page.tsx). Entity links in its messages open
 * as cards in the main chat (chat-message.tsx openTarget). The standalone
 * /account/agent-runs/[id] page keeps run-follow-up-chat.tsx instead.
 *
 * The conversation is useRunChat's (src/hooks/use-run-chat.ts): one per run,
 * shared with a bot's bubble replying about the item the run produced
 * (bots-v2.md "Items continue their run's chat"), replayed once, outliving
 * either surface. A run whose chat the route refuses says so, with no composer.
 * What's typed and not sent is kept as the bubble keeps it (the teammate
 * drafts, keyed `run:<id>`).
 *
 * `voice` (the desktop app): replies read aloud in that voice (and their read
 * aloud buttons), dictation and voice mode in the composer. Absent: typing only.
 *
 * ── The two answer paths ─────────────────────────────────────────────────────
 * A clarifying question renders as a `ask_user` tool part the QuestionPicker fills
 * in. Answering it routes by ORIGIN:
 *   - LIVE question (raised during a `sendMessages` turn still streaming): the
 *     transport holds that turn's stream open; the answer goes through
 *     transport.answerPermission(), which POSTs the resume and pumps the reply
 *     into the same open stream. (Same pattern the main chat uses.)
 *   - REPLAYED final question (rehydrated by loadRunChatHistory from a prior
 *     session; there is no open stream): the answer goes through sendMessage() with
 *     the eve inputResponses threaded on the body, which the transport reads and
 *     forwards on a fresh POST. `pendingQuestions` (from the loader) tells us which
 *     toolCallId is replayed-pending.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { isToolUIPart } from 'ai'
import { Loader } from '@/components/ui/loader'
import { ChatMessage } from '@/app/account/(dashboard)/chat/chat-message'
import { QuestionPicker } from '@/app/account/(dashboard)/chat/question-picker'
import { ConversationComposer } from '@/app/account/(dashboard)/chat/conversation-composer'
import type { ChatInputUnavailable, ChatInputVoice } from '@/app/account/(dashboard)/chat/chat-input'
import { ReadAloudContext } from '@/app/account/(dashboard)/chat/read-aloud-button'
import { MessageFeedbackContext } from '@/app/account/(dashboard)/chat/message-feedback-buttons'
import type { ComposerTurnExtras } from '@/app/account/(dashboard)/chat/composer-state'
import type { AgentQuestion } from '@/lib/chat/eve/agent-question'
import type { RunChatQuestionPayload } from '@/lib/agent-run/run-chat-events'
import { formatAnswers } from '@/lib/agent-run/run-chat-transport'
import { useRunChat, type RunChatHandle } from '@/hooks/use-run-chat'
import { setTeammateDraft, teammateDraft } from '@/hooks/use-teammate-chat'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { useReadAloud } from '@/hooks/use-read-aloud'
import { useVoiceAvailability } from '@/hooks/use-voice-availability'
import { useVoiceMode } from '@/hooks/use-voice-mode'
import { CHAT_PHOTOS_REASON, runChatAgentReason } from './run-chat-copy'

/** Talking to the run's agent out loud (the desktop app). */
export interface RunChatVoice {
  /** The voice its replies are read in (a bot's own); null: the Read aloud setting's. */
  ttsVoice: string | null
  /** Read the replies to typed turns aloud too, as auto-read does. */
  readReplies: boolean
}

export interface RunChatProps {
  /** The settled run to converse with (a work run's id, or a loop run's `loop:` id). Its parked eve session is the transcript. */
  runId: string
  /** Optional current user's avatar URL, forwarded to ChatMessage for user turns. */
  userAvatarUrl?: string | null
  /** Optional current user's initials fallback for the avatar. */
  userInitials?: string
  /** The run's workspace: the composer's skills and mentions are read there (the window's when absent). */
  workspaceId?: string | null
  /** The run's agent (its bot's name), for the composer's dimmed agent pill. */
  agentName?: string | null
  /** Talking out loud (the desktop app). */
  voice?: RunChatVoice
  /** The composer takes focus as it mounts. */
  autoFocus?: boolean
}

/** The `ask_user` picker input shape. */
interface PickerQuestionInput {
  questions?: AgentQuestion[]
}

/** Coerce a run-chat question payload's questions to the picker's shape. */
function toAgentQuestions(questions: AgentQuestion[] | undefined): AgentQuestion[] {
  return (questions ?? []).map((q) => ({
    question: q.question,
    header: q.header,
    options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
    multiSelect: q.multiSelect,
  }))
}

export function RunChat({ runId, voice, ...view }: RunChatProps) {
  // The run's one conversation (useRunChat's store): the same Chat and
  // transport a bot's bubble talks to about the item this run produced, so a
  // reply sent there is here, and a question asked there is answered here.
  const run = useRunChat(runId)!
  // No thumbs here: the run's replies aren't the main chat's conversation, so
  // the store ChatPanel provides (reached when a `show` card opens this run
  // inside the main chat) is cleared for the run's messages.
  return (
    <MessageFeedbackContext.Provider value={null}>
      {voice ? <VoicedRunChat run={run} voice={voice} {...view} /> : <RunChatView run={run} {...view} />}
    </MessageFeedbackContext.Provider>
  )
}

type ViewProps = Omit<RunChatProps, 'runId' | 'voice'>

/** The run's chat with a voice: replies read aloud (and their buttons), dictation and voice mode in the composer. */
function VoicedRunChat({ run, voice, ...view }: ViewProps & { run: RunChatHandle; voice: RunChatVoice }) {
  const recording = useOptionalRecordingStable()
  const capturing = !!(recording?.isRecording || recording?.isStarting)
  const readAloud = useReadAloud({
    messages: run.messages,
    status: run.status,
    recording: capturing,
    active: voice.readReplies,
    voice: voice.ttsVoice,
  })
  const availability = useVoiceAvailability({ recording: capturing })
  // Spoken turns go out through the composer, so they carry what a typed one does.
  const spokenTurnRef = useRef<((text: string) => Promise<boolean>) | null>(null)
  const sendTurn = useCallback(async (text: string) => {
    await spokenTurnRef.current?.(text)
  }, [])
  const voiceMode = useVoiceMode({
    canStart: availability.conversation && !availability.blocked,
    blocked: !!availability.blocked,
    active: true,
    chatKey: `run:${run.runId}`,
    status: run.status,
    stop: run.stop,
    sendTurn,
    readAloud,
    greeting: false,
  })
  const composerVoice = useMemo<ChatInputVoice>(() => ({ availability, mode: voiceMode }), [availability, voiceMode])
  return (
    <ReadAloudContext.Provider value={readAloud}>
      <RunChatView run={run} composerVoice={composerVoice} spokenTurnRef={spokenTurnRef} stopSpeaking={readAloud.stop} {...view} />
    </ReadAloudContext.Provider>
  )
}

function RunChatView({
  run,
  userAvatarUrl = null,
  userInitials = 'You',
  workspaceId = null,
  agentName = null,
  autoFocus = false,
  composerVoice,
  spokenTurnRef,
  stopSpeaking,
}: ViewProps & {
  run: RunChatHandle
  composerVoice?: ChatInputVoice
  spokenTurnRef?: MutableRefObject<((text: string) => Promise<boolean>) | null>
  stopSpeaking?: () => void
}) {
  const { messages, setMessages, status, stop, transport } = run
  const runId = run.runId
  const sendMessage = run.sendWith

  const streaming = status === 'streaming' || status === 'submitted'

  // Replayed final questions (picker toolCallId → payload). These are answered via
  // sendMessage (there is no live stream to resume), unlike LIVE questions which go
  // through transport.answerPermission. The store seeds them on replay.
  const replayPendingRef = useRef<Map<string, RunChatQuestionPayload>>(run.pendingQuestions)
  replayPendingRef.current = run.pendingQuestions

  const replaying = run.loading
  const [error, setError] = useState<string | null>(null)
  // What's typed and not sent: the bubble's drafts, so a window closed mid-sentence loses nothing.
  const draftKey = `run:${runId}`
  const [input, setInput] = useState(() => teammateDraft(draftKey))
  useEffect(() => setTeammateDraft(draftKey, input), [draftKey, input])
  // Locally-dismissed question parts (X'd or already answered this session) — a
  // belt so a still-input-available part doesn't re-open the picker after submit.
  const [answeredIds, setAnsweredIds] = useState<Set<string>>(new Set())

  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to the newest content as it grows.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, replaying])

  // The latest UNANSWERED clarifying question — the exact pendingQuestion scan the
  // main chat uses (chat-panel.tsx): the last assistant `ask_user` tool part still
  // in a non-terminal state, with questions. Rendered inline above the composer.
  const pendingQuestion = useMemo<{ toolCallId: string; questions: AgentQuestion[] } | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      for (const part of m.parts) {
        if (!isToolUIPart(part)) continue
        const name = 'toolName' in part ? part.toolName : part.type.replace(/^tool-/, '')
        if (name !== 'ask_user') continue
        if (part.state === 'output-available' || part.state === 'output-error') continue
        if (answeredIds.has(part.toolCallId)) continue
        const questions = (part.input as PickerQuestionInput | undefined)?.questions
        if (Array.isArray(questions) && questions.length > 0) {
          return { toolCallId: part.toolCallId, questions }
        }
      }
    }
    return null
  }, [messages, answeredIds])

  // Locally flip a question part to output-available so the picker unmounts the
  // instant the user acts (the transport may not echo a result for a replayed
  // answer, and the main-chat convention is an immediate local flip).
  const flipAnswered = useCallback(
    (toolCallId: string, output: Record<string, unknown>) => {
      setAnsweredIds((prev) => {
        if (prev.has(toolCallId)) return prev
        const next = new Set(prev)
        next.add(toolCallId)
        return next
      })
      setMessages((prev) =>
        prev.map((m) => {
          if (m.role !== 'assistant') return m
          let changed = false
          const parts = m.parts.map((p) => {
            if (isToolUIPart(p) && p.toolCallId === toolCallId && p.state !== 'output-available') {
              changed = true
              return { ...p, state: 'output-available', output } as unknown as typeof p
            }
            return p
          })
          return changed ? { ...m, parts } : m
        }),
      )
    },
    [setMessages],
  )

  // Answer (or skip) the pending clarifying question. Routes by origin: a REPLAYED
  // final question (in replayPendingRef) answers via sendMessage + inputResponses;
  // a LIVE question answers via transport.answerPermission over its open stream.
  const answerQuestion = useCallback(
    (toolCallId: string, answers: Record<string, string>, skip: boolean) => {
      setError(null)
      const replayed = replayPendingRef.current.get(toolCallId)
      const output = skip ? { response: '(skipped)' } : { answers }
      flipAnswered(toolCallId, output)

      if (replayed) {
        replayPendingRef.current.delete(toolCallId)
        const message = skip
          ? 'The user skipped this question.'
          : formatAnswers(replayed, answers)
        const optionId = skip ? replayed.denyOptionId : replayed.approveOptionId
        void sendMessage(
          { text: message },
          { body: { inputResponses: [{ requestId: replayed.requestId, optionId }] } },
        )
        return
      }

      // LIVE question: answer over the open turn stream.
      const t = transport as unknown as {
        answerPermission?: (
          chatId: string,
          toolCallId: string,
          answers: Record<string, string>,
          response?: string,
        ) => Promise<void>
      }
      void t.answerPermission?.(
        `run-${runId}`,
        toolCallId,
        skip ? {} : answers,
        skip ? '(skipped)' : undefined,
      )
    },
    [runId, transport, sendMessage, flipAnswered],
  )

  // One turn from the composer, with what it added: waits for the replay, so
  // the turn lands after the history, then goes to the run's parked session.
  const runSend = run.sendMessage
  const handleSend = useCallback(
    (text: string, extras: ComposerTurnExtras) => {
      setError(null)
      return runSend(text, { turn: extras })
    },
    [runSend],
  )
  const handleStop = useCallback(() => {
    stopSpeaking?.()
    void stop()
  }, [stop, stopSpeaking])

  const unavailable = useMemo<ChatInputUnavailable>(
    () => ({
      agent: { label: agentName || 'Agent', reason: runChatAgentReason(agentName) },
      photos: { reason: CHAT_PHOTOS_REASON },
    }),
    [agentName],
  )

  const isEmpty = messages.length === 0 && !replaying

  return (
    // h-full is load-bearing: the mount wrapper is a plain (non-flex) box, so
    // without it this column sizes to its CONTENT — the transcript grows past
    // the viewport and pushes the composer off-screen instead of scrolling.
    <div className="flex h-full min-h-0 flex-col gap-3" data-run-chat={runId}>
      <div
        ref={scrollRef}
        role="log"
        aria-label="Conversation with the run agent"
        aria-live="polite"
        aria-busy={streaming}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
      >
        {replaying ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
        ) : run.refusal && isEmpty ? (
          // The route said no: only the person who started the run continues its chat.
          <p data-run-chat-refused={run.refusal.status} className="py-6 text-center text-sm text-muted-foreground">
            {run.refusal.status === 403
              ? 'Only the person who started this run can continue its chat.'
              : 'This run has no chat to continue.'}
          </p>
        ) : isEmpty ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Ask the agent about this run — it remembers everything it did.
          </p>
        ) : (
          messages.map((m, i) => (
            <ChatMessage
              key={m.id}
              message={m}
              userAvatarUrl={userAvatarUrl}
              userInitials={userInitials}
              // The reply still arriving: no section play buttons on it yet.
              streaming={streaming && i === messages.length - 1 && m.role === 'assistant'}
            />
          ))
        )}
        {/* Thinking orb while a turn is submitted but hasn't started streaming —
            same indicator the main chat shows (chat-panel.tsx). */}
        {status === 'submitted' &&
          messages.length > 0 &&
          messages[messages.length - 1].role === 'user' && (
            <div className="flex items-center gap-3 px-1">
              <Loader variant="orb" orbState="working" size="lg" />
            </div>
          )}
      </div>

      {/* Inline clarifying-question picker (bare, like RunQuestionSection) — sits
          just above the composer while a question is unanswered. */}
      {pendingQuestion && (
        <div className="rounded-xl border border-border/60 bg-card/40 p-3">
          <QuestionPicker
            questions={toAgentQuestions(pendingQuestion.questions)}
            onSubmit={(answers) => answerQuestion(pendingQuestion.toolCallId, answers, false)}
            onSkip={() => answerQuestion(pendingQuestion.toolCallId, {}, true)}
            disabled={streaming}
            bare
          />
        </div>
      )}

      {(error || run.error) && (
        <div role="alert" className="text-xs text-destructive">
          {error ?? run.error?.message}
        </div>
      )}

      {/* The main chat's composer (ChatInput, via ConversationComposer). None
          for a run whose chat the route refused. */}
      {!run.refusal && (
        <div data-run-chat-composer="" className="shrink-0">
          <ConversationComposer
            value={input}
            onChange={setInput}
            onSend={handleSend}
            onStop={handleStop}
            isLoading={streaming}
            placeholder={messages.length > 0 ? 'Ask about this run…' : 'Ask about this run — @ to mention'}
            hasMessages={messages.length > 0}
            autoFocus={autoFocus}
            voice={composerVoice}
            unavailable={unavailable}
            workspaceId={workspaceId}
            spokenTurnRef={spokenTurnRef}
          />
        </div>
      )}
    </div>
  )
}
