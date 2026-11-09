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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { AtSign, Bot, ChevronLeft, Hash, Lock, MessageSquare, Pencil, Plus, SendHorizontal, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { cachedJson } from '@/lib/cached-fetch'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { useTeams } from '@/app/account/teams-context'
import { useAssistantName } from '@/lib/voice/assistant-name-store'
import { insertMentionAt } from '@/app/account/(dashboard)/chat/mention-text'
import { continuesGroup, mentionQueryAt, mentionSegments, mentionsStillIn, messageTime } from '@/lib/team-chat/compose'
import { agentDisplayName, mentionsAssistantName, TEAM_CHAT_MESSAGE_MAX, TEAM_CHAT_PAGE_SIZE, type TeamChatChannel, type TeamChatMessage } from '@/lib/team-chat/types'

interface Member {
  id: string
  user_id?: string
  display_name: string | null
  avatar_url?: string | null
}

/** One option in the @ picker: a member, or the person's own agent. */
interface MentionOption {
  id: string
  label: string
  hint: string
  agent: boolean
}

/**
 * Below this width the view shows one pane at a time (a phone, a narrow
 * card): the list of channels, then the channel picked, with Back. At it and
 * above, the two side by side, as they always were. The inline card's list is
 * narrower (w-44), so it keeps two panes down to TEAM_CHAT_TWO_PANE_MIN_COMPACT_PX.
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

  return (
    <div ref={rootRef} data-team-chat-panes={narrow ? (openedNow ? 'channel' : 'list') : 'both'} className="flex h-full min-h-0">
      <aside
        className={cn(
          'flex-col',
          narrow ? (showList ? 'flex w-full' : 'hidden') : cn('flex shrink-0 border-r border-border', compact ? 'w-44' : 'w-60'),
        )}
      >
        <div className="flex h-12 shrink-0 items-center px-4">
          <h1 className="text-sm font-semibold text-foreground">Team chat</h1>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {/* On a phone the list stands alone: a failed load says so here, not only in the hidden pane. */}
          {narrow && error && <p className="px-2 py-1.5 text-xs text-destructive">{error}</p>}
          <SectionHeading label="Channels" onAdd={() => setNewChannelOpen(true)} addLabel="New channel" />
          {channels === null ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
          ) : channelList.length === 0 ? (
            <button type="button" onClick={() => setNewChannelOpen(true)} className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent">
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
          <SectionHeading label="Direct messages" onAdd={() => setNewDmOpen(true)} addLabel="New message" className="mt-4" />
          {dmList.map((c) => (
            <ChannelRow key={c.id} channel={c} title={channelTitle(c)} active={c.id === onScreen} onSelect={() => openChannel(c.id)} />
          ))}
        </div>
      </aside>

      <section className={cn('min-w-0 flex-1 flex-col', showChannel ? 'flex' : 'hidden')}>
        {!showChannel ? null : error && !selected ? (
          <p className="py-10 text-center text-sm text-destructive">{error}</p>
        ) : !selected ? (
          channels === null ? null : <EmptyState onCreate={() => setNewChannelOpen(true)} />
        ) : (
          <ChannelPane
            key={selected.id}
            channel={selected}
            title={channelTitle(selected)}
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
    <div className={cn('flex items-center justify-between px-2 py-1.5', className)}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <button type="button" onClick={onAdd} aria-label={addLabel} title={addLabel} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function ChannelRow({
  channel,
  title,
  active,
  privateTeam,
  onSelect,
}: {
  channel: TeamChatChannel
  title: string
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
        'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        unread && 'font-semibold text-foreground',
      )}
    >
      {channel.kind === 'channel' ? (
        privateTeam ? <Lock className="h-3.5 w-3.5 shrink-0 opacity-70" /> : <Hash className="h-3.5 w-3.5 shrink-0 opacity-70" />
      ) : (
        <Avatar name={title} small />
      )}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {unread && channel.mentions > 0 ? (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground" title={`${channel.mentions} mention${channel.mentions === 1 ? '' : 's'}`}>
          @{channel.mentions}
        </span>
      ) : unread ? (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-muted-foreground/20 px-1 text-[10px] font-semibold text-foreground">{channel.unread}</span>
      ) : null}
    </button>
  )
}

function Avatar({ name, agent = false, small = false }: { name: string; agent?: boolean; small?: boolean }) {
  const size = small ? 'h-4 w-4 text-[9px]' : 'h-8 w-8 text-xs'
  if (agent) {
    return (
      <span className={cn('flex shrink-0 items-center justify-center rounded-md bg-violet-500/15 text-violet-600 dark:text-violet-300', size)}>
        <Bot className={small ? 'h-3 w-3' : 'h-4 w-4'} />
      </span>
    )
  }
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-md bg-muted font-semibold text-muted-foreground', size)}>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
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
  // Opened on a phone (it takes the screen): the focus starts on Back, the list's button it replaced being gone.
  const backRef = useRef<HTMLButtonElement>(null)
  const backFirst = !!onBack
  useEffect(() => {
    if (backFirst) backRef.current?.focus({ preventScroll: true })
  }, [backFirst])
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
      <div className={cn('flex h-12 shrink-0 items-center gap-2 border-b border-border', onBack ? 'pl-2 pr-4' : 'px-5')}>
        {onBack && (
          <button
            ref={backRef}
            type="button"
            onClick={onBack}
            aria-label="All channels"
            title="All channels"
            data-team-chat-back=""
            className="-ml-0.5 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        {channel.kind === 'channel' ? <Hash className="h-4 w-4 shrink-0 text-muted-foreground" /> : <Avatar name={title} small />}
        <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
        {teamName && (
          <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            <Users className="h-3 w-3" />
            {teamName}
          </span>
        )}
        {channel.topic && <span className="truncate text-xs text-muted-foreground">{channel.topic}</span>}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {messages === null ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : messages.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm font-medium text-foreground">{channel.kind === 'channel' ? `This is the start of #${title}` : `This is the start of your messages with ${title}`}</p>
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
          <ul className="space-y-0.5">
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
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Avatar name={assistantName} agent small />
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

  return (
    <li className={cn('group relative flex gap-3 rounded-md px-2 hover:bg-accent/40', grouped ? 'py-0.5' : 'mt-2 py-1')}>
      <div className="w-8 shrink-0">{!grouped && <Avatar name={name} agent={isAgent} />}</div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className={cn('text-sm font-semibold', isAgent ? 'text-violet-700 dark:text-violet-300' : 'text-foreground')}>{name}</span>
            <span className="text-[11px] text-muted-foreground">{messageTime(message.created_at)}</span>
          </div>
        )}
        {editing ? (
          <EditBox message={message} members={members} onCancel={onCancelEdit} onSaved={onSaved} />
        ) : deleted ? (
          <p className="text-sm italic text-muted-foreground">This message was deleted.</p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
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
        <div className="absolute right-2 top-1 hidden gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-sm group-hover:flex">
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
  const [picked, setPicked] = useState<Array<{ id: string; label: string }>>([])
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  // Where the caret goes once a programmatic change (a picked mention, the @ button) has rendered:
  // set before the browser handles the next keystroke, so fast typing never lands in the wrong place.
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const at = pendingCaret.current
    const el = ref.current
    if (at === null || !el) return
    pendingCaret.current = null
    el.focus()
    el.setSelectionRange(at, at)
  }, [text])

  const options = useMemo<MentionOption[]>(() => {
    if (!query) return []
    const q = query.query.toLowerCase()
    const all: MentionOption[] = [
      { id: AGENT_OPTION_ID, label: assistantName, hint: 'your agent', agent: true },
      ...members
        .filter((m) => m.id !== meId)
        .map((m) => ({ id: m.id, label: memberName(m), hint: '', agent: false })),
    ]
    return all.filter((o) => !q || o.label.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || o.label.toLowerCase().startsWith(q)).slice(0, 8)
  }, [query, members, meId, assistantName])

  const updateQuery = (value: string, caret: number) => {
    setQuery(mentionQueryAt(value, caret))
    setActive(0)
  }

  const pick = (o: MentionOption) => {
    if (!query) return
    const { value, cursor } = insertMentionAt(text, query.start, o.label)
    setText(value)
    setPicked((prev) => (prev.some((p) => p.id === o.id) ? prev : [...prev, { id: o.id, label: o.label }]))
    setQuery(null)
    pendingCaret.current = cursor
  }

  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    const still = mentionsStillIn(body, picked).filter((id) => id !== AGENT_OPTION_ID)
    // The agent by name, never a teammate whose name starts with it ("@Joseph Lee").
    const mentionsAgent = picked.some((p) => p.id === AGENT_OPTION_ID) && mentionsAssistantName(body, assistantName, members.map((m) => m.display_name))
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
      setText('')
      setPicked([])
      setQuery(null)
    } catch {
      setFailed(true)
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (query && options.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (i + 1) % options.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i - 1 + options.length) % options.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(options[active] ?? options[0])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setQuery(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  if (archived) {
    return <div className="border-t border-border px-5 py-3 text-sm text-muted-foreground">This channel is archived.</div>
  }

  return (
    <div className="relative shrink-0 px-5 pb-4">
      {query && options.length > 0 && (
        <div className="absolute bottom-full left-5 z-20 mb-1 w-72 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-lg" role="listbox">
          {options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(o)
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm', i === active ? 'bg-accent text-foreground' : 'text-foreground')}
            >
              <Avatar name={o.label} agent={o.agent} small />
              <span className="truncate">{o.label}</span>
              {o.hint && <span className="ml-auto text-[11px] text-muted-foreground">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-background px-3 py-2 focus-within:border-ring">
        <Textarea
          ref={ref}
          value={text}
          rows={1}
          maxLength={TEAM_CHAT_MESSAGE_MAX}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value)
            updateQuery(e.target.value, e.target.selectionStart ?? e.target.value.length)
          }}
          onKeyDown={onKeyDown}
          onClick={(e) => updateQuery(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
          onBlur={() => setTimeout(() => setQuery(null), 120)}
          className="max-h-40 min-h-0 flex-1 resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
        />
        <button
          type="button"
          aria-label="Mention someone"
          title="Mention someone or your agent"
          onClick={() => {
            const el = ref.current
            const at = el?.selectionStart ?? text.length
            const next = `${text.slice(0, at)}${at > 0 && !/\s$/.test(text.slice(0, at)) ? ' ' : ''}@${text.slice(at)}`
            const caret = next.length - text.slice(at).length
            pendingCaret.current = caret
            setText(next)
            updateQuery(next, caret)
          }}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <AtSign className="h-4 w-4" />
        </button>
        <Button size="sm" onClick={() => void send()} disabled={!text.trim() || sending} aria-label="Send">
          <SendHorizontal className="h-3.5 w-3.5" />
        </Button>
      </div>
      {failed && <p className="mt-1 text-xs text-destructive">That didn&apos;t send. Try again.</p>}
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
                <Avatar name={memberName(m)} small />
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
