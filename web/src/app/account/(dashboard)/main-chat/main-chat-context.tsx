'use client'

/**
 * The main chat (docs/plans/one-chat.md, Slice 1): ONE chat per workspace, the
 * person's never-ending home thread with the main agent. There are no tabs, no
 * "New chat", no history list and no titles. This provider holds that chat for
 * the workspace on screen, keeps it on the device per workspace
 * (main-chat-storage.ts), and routes the cards asked for from anywhere
 * (OPEN_CARD_EVENT) into it, after switching to the card's own workspace when
 * it is another. The panel itself is mounted by MainChatHost (main-chat-host.tsx).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { OPEN_CARD_EVENT, PAGE_DEEP_LINK_PARAM, PAGE_DEEP_LINK_PLACES, cardForTarget, parseOpenCardRequest, type OpenCardRequest } from '@/lib/chat-cards/open-card'
import { takeExportFromAddress } from '@/components/studio/ui/export-arrival'
import { useSwitchWorkspace, useWorkspaceId } from '@/app/account/workspace-switcher'
import { toast } from 'sonner'
import { DEEP_LINK_TYPES } from '@/lib/entities/entity-actions-registry'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import { prunePersistedEvents } from '@/calendar/persisted-events'
import {
  createChatSlice,
  readLastWorkspaceId,
  readStoredChat,
  sweepClaudeCodeKeys,
  sweepLegacyTabKeys,
  writeLastWorkspaceId,
  writeStoredChat,
} from './main-chat-storage'
import type { ChatSlice } from './types'

/**
 * A card waiting to be put in the main chat (lib/chat-cards/open-card.ts),
 * addressed to the chat it was asked for by its session id: a card asked for
 * just before a workspace switch is for that workspace's chat, never the one
 * on screen a moment before. The host delivers it to that chat's panel and
 * acknowledges it.
 */
export interface CardDelivery {
  id: string
  chatSessionId: string
  request: OpenCardRequest
}
interface CardDeliveries {
  deliveries: readonly CardDelivery[]
  ack: (id: string) => void
  /** Put a card in the main chat (the recording's capture card, a deep link). */
  deliver: (request: OpenCardRequest) => void
}
const CardDeliveriesContext = createContext<CardDeliveries | null>(null)

/** The cards waiting for the chat, and how to say one was delivered. Null outside a MainChatProvider. */
export function useCardDeliveries(): CardDeliveries | null {
  return useContext(CardDeliveriesContext)
}

/**
 * Is there a chat to open a card in? Never throws: a deep leaf that renders
 * both inside the dashboard and on standalone pages with no chat (the wiki
 * reader, a public share) asks this before offering "Open" at all.
 */
export function useCanOpenCards(): boolean {
  return useContext(CardDeliveriesContext) !== null
}

const DEEP_LINK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The boot deep links, as the cards they open: `?<kind>=<id>` for every kind
 * with a link in the entity actions registry (DEEP_LINK_TYPES): `?sequence=`
 * (getSequenceUrl), `?prospect_list=` (getProspectListUrl), `?action=` (the
 * links the Linear, Jira and Asana pushes and flow templates hand out),
 * `?project=` and `?initiative=` (flow templates), and the record a menu's
 * Copy link copied (a doc, a capture, a contact, a company, a deal, a flow).
 * `&workspace=<id>` (a team chat email's link) names the workspace it is in:
 * the card opens there, switched to first, as any card asked for in another
 * workspace does (a workspace the person isn't in opens nothing). Uuids only.
 * And `?page=<slug>`, a `/` page's own card (pageDeepLink: where a settings
 * page that became a page redirects, Availability; Liam, 11-11), by a slug
 * the `/` menu has (the card checks its own gate), with a place inside it
 * where the page takes one (PAGE_DEEP_LINK_PLACES: `?page=studio&video=<id>`
 * opens the Studio on that video). One per boot.
 */
export function deepLinkCard(params: URLSearchParams): { param: string; also?: string[]; request: OpenCardRequest } | null {
  const workspace = params.get(DEEP_LINK_WORKSPACE)
  const workspaceId = workspace && DEEP_LINK_ID.test(workspace) ? workspace : null
  for (const param of DEEP_LINK_TYPES) {
    const id = params.get(param)
    // Ids only: a link is outside input, and every one of these is a uuid.
    if (!id || !DEEP_LINK_ID.test(id)) continue
    const target = entityOpenTarget(param, id)
    const card = target ? cardForTarget(target) : null
    if (!card) continue
    // The seed is where inside the card it starts (a flow's editor).
    return { param, request: { spec: card.spec, from: 'link', ...(card.seed ? { seed: card.seed } : {}), ...(workspaceId ? { workspaceId } : {}) } }
  }
  const slug = params.get(PAGE_DEEP_LINK_PARAM)
  const page = slug && /^[a-z][a-z-]{0,39}$/.test(slug) ? cardForTarget({ type: 'page', slug }) : null
  if (!page || !slug) return null
  // A place inside the page beside it (the Studio on one video: `&video=<id>`), uuids only.
  for (const [param, type] of Object.entries(PAGE_DEEP_LINK_PLACES[slug] ?? {})) {
    const id = params.get(param)
    if (!id || !DEEP_LINK_ID.test(id)) continue
    const place = cardForTarget({ type, id })
    if (place) return { param: PAGE_DEEP_LINK_PARAM, also: [param], request: { spec: place.spec, from: 'link', ...(workspaceId ? { workspaceId } : {}) } }
  }
  return { param: PAGE_DEEP_LINK_PARAM, request: { spec: page.spec, from: 'link', ...(workspaceId ? { workspaceId } : {}) } }
}

/** The deep link's workspace parameter. */
export const DEEP_LINK_WORKSPACE = 'workspace'

interface MainChatValue {
  /** The chat of the workspace on screen, as the panel mounts on it. */
  chat: ChatSlice
  /** The workspace that chat belongs to: the boot pointer's until the real id lands, then the real one. Null before either. */
  chatWorkspaceId: string | null
  /** The device's copy has been read (boot): the panel mounts only from then on. */
  hydrated: boolean
}
const MainChatContext = createContext<MainChatValue | null>(null)

interface MainChatActions {
  /** The chat as it is now: the panel's live thread when it is mounted, else the stored slice. */
  readChat: () => ChatSlice
  /**
   * The chat again from nothing, on the home thread: a new session (no draft,
   * no card open, docked or full screen; its card store goes with the old
   * panel), stored at once. The automation bridge's resetUi.
   */
  resetChat: () => void
}
const MainChatActionsContext = createContext<MainChatActions | null>(null)

// The mounted panel's flush (useRegisterChatFlush), keyed by its session id:
// the workspace switch and the pagehide handler read its LIVE thread before
// writing it. It RETURNS the slice (a state update wouldn't land in time to
// be written the same tick). A ref, so registering never re-renders.
type ChatFlushRegistry = Map<string, () => ChatSlice | null>
const ChatFlushContext = createContext<React.MutableRefObject<ChatFlushRegistry> | null>(null)

/** The workspace's stored chat, or a new one, stored at once so its session id holds from the first boot. */
function chatFor(workspaceId: string): ChatSlice {
  const stored = readStoredChat(workspaceId)
  if (stored) return stored
  const fresh = createChatSlice()
  writeStoredChat(workspaceId, fresh)
  return fresh
}

export function MainChatProvider({ children }: { children: React.ReactNode }) {
  const workspaceId = useWorkspaceId()
  // Before boot reads the device, a placeholder the panel never mounts on.
  const [{ chat, chatWorkspaceId }, setChatState] = useState<{ chat: ChatSlice; chatWorkspaceId: string | null }>(() => ({
    chat: createChatSlice(),
    chatWorkspaceId: null,
  }))
  const [hydrated, setHydrated] = useState(false)
  const chatRef = useRef(chat)
  const setChat = useCallback((next: ChatSlice, ws: string | null) => {
    chatRef.current = next
    setChatState({ chat: next, chatWorkspaceId: ws })
  }, [])
  const flushRef = useRef<ChatFlushRegistry>(new Map())

  // The workspace every write targets: seeded at boot from the last-workspace
  // pointer (the real id arrives async) and only ever ADVANCES to a known id.
  const workspaceIdRef = useRef<string | null>(null)
  if (workspaceId) workspaceIdRef.current = workspaceId
  const bootWorkspaceRef = useRef<string | null>(null)
  // Read through a ref so the card listener survives every workspace-cache change.
  const switchWorkspace = useSwitchWorkspace()
  const switchWorkspaceRef = useRef(switchWorkspace)
  switchWorkspaceRef.current = switchWorkspace

  /** The chat as it is now: the mounted panel's live thread, else the slice. */
  const readChat = useCallback((): ChatSlice => {
    const current = chatRef.current
    const flush = flushRef.current.get(current.chatSessionId)
    if (!flush) return current
    try {
      return flush() ?? current
    } catch {
      return current
    }
  }, [])

  // ── Cards to put in the chat (every way in opens a card) ─────────────────
  const [deliveries, setDeliveries] = useState<readonly CardDelivery[]>([])
  const deliverTo = useCallback((chatSessionId: string, request: OpenCardRequest) => {
    setDeliveries((q) => [...q, { id: crypto.randomUUID(), chatSessionId, request }])
  }, [])
  const deliver = useCallback((request: OpenCardRequest) => deliverTo(chatRef.current.chatSessionId, request), [deliverTo])
  const ack = useCallback((id: string) => {
    setDeliveries((q) => (q.some((d) => d.id === id) ? q.filter((d) => d.id !== id) : q))
  }, [])
  // A card asked for in another workspace waits for that workspace's chat (and
  // is dropped if the switch went elsewhere); a deep link read at boot, while
  // the workspace was still the pointer's guess, waits for the real id.
  const pendingCrossWorkspaceCardRef = useRef<{ workspaceId: string; request: OpenCardRequest } | null>(null)
  const pendingDeepLinkCardRef = useRef<OpenCardRequest | null>(null)

  // Boot: the device's copy of the chat, read in a LAYOUT effect (after
  // hydration, so no mismatch; before paint, so nothing flashes). The panel
  // mounts once this lands, straight on the stored thread.
  useLayoutEffect(() => {
    const bootWorkspaceId = workspaceId ?? readLastWorkspaceId()
    bootWorkspaceRef.current = bootWorkspaceId
    if (bootWorkspaceId) {
      workspaceIdRef.current = bootWorkspaceId
      setChat(chatFor(bootWorkspaceId), bootWorkspaceId)
    }
    setHydrated(true)

    // ── Deep links (?sequence=, ?prospect_list=, ?action=, ?project=, ?initiative=) ──
    // Consumed here, beside the boot read, so the card is addressed to the
    // chat that will show it. The URL is stripped once it is parked or queued.
    try {
      const params = new URLSearchParams(window.location.search)
      // A Studio export to download on arrival (components/studio/ui/export-arrival.ts): kept for the Studio only
      // beside `page=studio&video=`, and taken off the address either way, so it never acts later.
      const tookExport = takeExportFromAddress(params)
      const link = deepLinkCard(params)
      if (!link && tookExport) {
        const rest = params.toString()
        window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''))
      }
      if (link) {
        // A link naming its workspace waits for the real id, which says whether it is another one to switch to.
        if (workspaceId && !link.request.workspaceId) deliverTo(chatRef.current.chatSessionId, link.request)
        else pendingDeepLinkCardRef.current = link.request
        params.delete(link.param)
        for (const extra of link.also ?? []) params.delete(extra)
        params.delete(DEEP_LINK_WORKSPACE)
        const rest = params.toString()
        window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''))
      }
    } catch {
      // Never let a malformed URL block the boot.
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- workspaceId intentionally read once

  /** Write the chat on screen (its live thread) under `ws`. */
  const persistTo = useCallback((ws: string) => {
    writeStoredChat(ws, readChat())
  }, [readChat])

  // On workspace change: the chat on screen is written to its workspace, and
  // the incoming workspace's chat (or a new one) comes in.
  const prevWorkspaceRef = useRef<string | null>(null)
  useEffect(() => {
    if (!workspaceId) return
    // The card a switch was started for: read and CLEARED whichever workspace
    // arrived (a stale one must never replay into a later switch), and used
    // only when this is the workspace it was parked for.
    const takeParkedCard = (): OpenCardRequest | null => {
      const parked = pendingCrossWorkspaceCardRef.current
      pendingCrossWorkspaceCardRef.current = null
      return parked && parked.workspaceId === workspaceId ? parked.request : null
    }
    if (!prevWorkspaceRef.current) {
      // The first real id. Usually it confirms the workspace booted from (the
      // pointer); when it differs (no pointer yet, or the server's current
      // workspace moved) it is a switch.
      prevWorkspaceRef.current = workspaceId
      writeLastWorkspaceId(workspaceId)
      // Once per boot, now the chat in memory is the one kept: the tabs' keys
      // go (a one-time sweep, then a walk over key names), so do the retired
      // local Claude Code pipeline's (once per device), and the calendar's
      // warm-start copies, which share the storage bucket, are pruned.
      sweepLegacyTabKeys()
      sweepClaudeCodeKeys()
      prunePersistedEvents()
      let card = pendingDeepLinkCardRef.current ?? takeParkedCard()
      pendingDeepLinkCardRef.current = null
      // A deep link into another workspace: switched to, and opened there (as a card asked for there is).
      if (card?.workspaceId && card.workspaceId !== workspaceId) {
        pendingCrossWorkspaceCardRef.current = { workspaceId: card.workspaceId, request: card }
        if (!switchWorkspaceRef.current(card.workspaceId)) {
          pendingCrossWorkspaceCardRef.current = null
          toast('That link is to a workspace you aren’t in.')
        }
        card = null
      }
      const bootWs = bootWorkspaceRef.current
      if (bootWs === workspaceId) {
        if (card) deliver(card)
        return
      }
      if (bootWs) persistTo(bootWs)
      // No pointer: the chat in memory has only ever been this workspace's.
      const next = bootWs ? chatFor(workspaceId) : (readStoredChat(workspaceId) ?? chatRef.current)
      if (!bootWs) writeStoredChat(workspaceId, next)
      setChat(next, workspaceId)
      if (card) deliverTo(next.chatSessionId, card)
      return
    }
    if (prevWorkspaceRef.current !== workspaceId) {
      persistTo(prevWorkspaceRef.current)
      prevWorkspaceRef.current = workspaceId
      writeLastWorkspaceId(workspaceId)
      const parked = takeParkedCard()
      const next = chatFor(workspaceId)
      setChat(next, workspaceId)
      if (parked) deliverTo(next.chatSessionId, parked)
    }
  }, [workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps -- the rest is read through refs

  // On pagehide (reload, close, the desktop window's teardown) the live thread
  // is written straight away: nothing else writes it during use.
  useEffect(() => {
    const onPageHide = () => {
      const ws = workspaceIdRef.current
      if (ws) persistTo(ws)
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [persistTo])

  // ── Every way in opens a card (lib/chat-cards/open-card.ts) ──────────────
  // An OPEN_CARD_EVENT from anywhere goes to the chat. One for another
  // workspace is parked and that workspace switched to first; a refused
  // switch (a capture recording, a workspace no longer the member's) drops it.
  useEffect(() => {
    const onOpenCard = (e: Event) => {
      const request = parseOpenCardRequest((e as CustomEvent).detail)
      if (!request) return
      const card = request
      const target = card.workspaceId
      if (!target || target === workspaceIdRef.current) {
        deliver(card)
        return
      }
      pendingCrossWorkspaceCardRef.current = { workspaceId: target, request: card }
      if (!switchWorkspaceRef.current(target)) pendingCrossWorkspaceCardRef.current = null
    }
    window.addEventListener(OPEN_CARD_EVENT, onOpenCard)
    return () => window.removeEventListener(OPEN_CARD_EVENT, onOpenCard)
  }, [deliver])

  const resetChat = useCallback(() => {
    const next = createChatSlice()
    const ws = workspaceIdRef.current
    if (ws) writeStoredChat(ws, next)
    setChat(next, ws)
  }, [setChat])

  const value = useMemo<MainChatValue>(() => ({ chat, chatWorkspaceId, hydrated }), [chat, chatWorkspaceId, hydrated])
  const actions = useMemo<MainChatActions>(() => ({ readChat, resetChat }), [readChat, resetChat])
  const cardDeliveries = useMemo<CardDeliveries>(() => ({ deliveries, ack, deliver }), [deliveries, ack, deliver])

  return (
    <MainChatContext.Provider value={value}>
      <MainChatActionsContext.Provider value={actions}>
        <ChatFlushContext.Provider value={flushRef}>
          <CardDeliveriesContext.Provider value={cardDeliveries}>{children}</CardDeliveriesContext.Provider>
        </ChatFlushContext.Provider>
      </MainChatActionsContext.Provider>
    </MainChatContext.Provider>
  )
}

/** The main chat of the workspace on screen, and whether the device's copy has been read. */
export function useMainChat(): MainChatValue {
  const ctx = useContext(MainChatContext)
  if (!ctx) throw new Error('useMainChat must be used within MainChatProvider')
  return ctx
}

export function useMainChatActions(): MainChatActions {
  const ctx = useContext(MainChatActionsContext)
  if (!ctx) throw new Error('useMainChatActions must be used within MainChatProvider')
  return ctx
}

/**
 * Register the chat panel's flush (keyed by its chatSessionId), so the
 * workspace switch and the pagehide handler write its live thread. The fn
 * RETURNS the live ChatSlice (or null). No-op outside a MainChatProvider.
 * Unregisters on unmount.
 */
export function useRegisterChatFlush(chatSessionId: string, flush: () => ChatSlice | null): void {
  const ref = useContext(ChatFlushContext)
  useEffect(() => {
    if (!ref) return
    const registry = ref.current
    registry.set(chatSessionId, flush)
    return () => {
      if (registry.get(chatSessionId) === flush) registry.delete(chatSessionId)
    }
  }, [ref, chatSessionId, flush])
}

/**
 * Read a panel's LIVE chat (what useRegisterChatFlush registered for that
 * session): its messages and the conversation it is bound to right now. Null
 * when no panel is mounted for the session (or outside a MainChatProvider).
 */
export function useReadLiveChat(): (chatSessionId: string) => ChatSlice | null {
  const ref = useContext(ChatFlushContext)
  return useCallback(
    (chatSessionId: string) => {
      const flush = ref?.current.get(chatSessionId)
      if (!flush) return null
      try {
        return flush()
      } catch {
        return null
      }
    },
    [ref],
  )
}
