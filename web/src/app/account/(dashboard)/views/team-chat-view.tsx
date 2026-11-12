'use client'

/**
 * Team chat (roadmap #7, migration 474): the workspace's channels and direct
 * messages, with each person's agent as a member of the team. Opened as a
 * page card from `/` (src/components/chat-cards/pages/team-chat-card.tsx).
 *
 * It is NOT the AI chat: that is the person talking to their agent
 * (useChat over the eve chat-agent). This is people talking to each other;
 * @-mentioning your agent here runs one chat-agent turn as you, with the
 * channel's recent messages as context, and its reply is posted into the
 * channel as your agent (src/lib/team-chat/agent-turn.ts).
 *
 * Migrations 555-559 complete it: a reply in a thread opens in a pane beside
 * the channel (its replies are unread only for the people in it); reactions
 * are chips under a message; files and images ride on a message (uploaded
 * straight to the team-chat-files bucket as the person); a link's preview
 * arrives once the server has read it; "X is typing" shows under the box.
 * A send is optimistic: its bubble is drawn at once under the client id the
 * page minted for it, and the row (from the answer or Realtime, whichever
 * comes first) takes its place under the same key, so nothing doubles or
 * flickers; a failed one says so on the bubble, and Retry sends it again with
 * the same id (the server answers with the row a lost answer had made).
 *
 * Phase 2 (migrations 560, 561): each channel's header has a small menu for
 * how loud it is (all messages, mentions only, muted; a muted channel shows
 * no unread count, only its mentions), and the view opens on one message
 * when it is asked to (`focus`: a notification's click, a search hit), in its
 * channel or its thread, scrolled to it and lit for a moment. What it shows
 * is registered (src/lib/team-chat/on-screen.ts), so a notification about a
 * message on screen raises no toast.
 *
 * Owns its own fetches against /api/account/team-chat/* and one Supabase
 * Realtime channel for the workspace (team_chat_message, team_chat_channel,
 * team_chat_thread, team_chat_reaction; RLS filters what arrives), resyncing
 * on every (re)subscribe, plus the channel on screen's private typing topic
 * (src/lib/team-chat/typing.ts).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Bell, BellOff, Check, ChevronLeft, Hash, Lock, MessageSquare, MessageSquareReply, Pencil, Plus, RotateCw, Trash2, Users, Video, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { cachedJson } from '@/lib/cached-fetch'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { useTeams } from '@/app/account/teams-context'
import { useAssistantName } from '@/lib/voice/assistant-name-store'
import { ChatInput, type ChatInputVoice } from '@/app/account/(dashboard)/chat/chat-input'
import type { ChatFileAttachment } from '@/app/account/(dashboard)/chat/chat-panel'
import { useVoiceAvailability } from '@/hooks/use-voice-availability'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import type { ComposerMentionList, ComposerMentionOption } from '@/app/account/(dashboard)/chat/command-menu-model'
import {
  applyReaction,
  channelBadge,
  channelHeaderCount,
  continuesGroup,
  mergePage,
  failPending,
  groupReactions,
  hasMention,
  linkRuns,
  mentionSegments,
  mentionsStillIn,
  messageKey,
  messageTime,
  pendingMessageId,
  replyCountLabel,
  typingLine,
  upsertMessage,
} from '@/lib/team-chat/compose'
import {
  agentDisplayName,
  mentionsAssistantName,
  TEAM_CHAT_MESSAGE_MAX,
  TEAM_CHAT_PAGE_SIZE,
  type TeamChatAttachment,
  type TeamChatChannel,
  type TeamChatMessage,
  type TeamChatReaction,
  type TeamChatRecordMention,
  type TeamChatThreadSummary,
  type TeamChatThreadUnread,
} from '@/lib/team-chat/types'
import { TEAM_CHAT_FILE_ACCEPT, TEAM_CHAT_MAX_FILES, validateTeamChatFile } from '@/lib/team-chat/files'
import { discardTeamChatFile, uploadTeamChatFile } from '@/lib/team-chat/upload-client'
import { joinTyping, TYPING_SHOW_MS, TYPING_THROTTLE_MS } from '@/lib/team-chat/typing'
import { setTeamChatOnScreen } from '@/lib/team-chat/on-screen'
import type { TeamChatNotifyLevel } from '@/lib/team-chat/notify'
import { openTarget, type OpenTarget } from '@/lib/chat-cards/open-card'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import { EntityContextMenu } from '@/components/entities/entity-actions-menu'
import { menuRowMention, type MenuSearchRow } from '@/lib/search/menu-search'
import { parseSharedRecords, toastSharedRecords } from '@/lib/entity-access/share-toast'
import { useTeamCalls } from '@/components/team-calls/team-calls-provider'
import { upsertParticipant, type TeamCall, type TeamCallParticipant, type TeamCallView } from '@/lib/team-calls/types'
import { CallMessage, CallButton } from './team-call-parts'
import { NewMeetingDialog } from '@/components/meeting-links/new-meeting-dialog'
import { MeetingLinkBar } from '@/components/meeting-links/meeting-link-bar'
import { Avatar, LinkPreviewCard, MessageAttachments, memberName, ReactButton, ReactionChips, ThreadBar, type Member } from './team-chat-message-parts'
import { lastTeamChat, publishTeamChatCard, unpublishTeamChatCard, type TeamChatPanelConversation } from '@/components/chat-cards/team-chat-card-controls'
import { useRailShown } from '../rail/rail-media'

/**
 * Below this width the view shows one pane at a time (a phone, a narrow
 * card): the list of channels, then the channel picked, with Back. At it and
 * above, the two side by side, split by Mail's resizable handle. The inline
 * card's list may be narrower (down to 176px), so it keeps two panes down to
 * TEAM_CHAT_TWO_PANE_MIN_COMPACT_PX.
 */
export const TEAM_CHAT_TWO_PANE_MIN_PX = 576
export const TEAM_CHAT_TWO_PANE_MIN_COMPACT_PX = 480
/** Below this width of the channel's side, an open thread takes it over (with Back to the channel) instead of sitting beside it. */
export const TEAM_CHAT_THREAD_BESIDE_MIN_PX = 760

/**
 * Is the element narrower than `min`? Its own width, read by one
 * ResizeObserver (it fires only on a resize, never at rest). Unmeasured (no
 * layout yet, or no ResizeObserver): wide, as before.
 */
function useNarrow(ref: RefObject<HTMLElement | null>, min: number): boolean {
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const width = el.clientWidth
      setNarrow(width > 0 && width < min)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, min])
  return narrow
}

/** The id the person's own agent goes by in the picker (never a member id). */
const AGENT_OPTION_ID = '__agent__'
/** How long the "thinking" line waits for the agent's reply before it gives up. */
const AGENT_WAIT_MS = 3 * 60_000

/** A message as the page holds it: a row, or the person's own send on its way (or failed). */
type Shown = TeamChatMessage & { pending?: 'sending' | 'failed' }

/** One send, as the box hands it over: what Retry sends again, with the same client id. */
export interface TeamChatSendDraft {
  clientId: string
  channelId: string
  /** The thread it replies in, or null for the channel. */
  threadRootId: string | null
  body: string
  mentions: string[]
  mentionsAgent: boolean
  records: TeamChatRecordMention[]
  attachments: TeamChatAttachment[]
}

/** Where a message is listed: its thread (by root) or its channel. Also where an agent's "looking into it" line waits. */
function placeOf(m: { channel_id: string; thread_root_id: string | null }): string {
  return m.thread_root_id ?? m.channel_id
}

/** Where the view is asked to open: a channel, or one message (in its channel or its thread, scrolled to it). */
export type TeamChatFocus = { type: 'channel' | 'message'; id: string }

/** How long a message opened on stays lit, and how long the view waits for it to show before it gives up. */
const FOCUS_LIT_MS = 2500
const FOCUS_GIVE_UP_MS = 8000

export function TeamChatView({
  onCount,
  compact = false,
  focus = null,
  cardId,
  onShowCard,
}: {
  onCount?: (count: number | null) => void
  compact?: boolean
  focus?: TeamChatFocus | null
  /**
   * The card it is in (team-chat-card.tsx): what it has and where it is go to
   * the page's sub-nav beside the rail (Liam, 11-11: "make the team-chat one
   * look like this"; components/chat-cards/team-chat-card-controls.ts).
   * Full screen from `md` up, that sub-nav is its one list: the card has no
   * list and no divider of its own there (Liam, 11-11: "did you actually
   * clean up the old one and remove it from the panel complely or did you do
   * something the lazy way?").
   */
  cardId?: string
  /** Put that card full screen (the sub-nav moves it from behind another card). */
  onShowCard?: () => void
} = {}) {
  const workspaceId = useWorkspaceId()
  const { teams } = useTeams()
  const { name: assistantName } = useAssistantName()

  const [channels, setChannels] = useState<TeamChatChannel[] | null>(null)
  const [meId, setMeId] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, Shown[]>>({})
  // Per thread (by its root): its replies, once opened; its summary; the person's unread in it.
  const [threadReplies, setThreadReplies] = useState<Record<string, Shown[]>>({})
  const [threads, setThreads] = useState<Record<string, TeamChatThreadSummary>>({})
  const [unreadThreads, setUnreadThreads] = useState<Record<string, TeamChatThreadUnread>>({})
  // Per message: the reactions that are on.
  const [reactions, setReactions] = useState<Record<string, TeamChatReaction[]>>({})
  // Per call (migration 564): its state and who is in it, for its message in the conversation.
  const [calls, setCalls] = useState<Record<string, TeamCallView>>({})
  const teamCalls = useTeamCalls()
  const [openThread, setOpenThread] = useState<{ channelId: string; rootId: string } | null>(null)
  const [waitingOnAgent, setWaitingOnAgent] = useState<Record<string, number>>({})
  const [newChannelOpen, setNewChannelOpen] = useState(false)
  // The team the New channel dialog opens with picked (the sub-nav's Team channels +); null: the whole workspace.
  const [newChannelTeam, setNewChannelTeam] = useState<string | null>(null)
  const [newDmOpen, setNewDmOpen] = useState(false)
  const [newMeetingOpen, setNewMeetingOpen] = useState(false)
  // The message the view was asked to open on (`focus`): where it is, and whether its pane has scrolled to it.
  const [focused, setFocused] = useState<{ id: string; channelId: string; rootId: string | null; shown: boolean } | null>(null)

  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId
  // One pane at a time when narrow (a phone): the list until the person opens
  // a channel, then that channel, with Back to the list.
  const rootRef = useRef<HTMLDivElement>(null)
  const narrow = useNarrow(rootRef, compact ? TEAM_CHAT_TWO_PANE_MIN_COMPACT_PX : TEAM_CHAT_TWO_PANE_MIN_PX)
  // The page's card full screen where the rail is (from `md` up): the
  // sub-nav beside the rail is its list (page-panel/team-chat-panel.tsx), so
  // the card has none, from its first render (a card mounts on the client,
  // so the window is read then, never guessed), and the conversation fills
  // it. Inline in the chat, below `md` (no rail, no sub-nav) or with no card
  // of its own, its list is as it always was.
  const railShown = useRailShown()
  const listInPanel = !!cardId && !compact && railShown
  const sectionRef = useRef<HTMLElement>(null)
  const threadOver = useNarrow(sectionRef, TEAM_CHAT_THREAD_BESIDE_MIN_PX)
  const [opened, setOpened] = useState(false)
  // Narrowing while a channel is on screen beside the list keeps that channel
  // open (with Back), not the list: it stays as it was, its draft, an edit,
  // where it was scrolled to. Set during render, so it never leaves the screen.
  const [wasNarrow, setWasNarrow] = useState(narrow)
  if (narrow !== wasNarrow) {
    setWasNarrow(narrow)
    if (narrow && selectedId && !opened) setOpened(true)
  }
  // Opened, but its channel is gone (archived, or no longer readable): the list again, never an empty pane with no way back.
  const openedNow = opened && !!selectedId && !!channels?.some((c) => c.id === selectedId)
  const showList = !listInPanel && (!narrow || !openedNow)
  const showChannel = listInPanel || !narrow || openedNow
  // One pane on screen (the conversation beside the sub-nav, or a phone's one at a time): no divider.
  const onePane = listInPanel || narrow
  // The channel on screen: the one read marks are for. The first channel is
  // picked for the person when the list loads, but on a phone it isn't on
  // screen until they open it, and its messages stay unread until then.
  const onScreen = showChannel ? selectedId : null
  const onScreenRef = useRef<string | null>(null)
  onScreenRef.current = onScreen
  // The thread open beside the channel on screen (its root), the one its read marks are for.
  const threadOnScreen = openThread && openThread.channelId === onScreen ? openThread.rootId : null
  const threadOnScreenRef = useRef<string | null>(null)
  threadOnScreenRef.current = threadOnScreen
  const meRef = useRef<string | null>(null)
  meRef.current = meId
  // Channels whose older messages haven't all been loaded (their last page was full).
  const [more, setMore] = useState<Record<string, boolean>>({})

  // The card's header count: everything unread, threads the person is in included (a muted channel: its mentions only).
  const onCountRef = useRef(onCount)
  onCountRef.current = onCount
  useEffect(() => {
    if (channels) onCountRef.current?.(channels.reduce((n, c) => n + channelHeaderCount(c), 0))
  }, [channels])

  // What is on screen, for the notification context (no toast about a message the person is looking at).
  const viewKey = useRef(Symbol('team-chat-view'))
  useEffect(() => {
    setTeamChatOnScreen(viewKey.current, onScreen ? { channelId: onScreen, threadRootId: threadOnScreen } : null)
  }, [onScreen, threadOnScreen])
  useEffect(() => {
    const key = viewKey.current
    return () => setTeamChatOnScreen(key, null)
  }, [])

  const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members])
  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams])

  const loadChannels = useCallback(async () => {
    try {
      const res = await fetch('/api/account/team-chat/channels')
      if (!res.ok) throw new Error('Could not load team chat')
      const json = (await res.json()) as { channels?: TeamChatChannel[]; threads?: TeamChatThreadUnread[]; memberId?: string }
      // The channel on screen is read (its read mark may still be on its way): never counted unread here. So is the thread open.
      const visible = typeof document !== 'undefined' && document.visibilityState === 'visible'
      const open = visible ? onScreenRef.current : null
      const openRoot = visible ? threadOnScreenRef.current : null
      const unreadList = (Array.isArray(json.threads) ? json.threads : []).filter((t) => t.root_id !== openRoot)
      const list = (Array.isArray(json.channels) ? json.channels : []).map((c) => {
        const inThreads = unreadList.filter((t) => t.channel_id === c.id)
        // A muted channel counts its mentions only (the server's unread is 0 already).
        const threadUnread = c.notify === 'muted' ? 0 : inThreads.reduce((n, t) => n + t.unread, 0)
        const shown = { ...c, thread_unread: threadUnread, thread_mentions: inThreads.reduce((n, t) => n + t.mentions, 0) }
        return c.id === open ? { ...shown, unread: 0, mentions: 0 } : shown
      })
      setMeId(json.memberId ?? null)
      setChannels(list)
      setUnreadThreads(Object.fromEntries(unreadList.map((t) => [t.root_id, t])))
      setError(null)
      setSelectedId((cur) => (cur && list.some((c) => c.id === cur) ? cur : (list.find((c) => c.kind === 'channel') ?? list[0])?.id ?? null))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load team chat')
      setChannels((prev) => prev ?? [])
    }
  }, [])

  /** A page's summaries and reactions into the page's own (the reactions of these messages replaced). */
  const takeExtras = useCallback((ids: readonly string[], summaries: TeamChatThreadSummary[] | undefined, found: TeamChatReaction[] | undefined, foundCalls?: TeamCallView[]) => {
    if (summaries?.length) setThreads((prev) => ({ ...prev, ...Object.fromEntries(summaries.map((t) => [t.root_id, t])) }))
    if (foundCalls?.length) setCalls((prev) => ({ ...prev, ...Object.fromEntries(foundCalls.map((c) => [c.call.id, c])) }))
    setReactions((prev) => {
      const next = { ...prev }
      for (const id of ids) delete next[id]
      for (const r of found ?? []) next[r.message_id] = applyReaction(next[r.message_id], r)
      return next
    })
  }, [])

  // Channels showing a page around an old message that doesn't reach the newest (the server's
  // hasNewer): that page alone, with Jump to newest. Nothing newer is put under it (no gap drawn as unbroken).
  const [windowed, setWindowed] = useState<Record<string, boolean>>({})
  const windowedRef = useRef(windowed)
  windowedRef.current = windowed
  const setWindow = useCallback((channelId: string, on: boolean) => {
    windowedRef.current = { ...windowedRef.current, [channelId]: on }
    setWindowed((prev) => (!!prev[channelId] === on ? prev : { ...prev, [channelId]: on }))
  }, [])

  // The newest page (`fresh`: it replaces a page shown alone); or (`around`, a message's id) the page around
  // that message: on to the newest when that fits (merged), else that page alone.
  const loadMessages = useCallback(
    async (channelId: string, opts: { around?: string; fresh?: boolean } = {}) => {
      const query = opts.around ? `?around=${encodeURIComponent(opts.around)}` : ''
      const res = await fetch(`/api/account/team-chat/channels/${channelId}/messages${query}`)
      if (!res.ok) return
      const json = (await res.json()) as {
        messages?: TeamChatMessage[]
        threads?: TeamChatThreadSummary[]
        reactions?: TeamChatReaction[]
        calls?: TeamCallView[]
        hasOlder?: boolean
        hasNewer?: boolean
      }
      const page = Array.isArray(json.messages) ? json.messages : []
      if (opts.around) {
        const alone = json.hasNewer === true
        setWindow(channelId, alone)
        setMore((prev) => ({ ...prev, [channelId]: alone || prev[channelId] === undefined ? !!json.hasOlder : prev[channelId] || !!json.hasOlder }))
        setMessages((prev) => ({ ...prev, [channelId]: mergePage(prev[channelId], page, alone) }))
      } else {
        // A page shown alone stays until the person jumps to the newest (or sends).
        if (windowedRef.current[channelId] && !opts.fresh) return
        if (opts.fresh) setWindow(channelId, false)
        setMore((prev) => ({ ...prev, [channelId]: page.length >= TEAM_CHAT_PAGE_SIZE }))
        // Keep anything realtime (or an earlier page, or a send on its way) brought in while the page was loading.
        setMessages((prev) => ({ ...prev, [channelId]: mergePage(prev[channelId], page, !!opts.fresh) }))
      }
      takeExtras(
        page.map((m) => m.id),
        json.threads,
        json.reactions,
        json.calls,
      )
    },
    [takeExtras, setWindow],
  )

  // The page before the oldest message shown.
  const loadEarlier = useCallback(
    async (channelId: string, before: string) => {
      const res = await fetch(`/api/account/team-chat/channels/${channelId}/messages?before=${encodeURIComponent(before)}`)
      if (!res.ok) return
      const json = (await res.json()) as { messages?: TeamChatMessage[]; threads?: TeamChatThreadSummary[]; reactions?: TeamChatReaction[]; calls?: TeamCallView[] }
      const page = Array.isArray(json.messages) ? json.messages : []
      setMore((prev) => ({ ...prev, [channelId]: page.length >= TEAM_CHAT_PAGE_SIZE }))
      setMessages((prev) => {
        let list = prev[channelId] ?? []
        for (const m of page) list = upsertMessage(list, m)
        return { ...prev, [channelId]: list }
      })
      takeExtras(
        page.map((m) => m.id),
        json.threads,
        json.reactions,
        json.calls,
      )
    },
    [takeExtras],
  )

  const loadThread = useCallback(
    async (channelId: string, rootId: string) => {
      const res = await fetch(`/api/account/team-chat/channels/${channelId}/messages?thread=${encodeURIComponent(rootId)}`)
      if (!res.ok) return
      const json = (await res.json()) as { root?: TeamChatMessage; messages?: TeamChatMessage[]; reactions?: TeamChatReaction[] }
      const page = Array.isArray(json.messages) ? json.messages : []
      setThreadReplies((prev) => {
        let list: Shown[] = page
        for (const m of prev[rootId] ?? []) if (!list.some((x) => x.id === m.id || (!!m.client_id && x.client_id === m.client_id))) list = upsertMessage(list, m)
        return { ...prev, [rootId]: list }
      })
      if (json.root) {
        const rootRow = json.root
        setMessages((prev) => (prev[channelId] ? { ...prev, [channelId]: upsertMessage(prev[channelId], rootRow) } : prev))
      }
      takeExtras([rootId, ...page.map((m) => m.id)], undefined, json.reactions)
    },
    [takeExtras],
  )

  const markRead = useCallback(async (channelId: string) => {
    setChannels((prev) => prev?.map((c) => (c.id === channelId ? { ...c, unread: 0, mentions: 0 } : c)) ?? prev)
    await fetch(`/api/account/team-chat/channels/${channelId}/read`, { method: 'POST' }).catch(() => null)
  }, [])

  // A thread read: its unread leaves its channel's count too.
  const unreadThreadsRef = useRef(unreadThreads)
  unreadThreadsRef.current = unreadThreads
  const markThreadRead = useCallback((rootId: string) => {
    const was = unreadThreadsRef.current[rootId]
    if (was) {
      unreadThreadsRef.current = { ...unreadThreadsRef.current }
      delete unreadThreadsRef.current[rootId]
      setUnreadThreads((prev) => {
        if (!prev[rootId]) return prev
        const next = { ...prev }
        delete next[rootId]
        return next
      })
      setChannels(
        (list) =>
          list?.map((c) => (c.id === was.channel_id ? { ...c, thread_unread: Math.max(0, c.thread_unread - was.unread), thread_mentions: Math.max(0, c.thread_mentions - was.mentions) } : c)) ?? list,
      )
    }
    void fetch(`/api/account/team-chat/threads/${rootId}/read`, { method: 'POST' }).catch(() => null)
  }, [])

  useEffect(() => {
    void loadChannels()
  }, [loadChannels, workspaceId])

  // Asked to open somewhere: the channel, or the message (in its channel or its thread), its page loaded from it on.
  const focusType = focus?.type ?? null
  const focusId = focus?.id ?? null
  useEffect(() => {
    if (!focusType || !focusId) return
    if (focusType === 'channel') {
      setSelectedId(focusId)
      setOpened(true)
      setOpenThread(null)
      return
    }
    let alive = true
    void (async () => {
      const res = await fetch(`/api/account/team-chat/messages/${focusId}`).catch(() => null)
      if (!alive || !res?.ok) return
      const json = (await res.json().catch(() => null)) as { message?: TeamChatMessage; root?: TeamChatMessage | null } | null
      const m = json?.message
      if (!alive || !m) return
      const rootId = m.thread_root_id
      setSelectedId(m.channel_id)
      setOpened(true)
      setOpenThread(rootId ? { channelId: m.channel_id, rootId } : null)
      setFocused({ id: m.id, channelId: m.channel_id, rootId, shown: false })
      // The page around it (a reply's thread hangs off its root: the page around the root), however old.
      await loadMessages(m.channel_id, { around: rootId ?? m.id })
    })()
    return () => {
      alive = false
    }
  }, [focusType, focusId, loadMessages])
  // Lit for a moment once its pane has scrolled to it; given up on if it never shows (too old, or gone).
  useEffect(() => {
    if (!focused) return
    const timer = setTimeout(() => setFocused(null), focused.shown ? FOCUS_LIT_MS : FOCUS_GIVE_UP_MS)
    return () => clearTimeout(timer)
  }, [focused])
  const onFocusShown = useCallback(() => setFocused((f) => (f && !f.shown ? { ...f, shown: true } : f)), [])

  // How loud a channel is (migration 560): at once, then the server's word; the list again for its counts.
  const channelsRef = useRef(channels)
  channelsRef.current = channels
  const setNotify = useCallback(
    async (channelId: string, level: TeamChatNotifyLevel) => {
      const before = channelsRef.current?.find((c) => c.id === channelId)?.notify
      setChannels((prev) => prev?.map((c) => (c.id === channelId ? { ...c, notify: level } : c)) ?? prev)
      const res = await fetch(`/api/account/team-chat/channels/${channelId}/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level }),
      }).catch(() => null)
      if (!res?.ok) {
        if (before) setChannels((prev) => prev?.map((c) => (c.id === channelId ? { ...c, notify: before } : c)) ?? prev)
        return
      }
      void loadChannels()
    },
    [loadChannels],
  )

  useEffect(() => {
    if (!workspaceId) return
    let alive = true
    void cachedJson<{ members?: Member[] }>('/api/account/workspace/members', { scope: workspaceId }).then((json) => {
      if (alive) setMembers(Array.isArray(json?.members) ? json.members : [])
    })
    return () => {
      alive = false
    }
  }, [workspaceId])

  // Picking a channel loads it; on screen, it is read.
  useEffect(() => {
    if (!selectedId) return
    void loadMessages(selectedId)
  }, [selectedId, loadMessages])
  useEffect(() => {
    if (!onScreen) return
    void markRead(onScreen)
  }, [onScreen, markRead])
  // Opening a thread loads it and reads it.
  useEffect(() => {
    if (!openThread) return
    void loadThread(openThread.channelId, openThread.rootId)
  }, [openThread, loadThread])
  useEffect(() => {
    if (threadOnScreen) markThreadRead(threadOnScreen)
  }, [threadOnScreen, markThreadRead])

  // Coming back to the tab reads the channel (and the thread) on screen (what arrived while away was left unread).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const open = onScreenRef.current
      if (open) void markRead(open)
      const root = threadOnScreenRef.current
      if (root) markThreadRead(root)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [markRead, markThreadRead])

  // Live: one channel for the workspace; RLS filters what arrives.
  useEffect(() => {
    if (!workspaceId) return
    const supabase = createClient()
    let listTimer: ReturnType<typeof setTimeout> | null = null
    let readTimer: ReturnType<typeof setTimeout> | null = null
    let threadReadTimer: ReturnType<typeof setTimeout> | null = null
    const refreshList = () => {
      if (listTimer) clearTimeout(listTimer)
      listTimer = setTimeout(() => void loadChannels(), 400)
    }
    const instance = Math.random().toString(36).slice(2, 10)
    const channel = supabase
      .channel(`team-chat:${workspaceId}:${instance}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_chat_message', filter: `workspace_id=eq.${workspaceId}` }, (payload) => {
        const row = payload.new as TeamChatMessage | undefined
        if (!row?.id || !row.channel_id) return
        const shown: Shown = { ...row, attachments: row.attachments ?? [], link_preview: row.link_preview ?? null, thread_root_id: row.thread_root_id ?? null, client_id: row.client_id ?? null }
        const root = shown.thread_root_id
        if (root) {
          setThreadReplies((prev) => (prev[root] ? { ...prev, [root]: upsertMessage(prev[root], shown) } : prev))
        } else {
          // A page shown alone (an old message's) takes nothing newer under it: Jump to newest brings it.
          setMessages((prev) => (prev[row.channel_id] && !windowedRef.current[row.channel_id] ? { ...prev, [row.channel_id]: upsertMessage(prev[row.channel_id], shown) } : prev))
        }
        // Only the person's own agent's new reply ends their "looking into it" line (in the channel, or the thread).
        if (payload.eventType === 'INSERT' && row.author_kind === 'agent' && row.agent_for_member_id && row.agent_for_member_id === meRef.current) {
          const place = placeOf(shown)
          setWaitingOnAgent((prev) => {
            if (!prev[place]) return prev
            const next = { ...prev }
            delete next[place]
            return next
          })
        }
        if (payload.eventType !== 'INSERT') return
        const visible = document.visibilityState === 'visible'
        if (root) {
          // A thread's reply: read at once in the open thread; anywhere else it may be unread for the person (if they are in it).
          if (root === threadOnScreenRef.current && visible) {
            if (threadReadTimer) clearTimeout(threadReadTimer)
            threadReadTimer = setTimeout(() => markThreadRead(root), 150)
          } else if (!(row.author_kind === 'member' && row.author_member_id === meRef.current)) {
            refreshList()
          }
          return
        }
        if (row.channel_id === onScreenRef.current && visible) {
          // A burst of messages is one read mark.
          if (readTimer) clearTimeout(readTimer)
          readTimer = setTimeout(() => void markRead(row.channel_id), 150)
        } else {
          refreshList()
        }
        setChannels((prev) => prev?.map((c) => (c.id === row.channel_id ? { ...c, last_message_at: row.created_at } : c)) ?? prev)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_chat_thread', filter: `workspace_id=eq.${workspaceId}` }, (payload) => {
        const row = payload.new as TeamChatThreadSummary | undefined
        if (!row?.root_id) return
        setThreads((prev) => ({ ...prev, [row.root_id]: { root_id: row.root_id, channel_id: row.channel_id, reply_count: row.reply_count, last_reply_at: row.last_reply_at, participant_ids: row.participant_ids ?? [] } }))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_chat_reaction', filter: `workspace_id=eq.${workspaceId}` }, (payload) => {
        const row = payload.new as TeamChatReaction | undefined
        if (!row?.message_id || !row.member_id || !row.emoji) return
        setReactions((prev) => ({ ...prev, [row.message_id]: applyReaction(prev[row.message_id], { message_id: row.message_id, member_id: row.member_id, emoji: row.emoji, active: !!row.active }) }))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_chat_channel', filter: `workspace_id=eq.${workspaceId}` }, (payload) => {
        // Every message bumps its channel's last_message_at: patch that in place rather than
        // refetching the list (and its unread counts) once per message per person.
        const row = payload.new as Partial<TeamChatChannel> & { id?: string }
        if (payload.eventType === 'UPDATE' && row?.id) {
          // Archived: gone from the list, and if it was the one open, another is picked (loadChannels).
          if (row.archived_at && row.id === selectedRef.current) refreshList()
          setChannels((prev) => {
            if (!prev?.some((c) => c.id === row.id)) return prev
            if (row.archived_at) return prev.filter((c) => c.id !== row.id)
            return prev.map((c) => (c.id === row.id ? { ...c, name: row.name ?? c.name, topic: row.topic ?? c.topic, last_message_at: row.last_message_at ?? c.last_message_at } : c))
          })
          return
        }
        refreshList()
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          void loadChannels()
          if (selectedRef.current) void loadMessages(selectedRef.current)
        }
      })
    return () => {
      if (listTimer) clearTimeout(listTimer)
      if (readTimer) clearTimeout(readTimer)
      if (threadReadTimer) clearTimeout(threadReadTimer)
      void supabase.removeChannel(channel)
    }
  }, [workspaceId, loadChannels, loadMessages, markRead, markThreadRead])

  // Calls (migration 564), live, only where calling is on: their state and who is in them, for their messages.
  useEffect(() => {
    if (!workspaceId || !teamCalls.available) return
    const supabase = createClient()
    const channel = supabase
      .channel(`team-calls:${workspaceId}:${Math.random().toString(36).slice(2, 10)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_call', filter: `workspace_id=eq.${workspaceId}` }, (payload) => {
        const row = payload.new as TeamCall | undefined
        if (!row?.id) return
        setCalls((prev) => ({ ...prev, [row.id]: { call: { ...row, ringing: row.ringing ?? [], declined: row.declined ?? [] }, participants: prev[row.id]?.participants ?? [] } }))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_call_participant', filter: `workspace_id=eq.${workspaceId}` }, (payload) => {
        const row = payload.new as TeamCallParticipant | undefined
        if (!row?.call_id || !row.member_id) return
        setCalls((prev) => (prev[row.call_id] ? { ...prev, [row.call_id]: { ...prev[row.call_id], participants: upsertParticipant(prev[row.call_id].participants, row) } } : prev))
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED' && selectedRef.current) void loadMessages(selectedRef.current)
      })
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [workspaceId, teamCalls.available, loadMessages])

  // The "thinking" line gives up after a while (the reply may have gone to their own chat).
  useEffect(() => {
    const ids = Object.keys(waitingOnAgent)
    if (ids.length === 0) return
    const soonest = Math.min(...ids.map((id) => waitingOnAgent[id]))
    const timer = setTimeout(() => {
      const now = Date.now()
      setWaitingOnAgent((prev) => Object.fromEntries(Object.entries(prev).filter(([, at]) => now - at < AGENT_WAIT_MS)))
    }, Math.max(0, soonest + AGENT_WAIT_MS - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [waitingOnAgent])

  // ── Typing, on the channel on screen ──────────────────────────────────────
  const [typers, setTypers] = useState<Record<string, { thread: string | null; until: number }>>({})
  const typingRef = useRef<ReturnType<typeof joinTyping> | null>(null)
  const lastTyping = useRef<{ thread: string | null; at: number }>({ thread: null, at: 0 })
  useEffect(() => {
    if (!onScreen || !meId) return
    const joined = joinTyping(onScreen, (signal) => {
      if (signal.member_id === meRef.current) return
      setTypers((prev) => {
        const next = { ...prev }
        if (signal.typing) next[signal.member_id] = { thread: signal.thread, until: Date.now() + TYPING_SHOW_MS }
        else delete next[signal.member_id]
        return next
      })
    })
    typingRef.current = joined
    return () => {
      joined.leave()
      typingRef.current = null
      lastTyping.current = { thread: null, at: 0 }
      setTypers({})
    }
  }, [onScreen, meId])
  // Each typer goes when their last word is TYPING_SHOW_MS old: one timer, for the soonest.
  useEffect(() => {
    const until = Object.values(typers).map((t) => t.until)
    if (until.length === 0) return
    const timer = setTimeout(() => {
      const now = Date.now()
      setTypers((prev) => Object.fromEntries(Object.entries(prev).filter(([, t]) => t.until > now)))
    }, Math.max(0, Math.min(...until) - Date.now()) + 30)
    return () => clearTimeout(timer)
  }, [typers])
  // The person's own: at most one "typing" per TYPING_THROTTLE_MS per place, and one "stopped".
  const notifyTyping = useCallback((thread: string | null, typing: boolean) => {
    const me = meRef.current
    const joined = typingRef.current
    if (!me || !joined) return
    const now = Date.now()
    const last = lastTyping.current
    if (typing) {
      if (last.at && last.thread === thread && now - last.at < TYPING_THROTTLE_MS) return
      lastTyping.current = { thread, at: now }
    } else {
      if (!last.at) return
      lastTyping.current = { thread: null, at: 0 }
    }
    joined.send({ member_id: me, thread, typing })
  }, [])
  const typingFor = useCallback(
    (thread: string | null): string | null =>
      typingLine(
        Object.entries(typers)
          .filter(([, t]) => t.thread === thread)
          .map(([id]) => memberName(membersById.get(id))),
      ),
    [typers, membersById],
  )

  const selected = channels?.find((c) => c.id === selectedId) ?? null
  const channelList = (channels ?? []).filter((c) => c.kind === 'channel')
  const dmList = (channels ?? []).filter((c) => c.kind === 'dm')
  // Meeting links' conversations (phase 7), once used; only where calling is on.
  const meetingList = teamCalls.available ? (channels ?? []).filter((c) => c.kind === 'meeting') : []

  const channelTitle = useCallback(
    (c: TeamChatChannel): string => {
      if (c.kind === 'channel') return c.name ?? 'channel'
      if (c.kind === 'meeting') return c.name ?? 'Meeting'
      if (c.dm_member_id && c.dm_member_id === meId) return `${memberName(membersById.get(c.dm_member_id))} (you)`
      return memberName(c.dm_member_id ? membersById.get(c.dm_member_id) : undefined)
    },
    [meId, membersById],
  )

  const openDm = useCallback(
    async (memberId: string) => {
      setNewDmOpen(false)
      const res = await fetch('/api/account/team-chat/dm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ memberId }),
      })
      if (!res.ok) return
      const json = (await res.json()) as { id?: string }
      await loadChannels()
      if (json.id) {
        setSelectedId(json.id)
        setOpened(true)
      }
    },
    [loadChannels],
  )

  // The person picks a channel (from the list): on a phone, it takes the screen.
  const openChannel = useCallback((id: string) => {
    setSelectedId(id)
    setOpened(true)
  }, [])
  // What the card has and where it is, for the page's sub-nav (Liam, 11-11):
  // the conversations as this list draws them (current with every realtime
  // change), the one on screen, and its moves: the same openChannel, the
  // same New channel and New message dialogs.
  const panelConversations = useMemo<TeamChatPanelConversation[]>(
    () =>
      (channels ?? [])
        .filter((c) => c.kind !== 'meeting' || teamCalls.available)
        .map((c) => {
          const person = c.kind === 'dm' && c.dm_member_id ? membersById.get(c.dm_member_id) : undefined
          const team = c.team_id ? teamsById.get(c.team_id) : undefined
          return {
            channel: c,
            title: channelTitle(c),
            teamName: team?.name ?? null,
            privateTeam: !!team?.is_private,
            person: c.kind === 'dm' ? { name: memberName(person), url: person?.avatar_url ?? null } : null,
          }
        }),
    [channels, teamCalls.available, membersById, teamsById, channelTitle],
  )
  const onShowCardRef = useRef(onShowCard)
  onShowCardRef.current = onShowCard
  // Said from its first commit, not once its list is read (Liam, 11-11: "it
  // goes away completely and reappears every time"): until then, the last
  // conversations this workspace's card said (kept by the bridge after it
  // went), marked `pending`, so the sub-nav has them and its moves at once;
  // its own read, as before, replaces them.
  useEffect(() => {
    if (!cardId) return
    const pending = channels === null
    publishTeamChatCard({
      cardId,
      workspaceId: workspaceId ?? null,
      conversations: pending ? (lastTeamChat(workspaceId ?? null)?.conversations ?? []) : panelConversations,
      pending,
      openId: onScreen,
      open: openChannel,
      newChannel: (teamId) => {
        setNewChannelTeam(teamId)
        setNewChannelOpen(true)
      },
      newDm: () => setNewDmOpen(true),
      newMeeting: teamCalls.available ? () => setNewMeetingOpen(true) : null,
      show: () => onShowCardRef.current?.(),
    })
  }, [cardId, channels, workspaceId, panelConversations, onScreen, openChannel, teamCalls.available])
  useEffect(() => {
    if (!cardId) return
    return () => unpublishTeamChatCard(cardId)
  }, [cardId])

  // Back to the list (a phone): the focus goes to the channel's row, where they were.
  const backToList = useCallback(() => {
    setOpened(false)
    const id = selectedRef.current
    requestAnimationFrame(() => {
      if (id) rootRef.current?.querySelector<HTMLElement>(`[data-team-chat-row="${id}"]`)?.focus({ preventScroll: true })
    })
  }, [])

  /** A message into its list: its thread's, or its channel's. */
  const place = useCallback((m: Shown) => {
    const root = m.thread_root_id
    if (root) setThreadReplies((prev) => ({ ...prev, [root]: upsertMessage(prev[root], m) }))
    else setMessages((prev) => ({ ...prev, [m.channel_id]: upsertMessage(prev[m.channel_id], m) }))
  }, [])

  // ── Sending: the bubble at once, the row when it comes ────────────────────
  const drafts = useRef(new Map<string, TeamChatSendDraft>())
  const sendDraft = useCallback(
    async (draft: TeamChatSendDraft) => {
      drafts.current.set(draft.clientId, draft)
      // Sending from a page shown alone (an old message's): the newest first, so the bubble lands at the end of now.
      if (!draft.threadRootId && windowedRef.current[draft.channelId]) await loadMessages(draft.channelId, { fresh: true })
      place({
        id: pendingMessageId(draft.clientId),
        client_id: draft.clientId,
        channel_id: draft.channelId,
        author_kind: 'member',
        author_member_id: meRef.current,
        agent_for_member_id: null,
        agent_name: null,
        in_reply_to: null,
        thread_root_id: draft.threadRootId,
        body: draft.body,
        mentions: draft.mentions,
        mentions_agent: draft.mentionsAgent,
        record_mentions: draft.records,
        attachments: draft.attachments,
        link_preview: null,
        created_at: new Date().toISOString(),
        edited_at: null,
        deleted_at: null,
        pending: 'sending',
      })
      try {
        const res = await fetch(`/api/account/team-chat/channels/${draft.channelId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            body: draft.body,
            mentions: draft.mentions,
            mentionsAgent: draft.mentionsAgent,
            ...(draft.records.length ? { records: draft.records } : {}),
            ...(draft.threadRootId ? { thread: draft.threadRootId } : {}),
            ...(draft.attachments.length ? { attachments: draft.attachments } : {}),
            clientId: draft.clientId,
          }),
        })
        if (!res.ok) throw new Error('send failed')
        const json = (await res.json()) as { message?: TeamChatMessage; replayed?: boolean }
        drafts.current.delete(draft.clientId)
        if (!json.message) return
        const sent: Shown = { ...json.message, client_id: json.message.client_id ?? draft.clientId }
        place(sent)
        if (sent.mentions_agent && !json.replayed) setWaitingOnAgent((prev) => ({ ...prev, [placeOf(sent)]: Date.now() }))
        // A record the channel couldn't all see, now shared with it: say so, with Undo.
        const { shared, sharedWith } = parseSharedRecords(json)
        toastSharedRecords(shared, sharedWith)
      } catch {
        const fail = (list: Shown[] | undefined) => failPending(list, draft.clientId)
        if (draft.threadRootId) {
          const root = draft.threadRootId
          setThreadReplies((prev) => ({ ...prev, [root]: fail(prev[root]) }))
        } else {
          setMessages((prev) => ({ ...prev, [draft.channelId]: fail(prev[draft.channelId]) }))
        }
      }
    },
    [place, loadMessages],
  )
  // Retry: the same send again, with the same client id (the server answers with the row if the first one made it).
  const retry = useCallback(
    (clientId: string) => {
      const draft = drafts.current.get(clientId)
      if (draft) void sendDraft(draft)
    },
    [sendDraft],
  )

  const handleChanged = useCallback((message: Shown) => place(message), [place])

  // ── Reactions: at once, then the server's word ────────────────────────────
  const react = useCallback(async (messageId: string, emoji: string, on: boolean) => {
    const me = meRef.current
    if (!me) return
    const mine = { message_id: messageId, member_id: me, emoji, active: on }
    setReactions((prev) => ({ ...prev, [messageId]: applyReaction(prev[messageId], mine) }))
    const res = await fetch(`/api/account/team-chat/messages/${messageId}/reactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emoji, on }),
    }).catch(() => null)
    if (!res?.ok) setReactions((prev) => ({ ...prev, [messageId]: applyReaction(prev[messageId], { ...mine, active: !on }) }))
  }, [])

  const openThreadOf = useCallback((channelId: string, rootId: string) => setOpenThread({ channelId, rootId }), [])
  const closeThread = useCallback(() => setOpenThread(null), [])

  const list = (
    <aside className={cn('flex min-h-0 flex-col', narrow ? (showList ? 'h-full w-full' : 'hidden') : 'h-full w-full')}>
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h1 className="text-[15px] font-semibold text-foreground">Team chat</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {/* On a phone the list stands alone: a failed load says so here, not only in the hidden pane. */}
        {narrow && error && <p className="px-3 py-1.5 text-xs text-destructive">{error}</p>}
        <SectionHeading label="Channels" onAdd={() => setNewChannelOpen(true)} addLabel="New channel" />
        {channels === null ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">Loading…</p>
        ) : channelList.length === 0 ? (
          <button type="button" onClick={() => setNewChannelOpen(true)} className="flex h-10 w-full items-center rounded-xl px-3 text-left text-sm text-muted-foreground hover:bg-accent/60">
            Start your first channel
          </button>
        ) : (
          channelList.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              title={channelTitle(c)}
              active={c.id === onScreen}
              privateTeam={!!c.team_id && !!teamsById.get(c.team_id)?.is_private}
              onSelect={() => openChannel(c.id)}
            />
          ))
        )}
        <SectionHeading label="Direct messages" onAdd={() => setNewDmOpen(true)} addLabel="New message" className="mt-5" />
        {dmList.map((c) => {
          const person = c.dm_member_id ? membersById.get(c.dm_member_id) : undefined
          return (
            <ChannelRow
              key={c.id}
              channel={c}
              title={channelTitle(c)}
              avatar={{ name: memberName(person), url: person?.avatar_url }}
              active={c.id === onScreen}
              onSelect={() => openChannel(c.id)}
            />
          )
        })}
        {teamCalls.available && (
          <>
            <SectionHeading label="Meetings" onAdd={() => setNewMeetingOpen(true)} addLabel="New meeting link" className="mt-5" />
            {meetingList.map((c) => (
              <ChannelRow key={c.id} channel={c} title={channelTitle(c)} active={c.id === onScreen} onSelect={() => openChannel(c.id)} />
            ))}
          </>
        )}
      </div>
    </aside>
  )

  const threadRoot = threadOnScreen && selected ? (messages[selected.id] ?? []).find((m) => m.id === threadOnScreen) : undefined
  const common = {
    meId,
    members,
    membersById,
    assistantName,
    reactions,
    onReact: react,
    onRetry: retry,
    onChanged: handleChanged,
    onSend: sendDraft,
    onTyping: notifyTyping,
    calls,
  }

  const pane = (
    <section ref={sectionRef} className={cn('h-full min-h-0 min-w-0 flex-1 flex-col', showChannel ? 'flex' : 'hidden')}>
      {!showChannel ? null : error && !selected ? (
        <p className="py-10 text-center text-sm text-destructive">{error}</p>
      ) : !selected ? (
        channels === null ? null : <EmptyState onCreate={() => setNewChannelOpen(true)} />
      ) : (
        <div className="flex h-full min-h-0">
          {/* With a thread open where there's no room beside it, the thread takes the channel's place (Back returns). */}
          <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', threadOnScreen && threadOver && 'hidden')}>
            <ChannelPane
              key={selected.id}
              channel={selected}
              title={channelTitle(selected)}
              dmPerson={selected.kind === 'dm' && selected.dm_member_id ? membersById.get(selected.dm_member_id) : undefined}
              teamName={selected.team_id ? (teamsById.get(selected.team_id)?.name ?? null) : null}
              messages={messages[selected.id] ?? null}
              threads={threads}
              unreadThreads={unreadThreads}
              openThreadId={threadOnScreen}
              onOpenThread={(rootId) => openThreadOf(selected.id, rootId)}
              waitingOnAgent={!!waitingOnAgent[selected.id]}
              typing={typingFor(null)}
              hasMore={!!more[selected.id]}
              onLoadEarlier={(before) => loadEarlier(selected.id, before)}
              windowed={!!windowed[selected.id]}
              onJumpToNewest={() => void loadMessages(selected.id, { fresh: true })}
              onBack={narrow && !listInPanel ? backToList : undefined}
              onNotify={(level) => void setNotify(selected.id, level)}
              focusId={focused && !focused.rootId && focused.channelId === selected.id ? focused.id : null}
              onFocusShown={onFocusShown}
              {...common}
            />
          </div>
          {threadOnScreen && (
            <div
              data-team-chat-thread-pane=""
              className={cn('flex min-h-0 flex-col', threadOver ? 'w-full flex-1' : 'w-[min(400px,42%)] shrink-0 rounded-l-3xl bg-muted/40')}
            >
              <ThreadPane
                key={threadOnScreen}
                channel={selected}
                title={channelTitle(selected)}
                rootId={threadOnScreen}
                root={threadRoot}
                replies={threadReplies[threadOnScreen] ?? null}
                waitingOnAgent={!!waitingOnAgent[threadOnScreen]}
                typing={typingFor(threadOnScreen)}
                onClose={closeThread}
                over={threadOver}
                focusId={focused && focused.rootId === threadOnScreen ? focused.id : null}
                onFocusShown={onFocusShown}
                {...common}
              />
            </div>
          )}
        </div>
      )}
    </section>
  )

  return (
    <div
      ref={rootRef}
      data-team-chat-panes={listInPanel ? 'channel' : narrow ? (openedNow ? 'channel' : 'list') : 'both'}
      className="flex h-full min-h-0"
    >
      {/* The list and the messages split as Mail's are, by a line with a
          grip that resizes them (Liam, 11-09: "the same type of divider that
          we have for the main page"). Beside the sub-nav (listInPanel) the
          list isn't there at all: no panel, no divider. Narrow (a phone), one
          pane at a time: the other panel hidden (the `hidden` attribute,
          which the panel's inline display can't override) and no divider.
          One tree throughout (the channel's panel keeps its place among the
          group's children), so crossing a width keeps the open channel as it
          was: its draft, an edit, where it was scrolled to, the focus.
          With one pane on screen the group is disabled, its cursor too
          (Liam, 11-11: "when I hover over the teams panel my coursor turns
          into the resize tool even if I'm not trying to resize"): a hidden
          panel stays registered with a zero box at the window's corner, and
          the library's divider hit region then ran from the window's left
          edge to the visible pane, over the rail and the sub-nav, setting a
          document-wide `ew-resize` cursor and taking a press there as a
          resize. Only a real divider between two panes on screen resizes. */}
      <ResizablePanelGroup orientation="horizontal" disabled={onePane} disableCursor={onePane} className="min-h-0 flex-1">
        {listInPanel ? null : (
          <ResizablePanel
            id="team-chat-list"
            hidden={narrow && !showList}
            defaultSize={compact ? '32%' : '26%'}
            minSize={compact ? '176px' : '18%'}
            maxSize="45%"
            className="flex min-h-0 flex-col"
          >
            {list}
          </ResizablePanel>
        )}
        {onePane ? null : <ResizableHandle withHandle />}
        <ResizablePanel id="team-chat-channel" hidden={narrow && !showChannel} minSize="40%" className="flex min-h-0 min-w-0 flex-col">
          {pane}
        </ResizablePanel>
      </ResizablePanelGroup>

      <NewChannelDialog
        open={newChannelOpen}
        onOpenChange={(open) => {
          setNewChannelOpen(open)
          if (!open) setNewChannelTeam(null)
        }}
        teamId={newChannelTeam}
        teams={teams.map((t) => ({ id: t.id, name: t.name }))}
        onCreated={async (id) => {
          setNewChannelOpen(false)
          setNewChannelTeam(null)
          await loadChannels()
          openChannel(id)
        }}
      />
      <NewDmDialog open={newDmOpen} onOpenChange={setNewDmOpen} members={members} meId={meId} onPick={openDm} />
      {teamCalls.available && (
        <NewMeetingDialog
          open={newMeetingOpen}
          onOpenChange={setNewMeetingOpen}
          onOpenMeeting={(m) => {
            setNewMeetingOpen(false)
            // The call's message makes the conversation used: it shows in the list once the call starts.
            void teamCalls.startCall({ id: m.channelId, kind: 'meeting', label: m.title }).then(async () => {
              await loadChannels()
              openChannel(m.channelId)
            })
          }}
        />
      )}
    </div>
  )
}

function SectionHeading({ label, onAdd, addLabel, className }: { label: string; onAdd: () => void; addLabel: string; className?: string }) {
  return (
    <div className={cn('flex h-8 items-center justify-between pl-3 pr-1.5', className)}>
      <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
      <button type="button" onClick={onAdd} aria-label={addLabel} title={addLabel} className="rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
        <Plus className="h-4 w-4" />
      </button>
    </div>
  )
}

function ChannelRow({
  channel,
  title,
  avatar,
  active,
  privateTeam,
  onSelect,
}: {
  channel: TeamChatChannel
  title: string
  /** A direct message's other person (their photo, else their initials). */
  avatar?: { name: string; url?: string | null }
  active: boolean
  privateTeam?: boolean
  onSelect: () => void
}) {
  // The channel's own unread, and the replies unread in its threads the person is in (a muted one: its mentions only).
  const { count, mentions } = channelBadge(channel)
  const unread = count > 0 && !active
  const muted = channel.notify === 'muted'
  return (
    <button
      type="button"
      data-team-chat-row={channel.id}
      onClick={onSelect}
      className={cn(
        'flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[15px]',
        active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        unread && 'font-semibold text-foreground',
      )}
    >
      {channel.kind === 'channel' ? (
        privateTeam ? <Lock className="h-4 w-4 shrink-0 opacity-70" /> : <Hash className="h-4 w-4 shrink-0 opacity-70" />
      ) : channel.kind === 'meeting' ? (
        <Video className="h-4 w-4 shrink-0 opacity-70" />
      ) : (
        <Avatar name={avatar?.name ?? title} url={avatar?.url} size="sm" />
      )}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {mentions > 0 && !active && (unread || muted) ? (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground" title={`${mentions} mention${mentions === 1 ? '' : 's'}`}>
          @{mentions}
        </span>
      ) : unread ? (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-muted-foreground/20 px-1.5 text-[11px] font-semibold text-foreground">{count}</span>
      ) : muted ? (
        <BellOff className="h-3.5 w-3.5 shrink-0 opacity-60" aria-label="Muted" />
      ) : null}
    </button>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
      <MessageSquare className="h-7 w-7 text-muted-foreground/60" />
      <div>
        <p className="text-sm font-medium text-foreground">No channels yet</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">Talk with your team next to your email, meetings and tasks. @-mention your agent to bring it in.</p>
      </div>
      <Button size="sm" variant="outline" onClick={onCreate}>
        <Plus className="h-3.5 w-3.5" />
        New channel
      </Button>
    </div>
  )
}

/** What the channel's pane and a thread's pane both take from the view. */
interface PaneShared {
  meId: string | null
  members: Member[]
  membersById: Map<string, Member>
  assistantName: string
  reactions: Record<string, TeamChatReaction[]>
  onReact: (messageId: string, emoji: string, on: boolean) => void
  onRetry: (clientId: string) => void
  onChanged: (message: Shown) => void
  onSend: (draft: TeamChatSendDraft) => void
  onTyping: (thread: string | null, typing: boolean) => void
  /** The calls the conversation's call messages show (migration 564). */
  calls: Record<string, TeamCallView>
}

/** Edit and delete, the same in a channel and a thread. */
function useMessageEditing(onChanged: (message: Shown) => void) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const remove = useCallback(
    async (m: Shown) => {
      const res = await fetch(`/api/account/team-chat/messages/${m.id}`, { method: 'DELETE' })
      if (res.ok) onChanged({ ...m, body: '', mentions: [], attachments: [], link_preview: null, deleted_at: new Date().toISOString() })
    },
    [onChanged],
  )
  return { editingId, setEditingId, remove }
}

/** The labels a message's @-mentions show, for drawing them. */
function useMentionLabels(membersById: Map<string, Member>, meId: string | null, assistantName: string) {
  return useCallback(
    (m: TeamChatMessage): string[] => {
      const labels = m.mentions.map((id) => memberName(membersById.get(id)))
      // The author's own agent, by the name it goes by for them (only the person's own is known here).
      if (m.mentions_agent && m.author_member_id === meId) labels.push(assistantName)
      return labels
    },
    [membersById, meId, assistantName],
  )
}

/** Who reacted, by name, for a chip's title. */
function useReactorNames(membersById: Map<string, Member>, meId: string | null) {
  return useCallback((ids: readonly string[]) => ids.map((id) => (id === meId ? 'You' : memberName(membersById.get(id)))).join(', '), [membersById, meId])
}

function ChannelPane({
  channel,
  title,
  dmPerson,
  teamName,
  messages,
  threads,
  unreadThreads,
  openThreadId,
  onOpenThread,
  waitingOnAgent,
  typing,
  hasMore,
  onLoadEarlier,
  windowed,
  onJumpToNewest,
  onBack,
  onNotify,
  focusId,
  onFocusShown,
  meId,
  members,
  membersById,
  assistantName,
  reactions,
  onReact,
  onRetry,
  onChanged,
  onSend,
  onTyping,
  calls,
}: PaneShared &
  FocusProps & {
  channel: TeamChatChannel
  title: string
  /** How loud it is for the person: the header's menu sets it. */
  onNotify: (level: TeamChatNotifyLevel) => void
  /** It shows a page around an old message alone (nothing newer under it): Jump to newest. */
  windowed: boolean
  onJumpToNewest: () => void
  /** A direct message's other person, for the avatar beside their name. */
  dmPerson?: Member
  teamName: string | null
  messages: Shown[] | null
  threads: Record<string, TeamChatThreadSummary>
  unreadThreads: Record<string, TeamChatThreadUnread>
  /** The thread open beside it, if any (its root). */
  openThreadId: string | null
  onOpenThread: (rootId: string) => void
  waitingOnAgent: boolean
  /** "Rosa is typing…" in the channel itself, or null. */
  typing: string | null
  hasMore: boolean
  onLoadEarlier: (before: string) => Promise<void>
  /** One pane at a time (a phone): back to the list of channels. */
  onBack?: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Opened on a phone (it takes the screen): the focus starts on Back, the
  // list's button it replaced being gone. Only as it opens: a channel already
  // on screen when the view narrows keeps the focus where it was (its box).
  const backRef = useRef<HTMLButtonElement>(null)
  const backFirst = useRef(!!onBack)
  useEffect(() => {
    if (backFirst.current) backRef.current?.focus({ preventScroll: true })
  }, [])
  const { editingId, setEditingId, remove } = useMessageEditing(onChanged)
  const [loadingEarlier, setLoadingEarlier] = useState(false)

  // Stay at the bottom as messages arrive (a new last message), never when older ones are loaded above,
  // nor while a message it was opened on is being brought into view.
  const lastKey = messages?.at(-1) ? messageKey(messages.at(-1)!) : null
  useEffect(() => {
    const el = scrollRef.current
    if (el && !focusId) el.scrollTop = el.scrollHeight
  }, [lastKey, waitingOnAgent, focusId])
  useScrollToFocus(scrollRef, focusId, messages, onFocusShown)

  const earlier = async () => {
    const oldest = messages?.find((m) => !m.pending)
    const el = scrollRef.current
    if (!oldest || loadingEarlier) return
    setLoadingEarlier(true)
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0
    await onLoadEarlier(oldest.created_at)
    setLoadingEarlier(false)
    // Keep the message they were reading where it was.
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - fromBottom
    })
  }

  const labelsFor = useMentionLabels(membersById, meId, assistantName)
  const reactorNames = useReactorNames(membersById, meId)
  const placeholder = channel.kind === 'channel' ? `Message #${title}` : `Message ${title}`
  const archived = !!channel.archived_at
  const meetingBar = useTeamCalls().available

  return (
    <>
      {/* No rule under the channel's name (Liam, 11-09: no visible divider lines). */}
      <div className={cn('flex h-14 shrink-0 items-center gap-2', onBack ? 'pl-2 pr-4' : 'px-5')}>
        {onBack && (
          <button
            ref={backRef}
            type="button"
            onClick={onBack}
            aria-label="All channels"
            title="All channels"
            data-team-chat-back=""
            className="-ml-0.5 rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        {channel.kind === 'channel' ? (
          <Hash className="h-5 w-5 shrink-0 text-muted-foreground" />
        ) : channel.kind === 'meeting' ? (
          <Video className="h-5 w-5 shrink-0 text-muted-foreground" />
        ) : (
          <Avatar name={memberName(dmPerson)} url={dmPerson?.avatar_url} size="sm" />
        )}
        <h2 className="truncate text-lg font-bold text-foreground">{title}</h2>
        {teamName && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            <Users className="h-3 w-3" />
            {teamName}
          </span>
        )}
        {channel.topic && <span className="min-w-0 truncate text-sm text-muted-foreground">{channel.topic}</span>}
        <span className="ml-auto" aria-hidden />
        <CallButton channel={channel} label={channel.kind === 'channel' ? `#${title}` : title} />
        <NotifyMenu kind={channel.kind} level={channel.notify} onChange={onNotify} />
      </div>
      {channel.kind === 'meeting' && meetingBar && (
        <MeetingLinkBar channelId={channel.id} meId={meId} live={Object.values(calls).some((c) => c.call.channel_id === channel.id && c.call.status === 'live')} />
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {messages === null ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : messages.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-[15px] font-semibold text-foreground">
              {channel.kind === 'channel' ? `This is the start of #${title}` : channel.kind === 'meeting' ? `This is the start of ${title}` : `This is the start of your messages with ${title}`}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">Type @{assistantName} to ask your agent; it answers here with what the channel has said.</p>
          </div>
        ) : (
          <>
            {hasMore && (
              <div className="mb-2 flex justify-center">
                <Button size="sm" variant="ghost" onClick={() => void earlier()} disabled={loadingEarlier}>
                  {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
                </Button>
              </div>
            )}
            <ul>
              {messages.map((m, i) => (
                <MessageRow
                  key={messageKey(m)}
                  message={m}
                  call={callOf(calls, m)}
                  callPlace={{ label: channel.kind === 'channel' ? `#${title}` : title, kind: channel.kind }}
                  // A root with a thread under it starts its own group: the bar is its.
                  grouped={continuesGroup(messages[i - 1], m) && !threads[messages[i - 1].id]?.reply_count}
                  meId={meId}
                  membersById={membersById}
                  labels={labelsFor(m)}
                  editing={editingId === m.id}
                  onEdit={() => setEditingId(m.id)}
                  onCancelEdit={() => setEditingId(null)}
                  onSaved={(saved) => {
                    setEditingId(null)
                    onChanged(saved)
                  }}
                  onDelete={() => void remove(m)}
                  members={members}
                  reactions={reactions[m.id]}
                  reactorNames={reactorNames}
                  canReact={!archived}
                  onReact={(emoji, on) => onReact(m.id, emoji, on)}
                  onRetry={m.client_id ? () => onRetry(m.client_id!) : undefined}
                  onReplyInThread={archived && !threads[m.id] ? undefined : () => onOpenThread(m.id)}
                  thread={threads[m.id]}
                  threadUnread={unreadThreads[m.id]?.unread ?? 0}
                  threadOpen={openThreadId === m.id}
                  lit={m.id === focusId}
                />
              ))}
            </ul>
          </>
        )}
        {waitingOnAgent && <AgentWaiting name={assistantName} />}
      </div>
      {windowed && (
        <div className="flex shrink-0 justify-center pb-1">
          <Button size="sm" variant="secondary" data-team-chat-jump-newest="" onClick={onJumpToNewest}>
            Jump to newest
          </Button>
        </div>
      )}

      <Composer
        channelId={channel.id}
        threadRootId={null}
        placeholder={placeholder}
        members={members}
        meId={meId}
        assistantName={assistantName}
        archived={archived}
        typing={typing}
        onSend={onSend}
        onTyping={onTyping}
      />
    </>
  )
}

/** The message a pane was opened on (lit, and scrolled into view once it is there). */
interface FocusProps {
  focusId?: string | null
  onFocusShown?: () => void
}

/** Bring the message a pane was opened on into view once it is drawn (each one once), and say so. */
function useScrollToFocus(scrollRef: RefObject<HTMLDivElement | null>, focusId: string | null | undefined, rows: readonly Shown[] | null, onShown?: () => void) {
  const doneRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!focusId || doneRef.current === focusId || !rows) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-team-chat-message="${focusId}"]`)
    if (!el) return
    doneRef.current = focusId
    el.scrollIntoView({ block: 'center' })
    onShown?.()
  }, [scrollRef, focusId, rows, onShown])
}

const NOTIFY_OPTIONS: ReadonlyArray<{ level: TeamChatNotifyLevel; label: string; hint: string }> = [
  { level: 'all', label: 'All messages', hint: 'Every new message notifies you' },
  { level: 'mentions', label: 'Mentions only', hint: 'Only @-mentions and your threads' },
  { level: 'muted', label: 'Muted', hint: 'No notifications, no unread count' },
]

/** The channel header's menu: how loud it is for the person (migration 560). */
function NotifyMenu({ kind, level, onChange }: { kind: TeamChatChannel['kind']; level: TeamChatNotifyLevel; onChange: (level: TeamChatNotifyLevel) => void }) {
  const Icon = level === 'muted' ? BellOff : Bell
  const label = level === 'muted' ? 'Muted' : level === 'all' ? 'All messages' : 'Mentions only'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-team-chat-notify={level}
          aria-label={`Notifications: ${label}`}
          title={`Notifications: ${label}`}
          className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
        >
          <Icon className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <p className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">{kind !== 'channel' ? 'Notify me about this conversation' : 'Notify me about this channel'}</p>
        {NOTIFY_OPTIONS.map((o) => (
          <DropdownMenuItem key={o.level} data-team-chat-notify-option={o.level} onSelect={() => o.level !== level && onChange(o.level)} className="items-start">
            {o.level === level ? <Check className="mt-0.5 h-4 w-4" aria-label="Chosen" /> : <span className="h-4 w-4 shrink-0" aria-hidden />}
            <span className="flex min-w-0 flex-col">
              <span className="text-sm text-foreground">{o.label}</span>
              <span className="text-xs text-muted-foreground">{o.hint}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AgentWaiting({ name }: { name: string }) {
  return (
    <div className="mt-3 flex items-center gap-2 px-2 text-sm text-muted-foreground">
      <Avatar name={name} agent size="xs" />
      <span className="animate-pulse">{name} is looking into it…</span>
    </div>
  )
}

/**
 * A thread beside its channel (or over it, where there's no room): its root,
 * then its replies, then a box that replies in it. Opened, it is read (the
 * view's mark), and a reply that arrives while it's on screen is read too.
 */
function ThreadPane({
  channel,
  title,
  rootId,
  root,
  replies,
  waitingOnAgent,
  typing,
  onClose,
  over,
  focusId,
  onFocusShown,
  meId,
  members,
  membersById,
  assistantName,
  reactions,
  onReact,
  onRetry,
  onChanged,
  onSend,
  onTyping,
  calls,
}: PaneShared &
  FocusProps & {
  channel: TeamChatChannel
  title: string
  rootId: string
  root: Shown | undefined
  replies: Shown[] | null
  waitingOnAgent: boolean
  typing: string | null
  onClose: () => void
  /** It took the channel's place (no room beside it): Back, not ×. */
  over: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { editingId, setEditingId, remove } = useMessageEditing(onChanged)
  const labelsFor = useMentionLabels(membersById, meId, assistantName)
  const reactorNames = useReactorNames(membersById, meId)
  const archived = !!channel.archived_at
  const place = channel.kind === 'channel' ? `#${title}` : title

  const lastKey = replies?.at(-1) ? messageKey(replies.at(-1)!) : null
  useEffect(() => {
    const el = scrollRef.current
    if (el && !focusId) el.scrollTop = el.scrollHeight
  }, [lastKey, waitingOnAgent, focusId])
  useScrollToFocus(scrollRef, focusId, replies, onFocusShown)

  const row = (m: Shown, grouped: boolean) => (
    <MessageRow
      key={messageKey(m)}
      message={m}
      call={callOf(calls, m)}
      callPlace={{ label: place, kind: channel.kind }}
      grouped={grouped}
      meId={meId}
      membersById={membersById}
      labels={labelsFor(m)}
      editing={editingId === m.id}
      onEdit={() => setEditingId(m.id)}
      onCancelEdit={() => setEditingId(null)}
      onSaved={(saved) => {
        setEditingId(null)
        onChanged(saved)
      }}
      onDelete={() => void remove(m)}
      members={members}
      reactions={reactions[m.id]}
      reactorNames={reactorNames}
      canReact={!archived}
      onReact={(emoji, on) => onReact(m.id, emoji, on)}
      onRetry={m.client_id ? () => onRetry(m.client_id!) : undefined}
      lit={m.id === focusId}
    />
  )

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 pl-3 pr-3">
        {over && (
          <button type="button" onClick={onClose} aria-label={`Back to ${place}`} title={`Back to ${place}`} className="rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        <h2 className={cn('text-[15px] font-bold text-foreground', !over && 'pl-2')}>Thread</h2>
        <span className="min-w-0 truncate text-sm text-muted-foreground">{place}</span>
        {!over && (
          <button type="button" onClick={onClose} aria-label="Close the thread" title="Close" className="ml-auto rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {root ? <ul>{row(root, false)}</ul> : null}
        {replies === null ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : replies.length > 0 ? (
          <>
            {/* As the summary counts them: the replies stored and not deleted. */}
            <p className="mb-1 mt-3 px-2 text-xs font-medium text-muted-foreground">{replyCountLabel(replies.filter((m) => !m.pending && !m.deleted_at).length)}</p>
            <ul>{replies.map((m, i) => row(m, continuesGroup(replies[i - 1], m)))}</ul>
          </>
        ) : null}
        {waitingOnAgent && <AgentWaiting name={assistantName} />}
      </div>
      <Composer
        key={rootId}
        channelId={channel.id}
        threadRootId={rootId}
        placeholder="Reply in thread…"
        members={members}
        meId={meId}
        assistantName={assistantName}
        archived={archived}
        typing={typing}
        onSend={onSend}
        onTyping={onTyping}
        autoFocus
      />
    </>
  )
}

/** The record kinds team chat's `@` finds, beside the people (contacts aren't: its people are teammates). */
const TEAM_CHAT_RECORD_KINDS = ['action', 'document', 'project', 'initiative', 'capture', 'company', 'deal', 'flow'] as const

/** The card a record mention opens, or null for a kind no card draws. */
function recordMentionTarget(r: TeamChatRecordMention): OpenTarget | null {
  return entityOpenTarget(r.type, r.id, r.label)
}

/** The record an `@label` run of a message's words names (an openable one), if any. */
function recordMentionFor(message: TeamChatMessage, text: string): TeamChatRecordMention | null {
  const label = text.replace(/^@/, '').toLowerCase()
  const found = (message.record_mentions ?? []).find((r) => r.label.toLowerCase() === label)
  return found && recordMentionTarget(found) ? found : null
}

/** Plain words with their http(s) links drawn as links (a new tab; no other scheme is ever a link). */
function LinkedText({ text }: { text: string }) {
  const runs = linkRuns(text)
  if (runs.length === 1 && !runs[0].href) return <span>{text}</span>
  return (
    <span>
      {runs.map((run, i) =>
        run.href ? (
          <a key={i} href={run.href} target="_blank" rel="noopener noreferrer" data-team-chat-link="" className="text-primary underline [overflow-wrap:anywhere] underline-offset-2 hover:no-underline">
            {run.text}
          </a>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </span>
  )
}

function openRecordMention(r: TeamChatRecordMention) {
  const target = recordMentionTarget(r)
  if (target) openTarget(target, { from: 'team_chat' })
}

/** The call a call's message shows, once its page (or Realtime) brought it. */
function callOf(calls: Record<string, TeamCallView>, m: TeamChatMessage): TeamCallView | undefined {
  return m.kind === 'call' && m.call_id ? calls[m.call_id] : undefined
}

function MessageRow({
  message,
  grouped,
  meId,
  membersById,
  labels,
  editing,
  onEdit,
  onCancelEdit,
  onSaved,
  onDelete,
  members,
  reactions,
  reactorNames,
  canReact,
  onReact,
  onRetry,
  onReplyInThread,
  thread,
  threadUnread = 0,
  threadOpen = false,
  lit = false,
  call,
  callPlace,
}: {
  message: Shown
  /** A call's message (migration 564): the call it shows, once loaded. */
  call?: TeamCallView
  /** Where a call's message is: what the call panel calls it ("#launch", or the other person), and its kind. */
  callPlace?: { label: string; kind: TeamChatChannel['kind'] }
  grouped: boolean
  meId: string | null
  membersById: Map<string, Member>
  labels: string[]
  editing: boolean
  onEdit: () => void
  onCancelEdit: () => void
  onSaved: (message: TeamChatMessage) => void
  onDelete: () => void
  members: Member[]
  reactions: TeamChatReaction[] | undefined
  reactorNames: (ids: readonly string[]) => string
  canReact: boolean
  onReact: (emoji: string, on: boolean) => void
  /** A failed send: send it again. */
  onRetry?: () => void
  /** In the channel: reply in (or open) its thread. Absent in a thread's pane. */
  onReplyInThread?: () => void
  thread?: TeamChatThreadSummary
  threadUnread?: number
  threadOpen?: boolean
  /** The message the view was opened on (a notification, a search hit): lit for a moment. */
  lit?: boolean
}) {
  const [pinned, setPinned] = useState(false)
  const isAgent = message.author_kind === 'agent'
  const mine = !isAgent && !!meId && message.author_member_id === meId
  // Their own agent's reply: theirs to delete (never to edit), if it said something it shouldn't have.
  const myAgent = isAgent && !!meId && message.agent_for_member_id === meId
  const name = isAgent
    ? agentDisplayName(message.agent_name, memberName(membersById.get(message.agent_for_member_id ?? '')), message.agent_for_member_id === meId)
    : `${memberName(membersById.get(message.author_member_id ?? ''))}${mine ? ' (you)' : ''}`
  const deleted = !!message.deleted_at
  const pending = message.pending
  const author = isAgent ? undefined : membersById.get(message.author_member_id ?? '')
  const groups = useMemo(() => groupReactions(reactions, meId), [reactions, meId])
  const toolbar = !deleted && !editing && !pending
  // A call's message is the call's: no edit, no delete (the database refuses both too).
  const isCall = message.kind === 'call'

  return (
    <li
      data-team-chat-message={message.id}
      data-pending={pending}
      data-lit={lit || undefined}
      className={cn(
        'group relative flex gap-3 rounded-xl px-2 transition-colors duration-700 hover:bg-accent/40',
        grouped ? 'py-0.5' : 'mt-3 pb-0.5 pt-1.5 first:mt-0',
        lit && 'bg-primary/10 hover:bg-primary/10',
      )}
    >
      <div className="w-9 shrink-0">{!grouped && <Avatar name={memberName(author)} url={author?.avatar_url} agent={isAgent} />}</div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className={cn('truncate text-[15px] font-semibold', isAgent ? 'text-violet-700 dark:text-violet-300' : 'text-foreground')}>{name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{messageTime(message.created_at)}</span>
          </div>
        )}
        {isCall ? (
          <>
            <CallMessage message={message} call={call} meId={meId} membersById={membersById} place={callPlace} />
            <ReactionChips groups={groups} names={reactorNames} onToggle={onReact} canReact={canReact} />
            {onReplyInThread && <ThreadBar summary={thread} unread={threadUnread} membersById={membersById} open={threadOpen} onOpen={onReplyInThread} />}
          </>
        ) : editing ? (
          <EditBox message={message} members={members} onCancel={onCancelEdit} onSaved={onSaved} />
        ) : deleted ? (
          <p className="text-[15px] italic leading-relaxed text-muted-foreground">This message was deleted.</p>
        ) : (
          <>
            {message.body && (
              <p className={cn('whitespace-pre-wrap break-words text-[15px] leading-relaxed text-foreground', pending === 'sending' && 'text-foreground/70')}>
                {mentionSegments(message.body, [...labels, ...(message.record_mentions ?? []).map((r) => r.label)]).map((seg, i) => {
                  if (!seg.mention) return <LinkedText key={i} text={seg.text} />
                  // A record's mention opens its card; a person's is a highlight.
                  const record = recordMentionFor(message, seg.text)
                  // Right-click: the record's own actions (the one entity actions menu).
                  return record ? (
                    <EntityContextMenu key={i} entity={{ type: record.type, id: record.id, label: record.label }} from="team_chat">
                      <button
                        type="button"
                        data-record-mention={record.type}
                        onClick={() => openRecordMention(record)}
                        className="rounded bg-primary/10 px-0.5 font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {seg.text}
                      </button>
                    </EntityContextMenu>
                  ) : (
                    <span key={i} className="rounded bg-primary/10 px-0.5 font-medium text-primary">
                      {seg.text}
                    </span>
                  )
                })}
                {message.edited_at && <span className="ml-1 text-[11px] text-muted-foreground">(edited)</span>}
              </p>
            )}
            <MessageAttachments attachments={message.attachments} />
            <LinkPreviewCard preview={message.link_preview} />
            {pending === 'failed' && (
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-destructive" data-team-chat-failed="">
                Not sent.
                {onRetry && (
                  <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline">
                    <RotateCw className="h-3 w-3" />
                    Retry
                  </button>
                )}
              </p>
            )}
            <ReactionChips groups={groups} names={reactorNames} onToggle={onReact} canReact={canReact} />
            {onReplyInThread && <ThreadBar summary={thread} unread={threadUnread} membersById={membersById} open={threadOpen} onOpen={onReplyInThread} />}
          </>
        )}
      </div>
      {toolbar && (
        <div className={cn('absolute right-2 top-1 gap-0.5 rounded-lg border border-border bg-background p-0.5 shadow-sm group-hover:flex', pinned ? 'flex' : 'hidden')}>
          {canReact && (
            <ReactButton
              isSelected={(emoji) => groups.some((g) => g.mine && g.emoji === emoji)}
              onPick={(emoji) => onReact(emoji, !groups.some((g) => g.mine && g.emoji === emoji))}
              onOpenChange={setPinned}
            />
          )}
          {onReplyInThread && (
            <button type="button" onClick={onReplyInThread} aria-label="Reply in thread" title="Reply in thread" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <MessageSquareReply className="h-3.5 w-3.5" />
            </button>
          )}
          {mine && message.body && !isCall && (
            <button type="button" onClick={onEdit} aria-label="Edit message" title="Edit" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {(mine || myAgent) && !isCall && (
            <button type="button" onClick={onDelete} aria-label="Delete message" title="Delete" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function EditBox({ message, members, onCancel, onSaved }: { message: TeamChatMessage; members: Member[]; onCancel: () => void; onSaved: (m: TeamChatMessage) => void }) {
  const [text, setText] = useState(message.body)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    const body = text.trim()
    if (!body || saving) return
    if (body === message.body) return onCancel()
    setSaving(true)
    // The mentions the words still hold (an edit may have taken one out).
    const picked = message.mentions.map((id) => ({ id, label: memberName(members.find((m) => m.id === id)) }))
    // The same for its records: the ones still named go with the edit (the server drops the rest's edges).
    const records = (message.record_mentions ?? []).filter((r) => hasMention(body, r.label))
    const res = await fetch(`/api/account/team-chat/messages/${message.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body, mentions: mentionsStillIn(body, picked), records }),
    })
    setSaving(false)
    if (!res.ok) return
    const json = (await res.json()) as { message?: TeamChatMessage }
    if (json.message) onSaved(json.message)
    const { shared, sharedWith } = parseSharedRecords(json)
    toastSharedRecords(shared, sharedWith)
  }
  return (
    <div className="mt-1">
      <Textarea
        value={text}
        autoFocus
        rows={2}
        maxLength={TEAM_CHAT_MESSAGE_MAX}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void save()
          } else if (e.key === 'Escape') {
            onCancel()
          }
        }}
        className="min-h-0 resize-none text-sm"
      />
      <div className="mt-1 flex gap-1.5 text-[11px] text-muted-foreground">
        <span>Enter to save · Esc to cancel</span>
      </div>
    </div>
  )
}

const NO_NOTES: never[] = []
const noop = () => {}

/** A file in the box: uploading, ready (its attachment, already in storage) or failed (why). */
type BoxFile = ChatFileAttachment & { attachment?: TeamChatAttachment }

/**
 * The box: the main chat's composer (ChatInput, not the main one) in its
 * one-row pill (`layout="inline"`: +, the field, the mic, send), with its
 * `@` listing the person's agent and the members (mentionList), then, once
 * something is typed, records (tasks, docs, projects, captures, companies,
 * deals, flows: mentionList.records), each sent as a record mention (a graph
 * edge). Enter sends, Shift+Enter is a new line. Files and photos (+, a drop
 * or a paste) upload at once, into the channel's own folder; a send carries
 * the ones done. Dictation but no voice mode, no skills.
 *
 * A send leaves the box at once (the view draws its bubble and sends it), and
 * the person's typing goes to the channel's typing line, throttled; an empty
 * box or a send says they stopped.
 */
function Composer({
  channelId,
  threadRootId,
  placeholder,
  members,
  meId,
  assistantName,
  archived,
  typing,
  onSend,
  onTyping,
  autoFocus = false,
}: {
  channelId: string
  /** The thread it replies in (a thread's pane), or null (the channel's). */
  threadRootId: string | null
  placeholder: string
  members: Member[]
  meId: string | null
  assistantName: string
  archived: boolean
  /** "Rosa is typing…" where this box writes, or null (nothing drawn). */
  typing: string | null
  onSend: (draft: TeamChatSendDraft) => void
  onTyping: (thread: string | null, typing: boolean) => void
  autoFocus?: boolean
}) {
  const [text, setText] = useState('')
  // Dictation into the box, as in the main chat (the desktop app; Liam, 11-09:
  // "add the dictation button to the chat"). Dictation only: no voice mode,
  // which is a conversation with the agent, not a message to the channel.
  const recording = useOptionalRecordingStable()
  const availability = useVoiceAvailability({ recording: !!(recording?.isRecording || recording?.isStarting) })
  const voice = useMemo<ChatInputVoice | undefined>(
    () => (availability.dictation ? { availability: { ...availability, conversation: false, visible: true } } : undefined),
    [availability],
  )
  const [picked, setPicked] = useState<Array<{ id: string; label: string }>>([])
  // Records picked from `@` (a task, a doc, a deal…): they go with the message while "@label" is in it.
  const [pickedRecords, setPickedRecords] = useState<TeamChatRecordMention[]>([])
  const [files, setFiles] = useState<BoxFile[]>([])

  // The person's own agent, then everyone else in the workspace.
  const options = useMemo<ComposerMentionOption[]>(
    () => [
      { id: AGENT_OPTION_ID, label: assistantName, hint: 'your agent', agent: true },
      ...members.filter((m) => m.id !== meId).map((m) => ({ id: m.id, label: memberName(m) })),
    ],
    [members, meId, assistantName],
  )
  const mentionList = useMemo<ComposerMentionList>(
    () => ({
      options,
      // A member picked is kept (their mention goes with the message while
      // "@Name" is still in it); the agent is found by name at send.
      onPick: (o) => {
        if (o.agent) return
        setPicked((prev) => (prev.some((p) => p.id === o.id) ? prev : [...prev, { id: o.id, label: o.label }]))
      },
      // Any record, found by the composer's own search; each mention is a graph edge once sent.
      records: {
        kinds: TEAM_CHAT_RECORD_KINDS,
        onPick: (row: MenuSearchRow) => {
          const m = menuRowMention(row)
          if (!m) return
          setPickedRecords((prev) => (prev.some((p) => p.type === m.type && p.id === m.id) ? prev : [...prev, m]))
        },
      },
    }),
    [options],
  )

  // The latest of what a send reads, so the send handed to the (memoized) box stays one function.
  const latest = useRef({ text, picked, pickedRecords, files, channelId, threadRootId, assistantName, members, onSend, onTyping })
  latest.current = { text, picked, pickedRecords, files, channelId, threadRootId, assistantName, members, onSend, onTyping }

  const send = useCallback(() => {
    const { text, picked, pickedRecords, files, channelId, threadRootId, assistantName, members, onSend, onTyping } = latest.current
    const body = text.trim()
    const ready = files.filter((f) => f.status === 'ready' && f.attachment)
    // Not while a file is still on its way (it would be left behind).
    if (files.some((f) => f.status === 'uploading')) return
    if (!body && ready.length === 0) return
    onSend({
      clientId: crypto.randomUUID(),
      channelId,
      threadRootId,
      body,
      mentions: mentionsStillIn(body, picked),
      // "@<agent name>" in the words, picked or typed, calls the agent: by
      // name, never a teammate whose name starts with it ("@Joseph Lee").
      mentionsAgent: !!body && mentionsAssistantName(body, assistantName, members.map((m) => m.display_name)),
      records: pickedRecords.filter((r) => hasMention(body, r.label)),
      attachments: ready.map((f) => f.attachment!),
    })
    onTyping(threadRootId, false)
    setText('')
    setPicked([])
    setPickedRecords([])
    // At once, not at the next render: the files sent are the message's now, never left to clean up.
    latest.current.files = files.filter((f) => f.status === 'error')
    setFiles((prev) => prev.filter((f) => f.status === 'error'))
  }, [])

  // Leaving the box (another channel, the thread closed): uploads never sent go from storage.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const f of latest.current.files) if (f.attachment) void discardTeamChatFile(f.attachment.path)
    }
  }, [])

  // The box's words, at most a message's worth (the server refuses more).
  const onChange = useCallback((value: string) => {
    setText(value.slice(0, TEAM_CHAT_MESSAGE_MAX))
    const { onTyping, threadRootId } = latest.current
    onTyping(threadRootId, value.trim().length > 0)
  }, [])
  const onSubmit = useCallback(() => send(), [send])

  const onAttachFiles = useCallback((list: File[]) => {
    const room = TEAM_CHAT_MAX_FILES - latest.current.files.filter((f) => f.status !== 'error').length
    for (const [i, file] of list.entries()) {
      const id = crypto.randomUUID()
      const check = i < room ? validateTeamChatFile(file) : { ok: false as const, reason: `${TEAM_CHAT_MAX_FILES} files at most` }
      if (!check.ok) {
        setFiles((prev) => [...prev, { id, file, status: 'error', error: check.reason }])
        continue
      }
      setFiles((prev) => [...prev, { id, file, status: 'uploading' }])
      uploadTeamChatFile(latest.current.channelId, file).then(
        (attachment) => {
          // Done after the box was left (or the file taken off meanwhile): nobody will send it.
          if (!mounted.current || !latest.current.files.some((f) => f.id === id)) return void discardTeamChatFile(attachment.path)
          setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status: 'ready', attachment, storagePath: attachment.path } : f)))
        },
        (err: unknown) => setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' } : f))),
      )
    }
  }, [])
  const onRemoveFile = useCallback((id: string) => {
    const file = latest.current.files.find((f) => f.id === id)
    if (file?.attachment) void discardTeamChatFile(file.attachment.path)
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }, [])

  if (archived) {
    return <div className="mx-4 mb-4 shrink-0 rounded-[28px] bg-muted/60 px-5 py-4 text-sm text-muted-foreground">This channel is archived.</div>
  }

  return (
    // At the main chat's reading width at most, centred (Liam, 11-11: across the whole card it was "a bit too long … more
    // contained … a nice amount of empty space each side"); a narrower pane (a thread's, a phone) is unchanged.
    <div className="relative mx-auto w-full max-w-[var(--chat-reading-max)] shrink-0 px-2 pb-6" data-team-chat-composer data-thread={threadRootId ?? undefined}>
      {/* Under the box, in its own bottom margin: it never covers a message nor moves one, and nothing is drawn when nobody types. */}
      {typing && (
        <p className="pointer-events-none absolute bottom-1 left-6 right-6 truncate text-xs leading-4 text-muted-foreground" aria-live="polite" data-team-chat-typing="">
          {typing}
        </p>
      )}
      <ChatInput
        value={text}
        onChange={onChange}
        onSubmit={onSubmit}
        onStop={noop}
        isLoading={false}
        attachedNotes={NO_NOTES}
        onAttachNote={noop}
        onRemoveNote={noop}
        attachedFiles={files}
        onAttachFiles={onAttachFiles}
        onRemoveFile={onRemoveFile}
        fileAccept={TEAM_CHAT_FILE_ACCEPT}
        placeholder={placeholder}
        mainComposer={false}
        mentionList={mentionList}
        voice={voice}
        layout="inline"
        autoFocus={autoFocus}
      />
    </div>
  )
}

function NewChannelDialog({
  open,
  onOpenChange,
  teamId: pickedTeam = null,
  teams,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The team picked when it opens (the sub-nav's Team channels +); null: everyone in the workspace. */
  teamId?: string | null
  teams: Array<{ id: string; name: string }>
  onCreated: (id: string) => void | Promise<void>
}) {
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [teamId, setTeamId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) {
      setName('')
      setTopic('')
      setTeamId(pickedTeam && teams.some((t) => t.id === pickedTeam) ? pickedTeam : '')
      setError(null)
    }
    // Only as it opens: the person's own pick stands after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const create = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    const res = await fetch('/api/account/team-chat/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, topic, teamId: teamId || null }),
    })
    setSaving(false)
    if (res.status === 409) return setError('A channel with that name already exists.')
    if (!res.ok) return setError('Could not create the channel.')
    const json = (await res.json()) as { id?: string }
    if (json.id) await onCreated(json.id)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New channel</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. launch" maxLength={80} autoFocus onKeyDown={(e) => e.key === 'Enter' && void create()} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Topic (optional)</span>
            <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What it's for" maxLength={250} />
          </label>
          {teams.length > 0 && (
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Who can see it</span>
              <select
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Everyone in the workspace</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    Only the {t.name} team
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void create()} disabled={!name.trim() || saving}>
            Create channel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NewDmDialog({
  open,
  onOpenChange,
  members,
  meId,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  members: Member[]
  meId: string | null
  onPick: (memberId: string) => void
}) {
  const [q, setQ] = useState('')
  useEffect(() => {
    if (open) setQ('')
  }, [open])
  const list = members
    .filter((m) => !q || memberName(m).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.id === meId ? 1 : b.id === meId ? -1 : memberName(a).localeCompare(memberName(b))))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
        </DialogHeader>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find someone" autoFocus />
        <ul className="max-h-72 overflow-y-auto">
          {list.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => onPick(m.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent">
                <Avatar name={memberName(m)} url={m.avatar_url} size="sm" />
                <span className="truncate">{memberName(m)}</span>
                {m.id === meId && <span className="ml-auto text-[11px] text-muted-foreground">you</span>}
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">Nobody by that name.</li>}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
