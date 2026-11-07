'use client'

/**
 * The live agent's HUD in its own window: the desktop's detached `agent-hud`
 * window (commands/hud.rs show_agent_hud, 472×536, always on top), up for the
 * whole of a live capture (hooks/use-agent-nudge-relay.ts). It renders the
 * HUD's one view (components/live-hud/agent-hud-view.tsx) — the same one the
 * web shows as a floating panel — fed from the window recording the call:
 *   - Voice ID's state and the transcript's tail (lib/live-agent/voice-id-hud.ts,
 *     transcript-hud.ts), asked for once it listens (READY_EVENT); of the tail
 *     only who spoke last is kept, for the participants row;
 *   - the agent's say_to_user nudges (`agent-nudge`, relayed by Rust, which
 *     buffers them until `agent_hud_ready`), shown as the agent's messages
 *     unless the conversation already holds them;
 *   - the call's conversation and agent (lib/live-agent/live-hud.ts), which the
 *     chat talks in. Its own eve session, from this window: the Supabase
 *     browser client reads the session from the cookies this window shares
 *     with the app (not yet confirmed in a live desktop run), and
 *     workspace-fetch (patched on import) adds the Bearer to `/api/` and the
 *     workspace to `/api/` and `/eve/`;
 *   - the recording's state for the header's controls (elapsed, pause /
 *     resume, stop, back to the capture: lib/live-agent/hud-recording.ts),
 *     sent on each change; their clicks go back as HUD_RECORDING_ACTION_EVENT
 *     for the recording window to run;
 *   - the meeting's scheduled time for the header's time fill
 *     (lib/live-agent/hud-schedule.ts), sent when known and on each change;
 *   - the person's pre-call brief for the Briefing line
 *     (lib/live-agent/hud-brief.ts), likewise;
 *   - the goal line's saves go to the recording window as
 *     HUD_GOAL_ACTION_EVENT, which writes the goal and answers with
 *     HUD_GOAL_RESULT_EVENT (lib/live-agent/hud-goal.ts); no answer within
 *     the cap puts the old goal back;
 *   - the screen-share eye in the header's left (HudShareEye): whether this
 *     window shows in screen shares and recordings, through the desktop's own
 *     commands; hidden on a desktop build without them;
 *   - Voice ID clicks go back as ACTION_EVENT, and before each send the chat
 *     asks the recording window to push the transcript (LIVE_HUD_FLUSH_EVENT,
 *     answered by LIVE_HUD_FLUSHED_EVENT), never waiting past the chat's cap;
 *   - the call's audio level for the chat box's glow: the native capture's
 *     `audio-level` event, which Rust broadcasts to every window (~10 Hz), so
 *     this window hears it directly (useWindowAudioLevels), subscribed only
 *     while the glow is listening (the call live, the window showing);
 *   - a spoken ask during the call (LIVE_HUD_ASK_EVENT, from the main window)
 *     is sent from this window's chat, so its store alone owns the call's
 *     eve session; LIVE_HUD_ASKED_EVENT tells the main window how it went;
 *   - files dropped on the window attach to the call's capture (HudFileDrop).
 *
 * The window is transparent: everything paints inside the card. It moves by
 * dragging anywhere that isn't a control (useDragAnywhere). Theme follows the
 * app's, live (useHudTheme).
 */
import { useHudTheme } from '@/lib/hud-theme'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Paperclip } from 'lucide-react'
import { cn } from '@/lib/utils'
import { uploadAttachments } from '@/lib/attachments/upload-client'
import { dragHasFiles, filesFromTransfer } from '@/lib/attachments/dropped-files'
import { tauriBridge } from '@/lib/tauri-bridge'
import { AgentHudView } from '@/components/live-hud/agent-hud-view'
import { EMPTY_HUD_FEED, lastSpeakerOf, withNudge, type AgentHudFeed, type AgentHudNudge } from '@/components/live-hud/hud-feed'
import { createAttachedLevels, readAudioLevelPayload, type HudAudioLevels } from '@/components/live-hud/hud-audio-levels'
import { BEFORE_SEND_CAP_MS, sendToLiveChat } from '@/components/live-chat/use-live-chat'
import { TRANSCRIPT_HUD_EVENT, readTranscriptHudTail } from '@/lib/live-agent/transcript-hud'
import { listenScoped, safeUnlisten, unlistenEach, type UnlistenLike } from '@/lib/tauri-unlisten'
import { setClientWorkspaceId } from '@/lib/workspace-fetch'
import { registerReloadBlocker } from '@/lib/deploy-reload'
import {
  VOICE_ID_HUD_ACTION_EVENT,
  VOICE_ID_HUD_READY_EVENT,
  VOICE_ID_HUD_STATE_EVENT,
  type VoiceIdHudAction,
  type VoiceIdHudState,
} from '@/lib/live-agent/voice-id-hud'
import {
  LIVE_HUD_ASKED_EVENT,
  LIVE_HUD_ASK_EVENT,
  LIVE_HUD_CONVERSATION_EVENT,
  LIVE_HUD_FLUSHED_EVENT,
  LIVE_HUD_FLUSH_EVENT,
  readLiveHudAsk,
  readLiveHudConversation,
  readLiveHudFlushed,
  type LiveHudAsked,
  type LiveHudConversation,
} from '@/lib/live-agent/live-hud'
import {
  HUD_RECORDING_ACTION_EVENT,
  HUD_RECORDING_STATE_EVENT,
  readHudRecordingState,
  sameHudRecording,
  type HudRecordingAction,
  type HudRecordingState,
} from '@/lib/live-agent/hud-recording'
import { HUD_SCHEDULE_EVENT, readHudSchedule, sameHudSchedule, type HudSchedule } from '@/lib/live-agent/hud-schedule'
import { HUD_BRIEF_EVENT, readHudBrief, sameHudBrief, type HudBrief } from '@/lib/live-agent/hud-brief'
import { HUD_GOAL_ACK_CAP_MS, HUD_GOAL_ACTION_EVENT, HUD_GOAL_RESULT_EVENT, hudGoalAction, readHudGoalResult } from '@/lib/live-agent/hud-goal'
import { HudShareEye } from '@/components/live-hud/hud-share-eye'
import { useHudTelemetry } from '@/components/live-hud/use-hud-telemetry'
import { tauriCore, tauriEvent, tauriWindow } from './tauri-api'

export function AgentHud() {
  useHudTheme()
  useDragAnywhere()
  const { feed, captureId } = useWindowFeed()
  // What this HUD saw, for PostHog: loaded, shown / hidden, each nudge arrived and drawn.
  const onSayShown = useHudTelemetry({
    host: 'window',
    captureId,
    workspaceId: feed.conversation?.workspaceId ?? feed.voiceId?.workspaceId ?? null,
    nudges: feed.nudges,
    hasConversation: !!feed.conversation,
    windowVisible: hudWindowVisible,
  })
  const captureRef = useRef(captureId)
  captureRef.current = captureId
  // New deploy → reload when idle (lib/deploy-reload.ts): never during a
  // meeting, whose nudges and replies live only in this window.
  useEffect(() => registerReloadBlocker(() => !!captureRef.current), [])

  const sendVoiceIdAction = useCallback((action: VoiceIdHudAction) => {
    void tauriEvent()
      .then(({ emit }) => emit(VOICE_ID_HUD_ACTION_EVENT, action))
      .catch(() => {})
  }, [])
  const sendRecordingAction = useCallback((action: HudRecordingAction) => {
    void tauriEvent()
      .then(({ emit }) => emit(HUD_RECORDING_ACTION_EVENT, action))
      .catch(() => {})
  }, [])
  const beforeSend = useCallback(() => flushRecordingWindow(captureRef.current), [])
  // The goal line's saves: written by the recording window, for the call's capture.
  const callCaptureId = feed.recording?.captureId ?? captureId
  const goalCapture = useRef<string | null>(null)
  goalCapture.current = callCaptureId
  const saveGoal = useCallback((goal: string) => requestHudGoal(goalCapture.current, goal), [])
  const actions = useMemo(
    () => ({ sendVoiceIdAction, beforeSend, sendRecordingAction, saveGoal, onSayShown }),
    [sendVoiceIdAction, beforeSend, sendRecordingAction, saveGoal, onSayShown],
  )
  useSpokenAsks(feed.conversation, beforeSend)
  const audioLevels = useWindowAudioLevels()
  const shareEye = useMemo(() => <HudShareEye />, [])

  return (
    <>
      <AgentHudView host="window" feed={feed} actions={actions} audioLevels={audioLevels} headerStart={shareEye} />
      <HudFileDrop captureId={callCaptureId} />
    </>
  )
}

/**
 * Files dropped on the HUD (a screenshot during the call) attach to the
 * call's capture, wherever on it they land, its chat box too: that box talks
 * to the live agent, and only the app's own chat box sends files to a chat.
 * Uploaded from this window, on its own session; then the app's windows hear
 * that the capture's attachments changed. The desktop's drop handler is off
 * for this window (commands/hud.rs), so the page gets the files themselves.
 */
export function HudFileDrop({ captureId }: { captureId: string | null }) {
  const captureRef = useRef(captureId)
  captureRef.current = captureId
  const [dragging, setDragging] = useState(false)
  const [note, setNote] = useState<{ text: string; tone: 'busy' | 'done' | 'error' } | null>(null)

  useEffect(() => {
    let depth = 0
    let clear: ReturnType<typeof setTimeout> | undefined
    const say = (text: string, tone: 'busy' | 'done' | 'error') => {
      clearTimeout(clear)
      setNote({ text, tone })
      if (tone !== 'busy') clear = setTimeout(() => setNote(null), tone === 'error' ? 6000 : 3000)
    }
    const onEnter = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      depth++
      if (captureRef.current) setDragging(true)
    }
    // Always taken, with or without a call: a file dropped on a page the
    // WebView doesn't stop would replace the HUD with the file.
    const onOver = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      if (captureRef.current && e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const captureId = captureRef.current
      const files = filesFromTransfer(e.dataTransfer)
      if (!captureId || files.length === 0) return
      const one = files.length === 1 ? files[0].name : null
      say(one ? `Attaching ${one}…` : `Attaching ${files.length} files…`, 'busy')
      void uploadAttachments(files, { noteId: captureId }).then(({ uploaded, firstError }) => {
        if (uploaded > 0) void tauriBridge.captureAttachments.announce(captureId)
        if (uploaded === 0) say(firstError ?? 'Upload failed. Please try again.', 'error')
        else if (firstError) say(firstError, 'error')
        else say(`Attached ${one ?? `${uploaded} files`} to the capture`, 'done')
      })
    }
    document.addEventListener('dragenter', onEnter)
    document.addEventListener('dragover', onOver)
    document.addEventListener('dragleave', onLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      clearTimeout(clear)
      document.removeEventListener('dragenter', onEnter)
      document.removeEventListener('dragover', onOver)
      document.removeEventListener('dragleave', onLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [])

  return (
    <>
      {dragging && (
        <div
          data-hud-file-drop=""
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center rounded-[28px] border-2 border-dashed border-primary/50 bg-primary/10"
        >
          <div className="flex items-center gap-2 rounded-full bg-background/90 px-3.5 py-1.5 text-[13px] font-medium text-primary/80">
            <Paperclip className="h-3.5 w-3.5" />
            Drop to attach to the capture
          </div>
        </div>
      )}
      {note && !dragging && (
        <div data-hud-file-note={note.tone} className="pointer-events-none fixed inset-x-0 top-[56px] z-50 flex justify-center px-4">
          <div
            className={cn(
              'max-w-full truncate rounded-full bg-background/90 px-3 py-1 text-[12px] font-medium shadow-sm',
              note.tone === 'error' ? 'text-destructive' : 'text-foreground/80',
            )}
          >
            {note.text}
          </div>
        </div>
      )}
    </>
  )
}

/** Whether this window is showing: the desktop's own state (a hidden window's page still draws). */
export async function hudWindowVisible(): Promise<boolean | null> {
  const { getCurrentWebviewWindow } = await tauriWindow()
  return getCurrentWebviewWindow().isVisible()
}

/** The native capture's `audio-level` event (src-tauri audio/session.rs, ~10 Hz, to every window). */
export const AUDIO_LEVEL_EVENT = 'audio-level'

/**
 * The call's audio level in this window: the native capture's broadcast,
 * heard directly. Listens only while the glow subscribes (createAttachedLevels:
 * attached on the first subscriber, unlistened with the last).
 */
export function useWindowAudioLevels(): HudAudioLevels {
  const [levels] = useState(() =>
    createAttachedLevels((push) =>
      listenScoped(async (gate) => {
        const { listen } = await tauriEvent()
        return listen(
          AUDIO_LEVEL_EVENT,
          gate((e: { payload: unknown }) => {
            const p = readAudioLevelPayload(e.payload)
            if (p) push(p)
          }),
        )
      }),
    ),
  )
  return levels
}

/**
 * Spoken asks from the main window (lib/live-agent/hud-ask-client.ts): each
 * for this call's conversation goes out through this window's live chat store
 * (the one the chat on screen shows), and the main window hears `accepted`,
 * then `done` or `failed`. One for another conversation (or before this
 * window knows the call's) is `failed` at once.
 */
export function useSpokenAsks(conversation: LiveHudConversation | null, beforeSend: () => Promise<void>): void {
  const conversationRef = useRef(conversation)
  conversationRef.current = conversation
  const beforeSendRef = useRef(beforeSend)
  beforeSendRef.current = beforeSend
  useEffect(
    () =>
      listenScoped(async (gate) => {
        const [{ getCurrentWebviewWindow }, { emit }] = await Promise.all([tauriWindow(), tauriEvent()])
        const tell = (detail: LiveHudAsked) => emit(LIVE_HUD_ASKED_EVENT, detail).catch(() => {})
        return getCurrentWebviewWindow().listen(
          LIVE_HUD_ASK_EVENT,
          gate((e: { payload: unknown }) => {
            const ask = readLiveHudAsk(e.payload)
            if (!ask) return
            const target = conversationRef.current
            if (!target || target.conversationId !== ask.conversationId || target.captureId !== ask.captureId) {
              void tell({ id: ask.id, state: 'failed' })
              return
            }
            void tell({ id: ask.id, state: 'accepted' })
            void sendToLiveChat(target, ask.text, () => beforeSendRef.current()).then(
              (sent) => tell({ id: ask.id, state: sent ? 'done' : 'failed' }),
              () => tell({ id: ask.id, state: 'failed' }),
            )
          }),
        )
      }),
    [],
  )
}

/**
 * Ask the window recording `captureId` to push its transcript to the server,
 * and wait for it to say it has — at most BEFORE_SEND_CAP_MS (the chat stops
 * waiting then too; this only stops listening).
 */
export async function flushRecordingWindow(captureId: string | null): Promise<void> {
  if (!captureId) return
  const id = newId()
  const [{ getCurrentWebviewWindow }, { emit }] = await Promise.all([tauriWindow(), tauriEvent()])
  let off: UnlistenLike | null = null
  let settle: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  const timer = setTimeout(settle, BEFORE_SEND_CAP_MS)
  try {
    off = await getCurrentWebviewWindow().listen(LIVE_HUD_FLUSHED_EVENT, (e: { payload: unknown }) => {
      if (readLiveHudFlushed(e.payload) === id) settle()
    })
    await emit(LIVE_HUD_FLUSH_EVENT, { captureId, id })
    await done
  } catch {
    /* no recording window to ask: the turn reads the last saved transcript */
  } finally {
    clearTimeout(timer)
    safeUnlisten(off)
  }
}

/**
 * Ask the window recording `captureId` to save the call's goal ('' clears it)
 * and wait for its answer: true once it says the goal is saved; false when it
 * says it isn't, or doesn't answer within HUD_GOAL_ACK_CAP_MS.
 */
export async function requestHudGoal(captureId: string | null, goal: string): Promise<boolean> {
  if (!captureId) return false
  const action = hudGoalAction(captureId, newId(), goal)
  if (!action) return false
  let off: UnlistenLike | null = null
  let settle: (ok: boolean) => void = () => {}
  const done = new Promise<boolean>((resolve) => {
    settle = resolve
  })
  const timer = setTimeout(() => settle(false), HUD_GOAL_ACK_CAP_MS)
  try {
    const [{ getCurrentWebviewWindow }, { emit }] = await Promise.all([tauriWindow(), tauriEvent()])
    off = await getCurrentWebviewWindow().listen(HUD_GOAL_RESULT_EVENT, (e: { payload: unknown }) => {
      const result = readHudGoalResult(e.payload)
      if (result?.id === action.id) settle(result.ok)
    })
    await emit(HUD_GOAL_ACTION_EVENT, action)
    return await done
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    safeUnlisten(off)
  }
}

/**
 * What the recording window sends, as the view's feed. Asks for Voice ID and
 * the transcript once listening, tells Rust it's ready for the nudges it
 * buffered, and points this window's requests at the recording window's
 * workspace (in memory only: never written to the storage it shares with the
 * app).
 */
function useWindowFeed(): { feed: AgentHudFeed; captureId: string | null } {
  const [voiceId, setVoiceId] = useState<VoiceIdHudState | null>(null)
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null)
  const [nudges, setNudges] = useState<readonly AgentHudNudge[]>(EMPTY_HUD_FEED.nudges)
  const [conversation, setConversation] = useState<LiveHudConversation | null>(null)
  const [recording, setRecording] = useState<HudRecordingState | null>(null)
  const [schedule, setSchedule] = useState<HudSchedule | null>(null)
  const [brief, setBrief] = useState<HudBrief | null>(null)

  useEffect(
    () =>
      listenScoped(async (gate) => {
        const [{ getCurrentWebviewWindow }, { emit }] = await Promise.all([tauriWindow(), tauriEvent()])
        const win = getCurrentWebviewWindow()
        const offs = await Promise.allSettled([
          win.listen<VoiceIdHudState>(
            VOICE_ID_HUD_STATE_EVENT,
            gate((e: { payload: VoiceIdHudState }) => setVoiceId(e.payload)),
          ),
          win.listen(
            TRANSCRIPT_HUD_EVENT,
            gate((e: { payload: unknown }) => {
              const tail = readTranscriptHudTail(e.payload)
              // Only who spoke last: the same name sets nothing, so a tail
              // every 120 ms while someone talks renders nothing new.
              if (tail) setLastSpeaker(lastSpeakerOf(tail.lines))
            }),
          ),
          win.listen(
            HUD_RECORDING_STATE_EVENT,
            gate((e: { payload: unknown }) => {
              const next = readHudRecordingState(e.payload)
              setRecording((prev) => (sameHudRecording(prev, next) ? prev : next))
            }),
          ),
          win.listen(
            HUD_SCHEDULE_EVENT,
            gate((e: { payload: unknown }) => {
              const next = readHudSchedule(e.payload)
              setSchedule((prev) => (sameHudSchedule(prev, next) ? prev : next))
            }),
          ),
          win.listen(
            HUD_BRIEF_EVENT,
            gate((e: { payload: unknown }) => {
              const next = readHudBrief(e.payload)
              setBrief((prev) => (sameHudBrief(prev, next) ? prev : next))
            }),
          ),
          win.listen(
            LIVE_HUD_CONVERSATION_EVENT,
            gate((e: { payload: unknown }) => {
              const next = readLiveHudConversation(e.payload)
              if (next) setConversation((prev) => (sameConversation(prev, next) ? prev : next))
            }),
          ),
        ])
        // Listening now: ask the recording window for everything.
        gate(() => emit(VOICE_ID_HUD_READY_EVENT).catch(() => {}))()
        return unlistenEach(offs)
      }),
    [],
  )

  useEffect(
    () =>
      listenScoped(async (gate) => {
        const [{ listen }, { invoke }] = await Promise.all([tauriEvent(), tauriCore()])
        const off = await listen<AgentHudNudge>(
          'agent-nudge',
          gate((e: { payload: AgentHudNudge }) => setNudges((prev) => withNudge(prev, e.payload))),
        )
        // Subscribed: Rust flushes the nudges it buffered before this page was
        // up (an early say_to_user in the first second of a meeting).
        gate(() => invoke('agent_hud_ready').catch(() => {}))()
        return off
      }),
    [],
  )

  const captureId = voiceId?.captureId ?? conversation?.captureId ?? null
  // A conversation for another capture than the one Voice ID is on is stale.
  const current = conversation && (!voiceId || conversation.captureId === voiceId.captureId) ? conversation : null
  const workspaceId = current?.workspaceId ?? voiceId?.workspaceId ?? null
  useEffect(() => {
    if (workspaceId) setClientWorkspaceId(workspaceId, { persist: false })
  }, [workspaceId])

  const feedConversation = useMemo(
    () => (current ? { ...current, workspaceId } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current?.captureId, current?.conversationId, current?.agentId, workspaceId],
  )
  // Likewise a schedule for another capture.
  const feedSchedule = schedule && (!captureId || schedule.captureId === captureId) ? schedule : null
  // And a brief for another capture.
  const feedBrief = brief && (!captureId || brief.captureId === captureId) ? brief : null
  const feed = useMemo<AgentHudFeed>(
    () => ({ voiceId, lastSpeaker, nudges, conversation: feedConversation, recording, schedule: feedSchedule, brief: feedBrief }),
    [voiceId, lastSpeaker, nudges, feedConversation, recording, feedSchedule, feedBrief],
  )
  return { feed, captureId }
}

function sameConversation(a: LiveHudConversation | null, b: LiveHudConversation): boolean {
  return !!a && a.captureId === b.captureId && a.conversationId === b.conversationId && a.agentId === b.agentId && a.workspaceId === b.workspaceId
}

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `flush-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

/** What a press on starts or uses rather than moving the window. */
const CONTROLS =
  'button, a, input, textarea, select, label, [role="button"], [role="tab"], [role="option"], [role="menuitem"], [data-scrolls], [contenteditable="true"], [data-radix-popper-content-wrapper]'

/**
 * Drag the window from anywhere that isn't a control — the name tag's empty
 * room, the gaps between chips, the collapsed chat. (Tauri's own
 * `data-tauri-drag-region` only answers a press on the very element that
 * carries it, never its children.) The expanded chat isn't a handle: it
 * scrolls (`data-scrolls`). A single press only: no double-click maximise.
 */
function useDragAnywhere() {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.detail !== 1) return
      const target = e.target as Element | null
      if (!target?.closest || target.closest(CONTROLS)) return
      e.preventDefault()
      void tauriWindow()
        .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().startDragging())
        .catch(() => {})
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])
}

// ── Theme: useHudTheme (@/lib/hud-theme), shared with the dictation panel.
