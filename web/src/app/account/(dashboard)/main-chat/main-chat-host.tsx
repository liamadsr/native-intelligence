'use client'

/**
 * The main chat's panel host (docs/plans/one-chat.md, Slice 1): ONE ChatPanel,
 * on the person's home thread in the workspace on screen. No tabs, no boot
 * rules about which chat holds what: the panel mounts straight on the chat the
 * device kept (main-chat-context.tsx), and the host puts it back on the home
 * thread when it isn't there:
 *
 *   - at boot, once the home thread's id is known (fetchHomeThreadId), when the
 *     chat it mounted on is another conversation (or none), and only while
 *     nothing has happened in it since it mounted;
 *   - on demand: openHomeThread / handOffToHome and a spoken ask, which then
 *     send there (ChatPanelHandle.sendFromSurface / askByVoice).
 *
 * The window events every surface fires at "the chat" (a proposal, Mail's
 * Reply, Scout, Find email, the editor selection) all
 * reach this one panel, and the cards asked for from anywhere are delivered
 * to it.
 *
 * A call (one-chat Slice 3) never takes the panel over: starting a capture
 * puts its card in the chat (it docks beside it, with the capture's
 * controls), and the call's live agent talks in its own chat, in the HUD
 * (components/live-hud: the web's floating panel, or the desktop's window).
 * Meanwhile the main agent stays the person's: each turn says a call is on
 * (systemContext.onCallCaptureId, one line in its prompt), and a spoken ask
 * goes to the live agent (chat/route-voice-ask.ts). Typed words here always
 * go to the main agent.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMainChat, useCardDeliveries, useRegisterChatFlush } from './main-chat-context'
import { HOME_HANDOFF_REASONS, OPEN_HOME_THREAD_EVENT, fetchHomeThreadId, forgetHomeThreadId, parseOpenHomeThreadDetail } from '@/lib/chat/home-thread-client'
import { HOME_MESSAGE_EVENT, parseHomeMessageDetail } from '@/lib/chat/home-message'
import { useHomeThread } from '@/hooks/use-home-thread'
import { cardForTarget, foldRecordCards } from '@/lib/chat-cards/open-card'
import { LiveCaptureDockLayout } from '../chat/live-capture-dock'
import { useActiveLiveCapture } from '../chat/use-live-capture-dock'
import { ChatPanel, type ChatPanelHandle, type EditorSelection } from '../chat/chat-panel'
import { FloatingChat } from '../chat/floating-chat'
import { useWorkspaceId } from '../../workspace-switcher'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { useHomeConversationAdoption } from '../use-home-conversation-adoption'
import {
  FIND_CONTACT_EMAIL_EVENT,
  PROSPECTING_ASK_EVENT,
  PROSPECTING_START_EVENT,
  type FindContactEmailContext,
  type ProspectingAskDetail,
  type ProspectingStartDetail,
} from '../prospecting/start-event'
import { EMAIL_REPLY_EVENT, parseEmailReplyRequest } from '@/lib/email/reply-in-chat'
import { CARD_REPLY_EVENT, parseCardReplyRef } from '@/lib/chat/card-reply'
import { VOICE_ASK_EVENT, isVoiceAskDelivery } from '@/lib/voice/voice-ask-delivery'
import { routeVoiceAskHome, type LiveVoiceAskTarget } from '../chat/route-voice-ask'
import { announcedLiveConversation } from '@/lib/live-agent/live-hud'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { isDesktopApp } from '@/lib/platform'
import { askHudWindow } from '@/lib/live-agent/hud-ask-client'
import { useAssistantName } from '@/lib/voice/assistant-name-store'
import { VOICE_BIRD_EVENT, parseVoiceBirdDetail } from '@/components/birds/voice-bird'
import { reportVoiceRefusal } from '../chat/voice-controls'
import type { ChatSlice } from './types'

/**
 * Registers how a recording's capture opens with RecordingProvider: as a card
 * in the main chat, which docks it. Discarded, or its start failed: its card
 * is put away. Uses the optional recording hook, so a transient unmount of the
 * parent AccountProviders doesn't throw.
 */
export function RecordingNavigateBridge() {
  const recording = useOptionalRecordingStable()
  const deliver = useCardDeliveries()?.deliver
  useEffect(() => {
    if (!recording || !deliver) return
    recording.registerNavigate(
      (capture, options) => {
        if (options?.discardedCaptureId) {
          foldRecordCards({ type: 'capture', id: options.discardedCaptureId })
          return
        }
        if (!capture) return
        const card = cardForTarget({ type: 'capture', id: capture.captureId, title: capture.title })
        if (card) deliver({ spec: card.spec, from: 'capture' })
      },
      // Undo the optimistic capture-start open (mic/create failure).
      (captureId) => foldRecordCards({ type: 'capture', id: captureId }),
    )
    return () => recording.unregisterNavigate()
  }, [recording, deliver])
  return null
}

/** How many times a home load that a send or a running reply interrupted is tried again. */
const HOME_LOAD_ATTEMPTS = 3

/** The most a card asked for at boot waits on the home thread's load (ms). */
const BOOT_CARD_WAIT_MS = 4000

/**
 * The main chat's one panel. Memoized: both props are primitives owned by the
 * shell, and this subtree is far too heavy to re-render for a parent's layout.
 */
export const MainChatHost = memo(function MainChatHost({
  userAvatarUrl,
  userInitials,
}: {
  userAvatarUrl: string | null
  userInitials: string
}) {
  const { chat, chatWorkspaceId, hydrated } = useMainChat()
  const workspaceId = useWorkspaceId()
  const recording = useOptionalRecordingStable()
  const isRecording = recording?.isRecording ?? false
  const flushTranscriptForAgent = recording?.flushTranscriptForAgent
  const homeThreadId = useHomeThread(chatWorkspaceId)
  const activeCapture = useActiveLiveCapture()
  const activeCaptureId = activeCapture?.captureId ?? null

  // Latest values for the stable handlers below.
  const chatRef = useRef(chat)
  chatRef.current = chat
  const chatWorkspaceRef = useRef(chatWorkspaceId)
  chatWorkspaceRef.current = chatWorkspaceId
  const activeCaptureRef = useRef(activeCaptureId)
  activeCaptureRef.current = activeCaptureId
  const flushRef = useRef(flushTranscriptForAgent)
  flushRef.current = flushTranscriptForAgent

  /**
   * The call going on, as its live agent's chat talks to it: the capture,
   * its conversation (as the recording context announced it,
   * lib/live-agent/live-hud.ts) and its agent. Null with no call, or before
   * its conversation is open: a spoken ask then goes home. On desktop the ask
   * is sent from the HUD window's chat, whose store owns the call's session.
   */
  const liveCallNow = useCallback((): LiveVoiceAskTarget | null => {
    const captureId = activeCaptureRef.current
    const announced = announcedLiveConversation(captureId)
    if (!captureId || !announced) return null
    if (isDesktopApp()) {
      const { conversationId } = announced
      return {
        ...announced,
        workspaceId: getClientWorkspaceId(),
        // The HUD flushes the transcript through this window before its send.
        send: (text: string) => askHudWindow({ captureId, conversationId, text }),
      }
    }
    return {
      ...announced,
      workspaceId: getClientWorkspaceId(),
      beforeSend: async () => {
        await flushRef.current?.(captureId)
      },
    }
  }, [])

  // ── The panel ───────────────────────────────────────────────────────────
  // Its handle, with the session it was mounted for, and who waits for it.
  const panelRef = useRef<{ sessionId: string; handle: ChatPanelHandle } | null>(null)
  const waitersRef = useRef<Array<{ sessionId: string; resolve: (h: ChatPanelHandle | null) => void }>>([])
  const registerPanel = useCallback((sessionId: string, handle: ChatPanelHandle | null) => {
    if (handle) {
      panelRef.current = { sessionId, handle }
      const ready = waitersRef.current.filter((w) => w.sessionId === sessionId)
      waitersRef.current = waitersRef.current.filter((w) => w.sessionId !== sessionId)
      // After the commit that mounted it, not inside it.
      if (ready.length) queueMicrotask(() => ready.forEach((w) => w.resolve(handle)))
    } else if (panelRef.current?.sessionId === sessionId) {
      panelRef.current = null
    }
  }, [])
  // A chat that went (a workspace switch, a reset): what waited for its panel hears null.
  useEffect(() => {
    const stale = waitersRef.current.filter((w) => w.sessionId !== chat.chatSessionId)
    waitersRef.current = waitersRef.current.filter((w) => w.sessionId === chat.chatSessionId)
    for (const w of stale) w.resolve(null)
  }, [chat.chatSessionId])
  /** The chat's panel now, when it is mounted. */
  const panelNow = useCallback((): ChatPanelHandle | null => {
    const current = panelRef.current
    return current && current.sessionId === chatRef.current.chatSessionId ? current.handle : null
  }, [])
  /** The panel of chat `sessionId` (the chat now by default), once mounted; null if that chat goes first. */
  const whenPanel = useCallback((sessionId: string = chatRef.current.chatSessionId): Promise<ChatPanelHandle | null> => {
    if (sessionId !== chatRef.current.chatSessionId) return Promise.resolve(null)
    const current = panelRef.current
    if (current?.sessionId === sessionId) return Promise.resolve(current.handle)
    return new Promise((resolve) => waitersRef.current.push({ sessionId, resolve }))
  }, [])

  // ── The home thread ─────────────────────────────────────────────────────
  // One home load at a time, per chat: what asks while one runs waits on it.
  const homeLoadRef = useRef<{ sessionId: string; done: Promise<ChatPanelHandle | null> } | null>(null)
  /**
   * The chat on its home thread: at once when it is on it, else the home
   * thread loaded into it (only while nothing happens in it meanwhile; a
   * reply running is waited for, a send tried again). Null when it can't
   * be: the home thread couldn't be read, or the chat went.
   */
  const showHome = useCallback((): Promise<ChatPanelHandle | null> => {
    const sessionId = chatRef.current.chatSessionId
    const running = homeLoadRef.current
    if (running?.sessionId === sessionId) return running.done
    const done = (async (): Promise<ChatPanelHandle | null> => {
      for (let attempt = 0; attempt < HOME_LOAD_ATTEMPTS; attempt++) {
        const ws = chatWorkspaceRef.current
        const homeId = await fetchHomeThreadId(ws)
        if (!homeId || ws !== chatWorkspaceRef.current) return null
        const handle = await whenPanel(sessionId)
        if (!handle) return null
        if (handle.flushSnapshot().conversationId === homeId) return handle
        await handle.whenIdle()
        if (sessionId !== chatRef.current.chatSessionId) return null
        if (handle.flushSnapshot().conversationId === homeId) return handle
        const outcome = await handle.loadConversation(homeId, { ifUntouched: true })
        if (outcome === 'loaded') return handle
        // Gone (deleted elsewhere): forget it, and the next read is afresh.
        if (outcome === 'missing') forgetHomeThreadId(ws)
        else if (outcome !== 'aborted') return null
      }
      return null
    })()
    homeLoadRef.current = { sessionId, done }
    void done.finally(() => {
      if (homeLoadRef.current?.done === done) homeLoadRef.current = null
    })
    return done
  }, [whenPanel])

  // Boot: the chat the panel mounted on, put on the home thread when it isn't
  // (the persisted conversation is another, or the device had none). Only
  // while it is as it mounted: something said in it first keeps it as it is
  // (the next boot puts it back). Cards wait for this, so a deep link never
  // starts a conversation of its own before the home thread is in.
  const bootSettledRef = useRef<{ sessionId: string; done: Promise<void> } | null>(null)
  useEffect(() => {
    if (!hydrated) return
    const sessionId = chat.chatSessionId
    const mounted: ChatSlice = chat
    const ws = chatWorkspaceId
    const done = (async () => {
      const homeId = await fetchHomeThreadId(ws)
      if (!homeId || sessionId !== chatRef.current.chatSessionId) return
      const handle = await whenPanel(sessionId)
      if (!handle) return
      const live = handle.flushSnapshot()
      if (live.conversationId === homeId) return
      const touched = mounted.conversationId
        ? live.conversationId !== mounted.conversationId
        : live.chatMessages.length > 0 || !!live.conversationId
      if (touched) return
      await showHome()
    })().catch(() => {})
    bootSettledRef.current = { sessionId, done }
    // Once per chat (a workspace switch or a reset brings a new session), and
    // again once a chat booted with no workspace learns its own.
  }, [hydrated, chat.chatSessionId, chatWorkspaceId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cards to put in the chat (every way in opens a card) ────────────────
  const cards = useCardDeliveries()
  useEffect(() => {
    if (!cards || cards.deliveries.length === 0) return
    for (const delivery of cards.deliveries) {
      cards.ack(delivery.id)
      const { chatSessionId, request } = delivery
      // Another chat's (asked for before a switch that went elsewhere): dropped.
      if (chatSessionId !== chatRef.current.chatSessionId) continue
      // At boot, after the home thread is in (at most BOOT_CARD_WAIT_MS: a read
      // that hangs never holds a card back for good).
      const boot = bootSettledRef.current?.sessionId === chatSessionId ? bootSettledRef.current.done : null
      const settled = boot
        ? Promise.race([boot, new Promise<void>((resolve) => setTimeout(resolve, BOOT_CARD_WAIT_MS))])
        : Promise.resolve()
      void settled.then(() => whenPanel(chatSessionId)).then((h) => h?.openCard(request))
    }
  }, [cards, whenPanel])

  // ── Onboarding (F2/F3): the brief ───────────────────────────────────────
  // The member's first land after onboarding runs the home thread in
  // onboarding mode: every server-written row and the brief placeholder
  // (use-home-conversation-adoption.ts). At most once per workspace. Getting
  // started itself is the server's (docs/plans/getting-started-skill.md).
  const adoptedHomeConversationId = useHomeConversationAdoption({
    workspaceId,
    alreadyPersistedConversation: Boolean(chat.conversationId),
  })

  // ── What the surfaces ask of the chat ───────────────────────────────────
  // Editor selection (inline AI editing context) reported by cards via a
  // window event, so the chat reads it without prop-drilling through every view.
  const [editorSelection, setEditorSelection] = useState<EditorSelection | null>(null)
  const clearEditorSelection = useCallback(() => setEditorSelection(null), [])

  useEffect(() => {
    const onProposal = (e: Event) => panelNow()?.chatAboutProposal((e as CustomEvent).detail)
    const onTriggerSkill = (e: Event) => {
      const slug = (e as CustomEvent).detail?.slug
      if (slug) panelNow()?.triggerSkillBySlug(slug)
    }
    const onEditorSelection = (e: Event) => setEditorSelection((e as CustomEvent).detail ?? null)
    const onProspectingStart = (e: Event) => {
      const detail = (e as CustomEvent).detail as ProspectingStartDetail | undefined
      if (detail) panelNow()?.startProspecting(detail)
    }
    const onProspectingAsk = (e: Event) => {
      // "Ask about this list": arms the composer of the home thread (put back
      // on it first if another conversation is open); nothing is sent.
      const detail = (e as CustomEvent).detail as ProspectingAskDetail | undefined
      if (!detail) return
      void showHome().then((home) => (home ?? panelNow())?.askAboutList(detail))
    }
    const onFindContactEmail = (e: Event) => {
      const detail = (e as CustomEvent).detail as FindContactEmailContext | undefined
      if (detail) panelNow()?.findContactEmail(detail)
    }
    const onEmailReply = (e: Event) => {
      // Auto-sends (src/lib/email/reply-in-chat.ts).
      const request = parseEmailReplyRequest((e as CustomEvent).detail)
      if (request) panelNow()?.replyToEmail(request)
    }
    const onCardReply = (e: Event) => {
      // Reply on a For you card (src/lib/chat/card-reply.ts): the card waits
      // as a chip in the home thread's composer (put back on it first if
      // another conversation is open); nothing is sent.
      const ref = parseCardReplyRef((e as CustomEvent).detail)
      if (!ref) return
      void showHome().then((home) => (home ?? panelNow())?.replyToCard(ref))
    }
    const onVoiceAsk = (e: Event) => {
      // Interactive mode (components/read-aloud/interactive-voice-host.tsx):
      // during a call the live agent answers, otherwise the home thread
      // (chat/route-voice-ask.ts).
      const delivery = (e as CustomEvent).detail
      if (!isVoiceAskDelivery(delivery)) return
      routeVoiceAskHome(delivery, { panel: panelNow, showHome, liveCall: liveCallNow })
    }
    const onOpenHomeThread = (e: Event) => {
      // { text?, cardIds?, workspaceId?, reveal?, take?, onResult? }: the home
      // thread, and `text` sent there as the person's message (the cards it
      // was about ride along). `reveal`: on a message the agent wrote there (a
      // banner's click), brought in when the chat lacks it. `take` says this
      // window has a chat; `onResult` hears whether it went (handOffToHome), so
      // the surface keeps its text and says why when it didn't. (`activate` is
      // moot: the chat is on screen.)
      const { text, cardIds, workspaceId: forWorkspace, reveal, take, onResult } = parseOpenHomeThreadDetail((e as CustomEvent).detail)
      take?.()
      const report = onResult ?? (() => {})
      // Another workspace's words never go into this workspace's home thread.
      if (forWorkspace && forWorkspace !== chatWorkspaceRef.current) {
        report({ ok: false, reason: HOME_HANDOFF_REASONS.otherWorkspace })
        return
      }
      void showHome().then(
        async (handle) => {
          if (!handle) return report({ ok: false, reason: HOME_HANDOFF_REASONS.notOpened })
          if (reveal) void handle.revealMessage(reveal.messageId)
          if (!text) return report({ ok: true })
          const went = await handle.sendFromSurface(text, { cardIds }).catch(() => false)
          report(went ? { ok: true } : { ok: false, reason: HOME_HANDOFF_REASONS.notSent })
        },
        () => report({ ok: false, reason: HOME_HANDOFF_REASONS.notOpened }),
      )
    }
    const onHomeMessage = (e: Event) => {
      // A banner about a message the agent wrote in a home thread
      // (lib/chat/home-message.ts): the chat on that thread takes it, when
      // its own Realtime bridge missed it. Another workspace's, or a chat on
      // another conversation, has nothing to take.
      const ref = parseHomeMessageDetail((e as CustomEvent).detail)
      if (!ref || ref.workspaceId !== chatWorkspaceRef.current) return
      const handle = panelNow()
      if (!handle || handle.flushSnapshot().conversationId !== ref.conversationId) return
      void handle.catchUpServerTurns(ref.messageId)
    }
    const onVoiceBird = (e: Event) => {
      // The voice bird (components/birds/voice-bird.ts): `start` starts voice
      // mode in the chat as it is, as the composer's waveform does (no thread
      // switch, no wait for a reply: voice mode handles one running), and a
      // refusal toasts as the waveform's does; `end` ends the chat's voice mode.
      const detail = parseVoiceBirdDetail((e as CustomEvent).detail)
      if (!detail) return
      if (detail.action === 'end') {
        panelNow()?.endVoiceMode()
        return
      }
      detail.take()
      const handle = panelNow()
      // Sent away (or summoned again) before it could start: nothing starts.
      if (!handle || !detail.wanted()) return detail.onResult(false)
      void handle.startVoiceMode().then(
        (refusal) => {
          if (refusal) reportVoiceRefusal(refusal)
          detail.onResult(!refusal)
        },
        () => detail.onResult(false),
      )
    }
    const events: Array<[string, (e: Event) => void]> = [
      ['dial8:chat-about-proposal', onProposal],
      ['dial8:trigger-skill', onTriggerSkill],
      ['dial8:editor-selection', onEditorSelection],
      [PROSPECTING_START_EVENT, onProspectingStart],
      [PROSPECTING_ASK_EVENT, onProspectingAsk],
      [FIND_CONTACT_EMAIL_EVENT, onFindContactEmail],
      [EMAIL_REPLY_EVENT, onEmailReply],
      [CARD_REPLY_EVENT, onCardReply],
      [VOICE_ASK_EVENT, onVoiceAsk],
      [OPEN_HOME_THREAD_EVENT, onOpenHomeThread],
      [HOME_MESSAGE_EVENT, onHomeMessage],
      [VOICE_BIRD_EVENT, onVoiceBird],
    ]
    for (const [name, fn] of events) window.addEventListener(name, fn)
    return () => {
      for (const [name, fn] of events) window.removeEventListener(name, fn)
    }
  }, [panelNow, showHome, liveCallNow])

  return (
    <div className="relative h-full w-full">
      {/* Mounted once the device's copy is read (before paint), straight on
          it: never on a placeholder first. */}
      {hydrated && (
        <div className="absolute inset-0 flex flex-col">
          <MainChatPanel
            chat={chat}
            isRecording={isRecording}
            onCallCaptureId={activeCaptureId}
            userAvatarUrl={userAvatarUrl}
            userInitials={userInitials}
            registerPanel={registerPanel}
            editorSelection={editorSelection}
            onClearEditorSelection={clearEditorSelection}
            homeThreadId={homeThreadId}
            homeConversationId={adoptedHomeConversationId}
            onboardingBriefMessageId={adoptedHomeConversationId && workspaceId ? `onboarding-brief-${workspaceId}` : undefined}
          />
        </div>
      )}
    </div>
  )
})

/** The panel itself, around which the live capture's notepad docks. */
const MainChatPanel = memo(function MainChatPanel({
  chat,
  isRecording,
  onCallCaptureId,
  userAvatarUrl,
  userInitials,
  registerPanel,
  editorSelection,
  onClearEditorSelection,
  homeThreadId,
  homeConversationId,
  onboardingBriefMessageId,
}: {
  chat: ChatSlice
  isRecording: boolean
  /** The capture of the call going on, or null: every turn says a call is on. */
  onCallCaptureId: string | null
  userAvatarUrl: string | null
  userInitials: string
  registerPanel: (chatSessionId: string, handle: ChatPanelHandle | null) => void
  editorSelection: EditorSelection | null
  onClearEditorSelection: () => void
  homeThreadId: string | null
  homeConversationId: string | null
  onboardingBriefMessageId: string | undefined
}) {
  const { chatSessionId } = chat
  const panelRef = useRef<ChatPanelHandle | null>(null)
  const handleRef = useCallback(
    (h: ChatPanelHandle | null) => {
      panelRef.current = h
      registerPanel(chatSessionId, h)
    },
    [registerPanel, chatSessionId],
  )

  // The panel's send path reads the selection through a ref (its send body
  // is built in a stable useMemo).
  const editorSelectionRef = useRef<EditorSelection | null>(null)
  useEffect(() => {
    editorSelectionRef.current = editorSelection
  }, [editorSelection])

  // The name the user gave their assistant on this device (Settings → Preferences),
  // once they saved one: every turn carries it (assistant-name-store.ts). And
  // while a call is on, its capture: the main agent hears one line about it
  // (chat-system-prompt.ts `call`), and can read its transcript with the
  // capture tools when asked; the call's live agent answers in its own chat.
  const { name: assistantName, saved: assistantNamed } = useAssistantName()
  const systemContext = useMemo(
    () => ({
      ...(assistantNamed ? { assistantName } : {}),
      ...(onCallCaptureId ? { onCallCaptureId } : {}),
    }),
    [assistantNamed, assistantName, onCallCaptureId],
  )

  // The workspace switch and pagehide write the chat's LIVE thread.
  const flushChat = useCallback(() => panelRef.current?.flushSnapshot() ?? null, [])
  useRegisterChatFlush(chatSessionId, flushChat)

  return (
    // While a capture is active, its notepad docks on the left and the chat
    // moves over (chat/live-capture-dock.tsx).
    <LiveCaptureDockLayout>
      <FloatingChat forceExpanded={isRecording}>
        <ChatPanel
          ref={handleRef}
          key={chatSessionId}
          chatSessionId={chatSessionId}
          initialMessages={chat.chatMessages}
          initialInput={chat.chatInput}
          initialConversationId={chat.conversationId ?? homeThreadId ?? undefined}
          homeThreadId={homeThreadId}
          homeConversationId={homeConversationId ?? undefined}
          onboardingBriefMessageId={onboardingBriefMessageId}
          userAvatarUrl={userAvatarUrl}
          userInitials={userInitials}
          systemContext={systemContext}
          editorSelectionRef={editorSelectionRef}
          editorSelection={editorSelection}
          onClearEditorSelection={onClearEditorSelection}
          autoFocus={false}
          alwaysShowMessages
        />
      </FloatingChat>
    </LiveCaptureDockLayout>
  )
})
