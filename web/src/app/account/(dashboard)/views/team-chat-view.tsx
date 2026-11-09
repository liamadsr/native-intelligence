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
 * Owns its own fetches against /api/account/team-chat/* and one Supabase
 * Realtime channel for the workspace (team_chat_message, team_chat_channel;
 * RLS filters what arrives), resyncing on every (re)subscribe.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Bot, ChevronLeft, Hash, Lock, MessageSquare, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Avatar as AvatarRoot, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { cachedJson } from '@/lib/cached-fetch'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { useTeams } from '@/app/account/teams-context'
import { useAssistantName } from '@/lib/voice/assistant-name-store'
import { ChatInput, type ChatInputUnavailable, type ChatInputVoice } from '@/app/account/(dashboard)/chat/chat-input'
import { useVoiceAvailability } from '@/hooks/use-voice-availability'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import type { ComposerMentionList, ComposerMentionOption } from '@/app/account/(dashboard)/chat/command-menu-model'
import { continuesGroup, mentionSegments, mentionsStillIn, messageTime } from '@/lib/team-chat/compose'
import { agentDisplayName, mentionsAssistantName, TEAM_CHAT_MESSAGE_MAX, TEAM_CHAT_PAGE_SIZE, type TeamChatChannel, type TeamChatMessage } from '@/lib/team-chat/types'

interface Member {
  id: string
  user_id?: string
  display_name: string | null
  avatar_url?: string | null
}

/**
 * Below this width the view shows one pane at a time (a phone, a narrow
 * card): the list of channels, then the channel picked, with Back. At it and
 * above, the two side by side, split by Mail's resizable handle. The inline
 * card's list may be narrower (down to 176px), so it keeps two panes down to
 * TEAM_CHAT_TWO_PANE_MIN_COMPACT_PX.
 */
export const TEAM_CHAT_TWO_PANE_MIN_PX = 576
export const TEAM_CHAT_TWO_PANE_MIN_COMPACT_PX = 480

/**
 * Is the view narrower than two panes need? Its own width, read by one
 * ResizeObserver (it fires only on a resize, never at rest). Unmeasured (no
 * layout yet, or no ResizeObserver): two panes, as before.
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

function memberName(m: Member | undefined): string {
  return m?.display_name?.trim() || 'Teammate'
}

/** A name's initials for its avatar: the first and last words' ("Rosa Lind": RL). */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0].charAt(0)
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : ''
  return (first + last).toUpperCase()
}

function sortByTime(list: TeamChatMessage[]): TeamChatMessage[] {
  return [...list].sort((a, b) => a.created_at.localeCompare(b.created_at))
}

function upsertMessage(list: TeamChatMessage[] | undefined, message: TeamChatMessage): TeamChatMessage[] {
  const prev = list ?? []
  const at = prev.findIndex((m) => m.id === message.id)
  if (at === -1) return sortByTime([...prev, message])
  const next = [...prev]
  next[at] = message
  return next
}

export function TeamChatView({ onCount, compact = false }: { onCount?: (count: number | null) => void; compact?: boolean } = {}) {
  const workspaceId = useWorkspaceId()
  const { teams } = useTeams()
  const { name: assistantName } = useAssistantName()

  const [channels, setChannels] = useState<TeamChatChannel[] | null>(null)
  const [meId, setMeId] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, TeamChatMessage[]>>({})
  const [waitingOnAgent, setWaitingOnAgent] = useState<Record<string, number>>({})
  const [newChannelOpen, setNewChannelOpen] = useState(false)
  const [newDmOpen, setNewDmOpen] = useState(false)

  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId
  // One pane at a time when narrow (a phone): the list until the person opens
  // a channel, then that channel, with Back to the list.
  const rootRef = useRef<HTMLDivElement>(null)
  const narrow = useNarrow(rootRef, compact ? TEAM_CHAT_TWO_PANE_MIN_COMPACT_PX : TEAM_CHAT_TWO_PANE_MIN_PX)
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
  const showList = !narrow || !openedNow
  const showChannel = !narrow || openedNow
  // The channel on screen: the one read marks are for. The first channel is
  // picked for the person when the list loads, but on a phone it isn't on
  // screen until they open it, and its messages stay unread until then.
  const onScreen = showChannel ? selectedId : null
  const onScreenRef = useRef<string | null>(null)
  onScreenRef.current = onScreen
  const meRef = useRef<string | null>(null)
  meRef.current = meId
  // Channels whose older messages haven't all been loaded (their last page was full).
  const [more, setMore] = useState<Record<string, boolean>>({})

  // The card's header count: everything unread.
  const onCountRef = useRef(onCount)
  onCountRef.current = onCount
  useEffect(() => {
    if (channels) onCountRef.current?.(channels.reduce((n, c) => n + c.unread, 0))
  }, [channels])

  const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members])
  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams])

  const loadChannels = useCallback(async () => {
    try {
      const res = await fetch('/api/account/team-chat/channels')
      if (!res.ok) throw new Error('Could not load team chat')
      const json = (await res.json()) as { channels?: TeamChatChannel[]; memberId?: string }
      // The channel on screen is read (its read mark may still be on its way): never counted unread here.
      const open = typeof document !== 'undefined' && document.visibilityState === 'visible' ? onScreenRef.current : null
      const list = (Array.isArray(json.channels) ? json.channels : []).map((c) => (c.id === open ? { ...c, unread: 0, mentions: 0 } : c))
      setMeId(json.memberId ?? null)
      setChannels(list)
      setError(null)
      setSelectedId((cur) => (cur && list.some((c) => c.id === cur) ? cur : (list.find((c) => c.kind === 'channel') ?? list[0])?.id ?? null))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load team chat')
      setChannels((prev) => prev ?? [])
    }
  }, [])

  const loadMessages = useCallback(async (channelId: string) => {
    const res = await fetch(`/api/account/team-chat/channels/${channelId}/messages`)
    if (!res.ok) return
    const json = (await res.json()) as { messages?: TeamChatMessage[] }
    const page = Array.isArray(json.messages) ? json.messages : []
    setMore((prev) => ({ ...prev, [channelId]: page.length >= TEAM_CHAT_PAGE_SIZE }))
    setMessages((prev) => {
      // Keep anything realtime (or an earlier page) brought in while the page was loading.
      let list = page
      for (const m of prev[channelId] ?? []) if (!list.some((x) => x.id === m.id)) list = upsertMessage(list, m)
      return { ...prev, [channelId]: list }
    })
  }, [])

  // The page before the oldest message shown.
  const loadEarlier = useCallback(async (channelId: string, before: string) => {
    const res = await fetch(`/api/account/team-chat/channels/${channelId}/messages?before=${encodeURIComponent(before)}`)
    if (!res.ok) return
    const json = (await res.json()) as { messages?: TeamChatMessage[] }
    const page = Array.isArray(json.messages) ? json.messages : []
    setMore((prev) => ({ ...prev, [channelId]: page.length >= TEAM_CHAT_PAGE_SIZE }))
    setMessages((prev) => {
      let list = prev[channelId] ?? []
      for (const m of page) list = upsertMessage(list, m)
      return { ...prev, [channelId]: list }
    })
  }, [])

  const markRead = useCallback(async (channelId: string) => {
    setChannels((prev) => prev?.map((c) => (c.id === channelId ? { ...c, unread: 0, mentions: 0 } : c)) ?? prev)
    await fetch(`/api/account/team-chat/channels/${channelId}/read`, { method: 'POST' }).catch(() => null)
  }, [])

  useEffect(() => {
    void loadChannels()
  }, [loadChannels, workspaceId])

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

  // Coming back to the tab reads the channel on screen (what arrived while away was left unread).
  useEffect(() => {
    const onVisible = () => {
      const open = onScreenRef.current
      if (document.visibilityState === 'visible' && open) void markRead(open)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [markRead])

  // Live: one channel for the workspace; RLS filters what arrives.
  useEffect(() => {
    if (!workspaceId) return
    const supabase = createClient()
    let listTimer: ReturnType<typeof setTimeout> | null = null
    let readTimer: ReturnType<typeof setTimeout> | null = null
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
        setMessages((prev) => (prev[row.channel_id] ? { ...prev, [row.channel_id]: upsertMessage(prev[row.channel_id], row) } : prev))
        // Only the person's own agent's new reply ends their "looking into it" line.
        if (payload.eventType === 'INSERT' && row.author_kind === 'agent' && row.agent_for_member_id && row.agent_for_member_id === meRef.current) {
          setWaitingOnAgent((prev) => {
            if (!prev[row.channel_id]) return prev
            const next = { ...prev }
            delete next[row.channel_id]
            return next
          })
        }
        if (payload.eventType === 'INSERT' && row.channel_id === onScreenRef.current && document.visibilityState === 'visible') {
          // A burst of messages is one read mark.
          if (readTimer) clearTimeout(readTimer)
          readTimer = setTimeout(() => void markRead(row.channel_id), 150)
        } else if (payload.eventType === 'INSERT') {
          refreshList()
        }
        if (payload.eventType === 'INSERT') {
          setChannels((prev) => prev?.map((c) => (c.id === row.channel_id ? { ...c, last_message_at: row.created_at } : c)) ?? prev)
        }
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
      void supabase.removeChannel(channel)
    }
  }, [workspaceId, loadChannels, loadMessages, markRead])

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

  const selected = channels?.find((c) => c.id === selectedId) ?? null
  const channelList = (channels ?? []).filter((c) => c.kind === 'channel')
  const dmList = (channels ?? []).filter((c) => c.kind === 'dm')

  const channelTitle = useCallback(
    (c: TeamChatChannel): string => {
      if (c.kind === 'channel') return c.name ?? 'channel'
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
  // Back to the list (a phone): the focus goes to the channel's row, where they were.
  const backToList = useCallback(() => {
    setOpened(false)
    const id = selectedRef.current
    requestAnimationFrame(() => {
      if (id) rootRef.current?.querySelector<HTMLElement>(`[data-team-chat-row="${id}"]`)?.focus({ preventScroll: true })
    })
  }, [])

  const handleSent = useCallback((message: TeamChatMessage, calledAgent: boolean) => {
    setMessages((prev) => ({ ...prev, [message.channel_id]: upsertMessage(prev[message.channel_id], message) }))
    if (calledAgent) setWaitingOnAgent((prev) => ({ ...prev, [message.channel_id]: Date.now() }))
  }, [])

  const handleChanged = useCallback((message: TeamChatMessage) => {
    setMessages((prev) => ({ ...prev, [message.channel_id]: upsertMessage(prev[message.channel_id], message) }))
  }, [])

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
      </div>
    </aside>
  )

  const pane = (
    <section className={cn('h-full min-h-0 min-w-0 flex-1 flex-col', showChannel ? 'flex' : 'hidden')}>
      {!showChannel ? null : error && !selected ? (
        <p className="py-10 text-center text-sm text-destructive">{error}</p>
      ) : !selected ? (
        channels === null ? null : <EmptyState onCreate={() => setNewChannelOpen(true)} />
      ) : (
        <ChannelPane
          key={selected.id}
          channel={selected}
          title={channelTitle(selected)}
          dmPerson={selected.kind === 'dm' && selected.dm_member_id ? membersById.get(selected.dm_member_id) : undefined}
          teamName={selected.team_id ? (teamsById.get(selected.team_id)?.name ?? null) : null}
          messages={messages[selected.id] ?? null}
          meId={meId}
          members={members}
          membersById={membersById}
          assistantName={assistantName}
          waitingOnAgent={!!waitingOnAgent[selected.id]}
          hasMore={!!more[selected.id]}
          onLoadEarlier={(before) => loadEarlier(selected.id, before)}
          onSent={handleSent}
          onChanged={handleChanged}
          onBack={narrow ? backToList : undefined}
        />
      )}
    </section>
  )

  return (
    <div ref={rootRef} data-team-chat-panes={narrow ? (openedNow ? 'channel' : 'list') : 'both'} className="flex h-full min-h-0">
      {/* The list and the messages split as Mail's are, by a line with a
          grip that resizes them (Liam, 11-09: "the same type of divider that
          we have for the main page"). Narrow (a phone), one pane at a time:
          the other panel hidden (the `hidden` attribute, which the panel's
          inline display can't override) and no divider. One tree either way,
          so crossing the width keeps the open channel as it was: its draft,
          an edit, where it was scrolled to, the focus. */}
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
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
        {!narrow && <ResizableHandle withHandle />}
        <ResizablePanel id="team-chat-channel" hidden={narrow && !showChannel} minSize="40%" className="flex min-h-0 min-w-0 flex-col">
          {pane}
        </ResizablePanel>
      </ResizablePanelGroup>

      <NewChannelDialog
        open={newChannelOpen}
        onOpenChange={setNewChannelOpen}
        teams={teams.map((t) => ({ id: t.id, name: t.name }))}
        onCreated={async (id) => {
          setNewChannelOpen(false)
          await loadChannels()
          openChannel(id)
        }}
      />
      <NewDmDialog open={newDmOpen} onOpenChange={setNewDmOpen} members={members} meId={meId} onPick={openDm} />
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
  const unread = channel.unread > 0 && !active
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
      ) : (
        <Avatar name={avatar?.name ?? title} url={avatar?.url} size="sm" />
      )}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {unread && channel.mentions > 0 ? (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground" title={`${channel.mentions} mention${channel.mentions === 1 ? '' : 's'}`}>
          @{channel.mentions}
        </span>
      ) : unread ? (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-muted-foreground/20 px-1.5 text-[11px] font-semibold text-foreground">{channel.unread}</span>
      ) : null}
    </button>
  )
}

const AVATAR_SIZES = {
  xs: { box: 'h-5 w-5 text-[9px]', icon: 'h-3 w-3' },
  sm: { box: 'h-6 w-6 text-[10px]', icon: 'h-3.5 w-3.5' },
  md: { box: 'h-9 w-9 text-xs', icon: 'h-4 w-4' },
} as const

/** A round avatar: the person's photo when known, else their initials; an agent's, its own (violet, a bot). */
function Avatar({ name, url, agent = false, size = 'md' }: { name: string; url?: string | null; agent?: boolean; size?: keyof typeof AVATAR_SIZES }) {
  const { box, icon } = AVATAR_SIZES[size]
  if (agent) {
    return (
      <span className={cn('flex shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-violet-600 dark:text-violet-300', box)} aria-hidden>
        <Bot className={icon} />
      </span>
    )
  }
  return (
    <AvatarRoot className={box} aria-hidden>
      {url && <AvatarImage src={url} alt="" className="object-cover" />}
      <AvatarFallback className="bg-muted font-semibold text-muted-foreground">{initials(name)}</AvatarFallback>
    </AvatarRoot>
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

function ChannelPane({
  channel,
  title,
  dmPerson,
  teamName,
  messages,
  meId,
  members,
  membersById,
  assistantName,
  waitingOnAgent,
  hasMore,
  onLoadEarlier,
  onSent,
  onChanged,
  onBack,
}: {
  channel: TeamChatChannel
  title: string
  /** A direct message's other person, for the avatar beside their name. */
  dmPerson?: Member
  teamName: string | null
  messages: TeamChatMessage[] | null
  meId: string | null
  members: Member[]
  membersById: Map<string, Member>
  assistantName: string
  waitingOnAgent: boolean
  hasMore: boolean
  onLoadEarlier: (before: string) => Promise<void>
  onSent: (message: TeamChatMessage, calledAgent: boolean) => void
  onChanged: (message: TeamChatMessage) => void
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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)

  // Stay at the bottom as messages arrive (a new last message), never when older ones are loaded above.
  const lastId = messages?.at(-1)?.id ?? null
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastId, waitingOnAgent])

  const earlier = async () => {
    const oldest = messages?.[0]
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

  const labelsFor = useCallback(
    (m: TeamChatMessage): string[] => {
      const labels = m.mentions.map((id) => memberName(membersById.get(id)))
      // The author's own agent, by the name it goes by for them (only the person's own is known here).
      if (m.mentions_agent && m.author_member_id === meId) labels.push(assistantName)
      return labels
    },
    [membersById, meId, assistantName],
  )

  const remove = useCallback(
    async (m: TeamChatMessage) => {
      const res = await fetch(`/api/account/team-chat/messages/${m.id}`, { method: 'DELETE' })
      if (res.ok) onChanged({ ...m, body: '', mentions: [], deleted_at: new Date().toISOString() })
    },
    [onChanged],
  )

  const placeholder = channel.kind === 'channel' ? `Message #${title}` : `Message ${title}`

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
        {channel.kind === 'channel' ? <Hash className="h-5 w-5 shrink-0 text-muted-foreground" /> : <Avatar name={memberName(dmPerson)} url={dmPerson?.avatar_url} size="sm" />}
        <h2 className="truncate text-lg font-bold text-foreground">{title}</h2>
        {teamName && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            <Users className="h-3 w-3" />
            {teamName}
          </span>
        )}
        {channel.topic && <span className="min-w-0 truncate text-sm text-muted-foreground">{channel.topic}</span>}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {messages === null ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : messages.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-[15px] font-semibold text-foreground">{channel.kind === 'channel' ? `This is the start of #${title}` : `This is the start of your messages with ${title}`}</p>
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
                key={m.id}
                message={m}
                grouped={continuesGroup(messages[i - 1], m)}
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
              />
            ))}
          </ul>
          </>
        )}
        {waitingOnAgent && (
          <div className="mt-3 flex items-center gap-2 px-2 text-sm text-muted-foreground">
            <Avatar name={assistantName} agent size="xs" />
            <span className="animate-pulse">{assistantName} is looking into it…</span>
          </div>
        )}
      </div>

      <Composer
        channelId={channel.id}
        placeholder={placeholder}
        members={members}
        meId={meId}
        assistantName={assistantName}
        archived={!!channel.archived_at}
        onSent={onSent}
      />
    </>
  )
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
}: {
  message: TeamChatMessage
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
}) {
  const isAgent = message.author_kind === 'agent'
  const mine = !isAgent && !!meId && message.author_member_id === meId
  // Their own agent's reply: theirs to delete (never to edit), if it said something it shouldn't have.
  const myAgent = isAgent && !!meId && message.agent_for_member_id === meId
  const name = isAgent
    ? agentDisplayName(message.agent_name, memberName(membersById.get(message.agent_for_member_id ?? '')), message.agent_for_member_id === meId)
    : `${memberName(membersById.get(message.author_member_id ?? ''))}${mine ? ' (you)' : ''}`
  const deleted = !!message.deleted_at
  const author = isAgent ? undefined : membersById.get(message.author_member_id ?? '')

  return (
    <li className={cn('group relative flex gap-3 rounded-xl px-2 hover:bg-accent/40', grouped ? 'py-0.5' : 'mt-3 pb-0.5 pt-1.5 first:mt-0')}>
      <div className="w-9 shrink-0">{!grouped && <Avatar name={memberName(author)} url={author?.avatar_url} agent={isAgent} />}</div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className={cn('truncate text-[15px] font-semibold', isAgent ? 'text-violet-700 dark:text-violet-300' : 'text-foreground')}>{name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{messageTime(message.created_at)}</span>
          </div>
        )}
        {editing ? (
          <EditBox message={message} members={members} onCancel={onCancelEdit} onSaved={onSaved} />
        ) : deleted ? (
          <p className="text-[15px] italic leading-relaxed text-muted-foreground">This message was deleted.</p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-foreground">
            {mentionSegments(message.body, labels).map((seg, i) =>
              seg.mention ? (
                <span key={i} className="rounded bg-primary/10 px-0.5 font-medium text-primary">
                  {seg.text}
                </span>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            )}
            {message.edited_at && <span className="ml-1 text-[11px] text-muted-foreground">(edited)</span>}
          </p>
        )}
      </div>
      {(mine || myAgent) && !deleted && !editing && (
        <div className="absolute right-2 top-1 hidden gap-0.5 rounded-lg border border-border bg-background p-0.5 shadow-sm group-hover:flex">
          {mine && (
            <button type="button" onClick={onEdit} aria-label="Edit message" title="Edit" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          <button type="button" onClick={onDelete} aria-label="Delete message" title="Delete" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
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
    const res = await fetch(`/api/account/team-chat/messages/${message.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body, mentions: mentionsStillIn(body, picked) }),
    })
    setSaving(false)
    if (!res.ok) return
    const json = (await res.json()) as { message?: TeamChatMessage }
    if (json.message) onSaved(json.message)
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

/** What team chat's box can't take: its messages are words only. */
const TEAM_CHAT_UNAVAILABLE: ChatInputUnavailable = {
  files: { reason: 'Team chat messages are text only.' },
}
const NO_NOTES: never[] = []
const NO_FILES: never[] = []
const noop = () => {}

/**
 * The box: the main chat's composer (ChatInput, not the main one) in its
 * one-row pill (`layout="inline"`: +, the field, the mic, send), with its
 * `@` listing the person's agent and the members (mentionList) in place of
 * the record search. Enter sends, Shift+Enter is a new line. Text only: no
 * files (dimmed in +, with why), dictation but no voice mode, no skills.
 */
function Composer({
  channelId,
  placeholder,
  members,
  meId,
  assistantName,
  archived,
  onSent,
}: {
  channelId: string
  placeholder: string
  members: Member[]
  meId: string | null
  assistantName: string
  archived: boolean
  onSent: (message: TeamChatMessage, calledAgent: boolean) => void
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
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)

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
    }),
    [options],
  )

  // The latest of what a send reads, so the send handed to the (memoized) box stays one function.
  const latest = useRef({ text, picked, sending, channelId, assistantName, members, onSent })
  latest.current = { text, picked, sending, channelId, assistantName, members, onSent }

  const send = useCallback(async () => {
    const { text, picked, sending, channelId, assistantName, members, onSent } = latest.current
    const body = text.trim()
    if (!body || sending) return
    const still = mentionsStillIn(body, picked)
    // "@<agent name>" in the words, picked or typed, calls the agent: by name,
    // never a teammate whose name starts with it ("@Joseph Lee").
    const mentionsAgent = mentionsAssistantName(body, assistantName, members.map((m) => m.display_name))
    latest.current.sending = true
    setSending(true)
    setFailed(false)
    try {
      const res = await fetch(`/api/account/team-chat/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, mentions: still, mentionsAgent }),
      })
      if (!res.ok) throw new Error('send failed')
      const json = (await res.json()) as { message?: TeamChatMessage }
      if (json.message) onSent(json.message, json.message.mentions_agent)
      // Only what was sent goes: words typed while it was on its way stay.
      const typedSince = latest.current.text !== text
      if (!typedSince) {
        setText('')
        setPicked([])
      }
    } catch {
      setFailed(true)
    } finally {
      latest.current.sending = false
      setSending(false)
    }
  }, [])

  // The box's words, at most a message's worth (the server refuses more).
  const onChange = useCallback((value: string) => {
    setText(value.slice(0, TEAM_CHAT_MESSAGE_MAX))
    // Editing after a failed send: the note has done its job.
    setFailed(false)
  }, [])
  const onSubmit = useCallback(() => void send(), [send])

  if (archived) {
    return <div className="mx-4 mb-4 shrink-0 rounded-[28px] bg-muted/60 px-5 py-4 text-sm text-muted-foreground">This channel is archived.</div>
  }

  return (
    <div className="shrink-0 px-2 pb-3" data-team-chat-composer aria-busy={sending || undefined}>
      <ChatInput
        value={text}
        onChange={onChange}
        onSubmit={onSubmit}
        onStop={noop}
        isLoading={false}
        attachedNotes={NO_NOTES}
        onAttachNote={noop}
        onRemoveNote={noop}
        attachedFiles={NO_FILES}
        onAttachFiles={noop}
        onRemoveFile={noop}
        placeholder={placeholder}
        mainComposer={false}
        unavailable={TEAM_CHAT_UNAVAILABLE}
        mentionList={mentionList}
        voice={voice}
        layout="inline"
      />
      {failed && <p className="mt-1 px-3 text-xs text-destructive">That didn&apos;t send. Try again.</p>}
    </div>
  )
}

function NewChannelDialog({
  open,
  onOpenChange,
  teams,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
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
      setTeamId('')
      setError(null)
    }
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
