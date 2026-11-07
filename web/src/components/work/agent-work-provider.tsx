'use client'

/**
 * One shared source for what the AI teammates are doing (bot-characters.md
 * Step 3, item 3): mounted ONCE in the dashboard shell, so the For you
 * column, the chat's widgets and every agent's page read the SAME rows, the
 * same cards and the same per-teammate counts, over the same Realtime
 * channels.
 *
 *   work       one useAgentWork, on the light read (GET
 *              /api/account/agent-work?light=1: the open rows, the last day's
 *              done runs a peek speaks for, the roster). Its first load waits
 *              for the browser to go idle after boot.
 *   attention  one useAttentionItems, on a channel name unique to this mount.
 *              It is the shell's only one, so a live card's arrival sound
 *              plays once.
 *   counts     countByOwner over every workspace: per teammate (or lane), what
 *              runs, what waits on you (cards included) and what may make its
 *              bot call for you. A settled row counts for nothing, and the
 *              rows cards point at come with the answer (`card_rows`). An unread failed run's
 *              notice (the window's `botNotices`, in the same workspace span)
 *              is new for its bot too, for the agent page's switcher dot until
 *              it's read (bots-v4 Phase 4c, failed-notices.ts); the person
 *              hears of it from the agent in the home thread
 *              (retire-notifications-page).
 *   rows feed  the work's `tracked_job` channel, handed on (useOnWorkRow) to
 *              readers that keep rows of their own, a bot's work
 *              (use-bot-work.ts), so they open no channel of their own. Its
 *              own context, so subscribing re-renders nothing on a push.
 *
 * Owners: work with no bot the viewer can reach is the workspace's
 * Assistant's (lib/work/bot-owner.ts, Liam 2026-10-08). The rows, the card
 * rows, the cards and each pushed row are handed on as that rule has them
 * (useOwnedWork, useOwnedAttention), read off the roster, so every reader here
 * (the counts, the bubble, the bot's page, the crew) groups
 * them alike without knowing the rule. Sequence sends keep no bot.
 *
 * Workspace span: the hooks load every workspace; what this source HANDS ON
 * follows the workspace menu's "Show all workspaces" switch
 * (lib/workspace-span). With it off, the work, the roster and the cards are
 * narrowed here to the active workspace's, once, so the bots on screen and
 * every bot's page show the same workspace — none of them has
 * a scope of its own to disagree about. Flipping it narrows or widens what is
 * held; nothing is refetched.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAgentWork, type AgentWork, type OnWorkRow } from '@/hooks/use-agent-work'
import { useAttentionItems, type UseAttentionItems } from '@/hooks/use-attention-items'
import { NO_BOT_OWNERS, botOwnersFromRoster, withBotOwner, withBotOwners, withCardOwners, type BotOwners } from '@/lib/work/bot-owner'
import { agentFacedRoster, agentName, teammateOwnerOf } from '@/lib/bots/agent-face'
import { useAssistantName } from '@/lib/voice/assistant-name-store'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { useShowAllWorkspaces } from '@/lib/workspace-span'
import { cardLookupRows, countByOwner, type OwnerCounts } from '@/lib/work/agent-work-lanes'
import { useNotifications } from '@/app/account/notification-context'
import { isUnreadFailedNotice, withFailedNotices } from '@/lib/bots/failed-notices'
import { noticeTeammateId } from '@/lib/bots/bot-notice'

export interface AgentWorkShared {
  work: AgentWork
  attention: UseAttentionItems
  /** Per owner key (`tm:<id>` or `lane:<kind>`), across the workspaces in span. */
  counts: ReadonlyMap<string, OwnerCounts>
}

interface WorkContextValue {
  work: AgentWork
  counts: ReadonlyMap<string, OwnerCounts>
  /** The owner rule's facts, off the roster (lib/work/bot-owner.ts). */
  owners: BotOwners
}

const WorkContext = createContext<WorkContextValue | null>(null)
// Its own context, so a reader of the cards re-renders on a card, not on every ledger push.
const AttentionContext = createContext<UseAttentionItems | null>(null)
// The ledger channel's rows for other readers: stable, so it re-renders no one.
const WorkRowContext = createContext<OnWorkRow | null>(null)

/** How long the first light load waits for the browser to go idle after boot. */
const BOOT_IDLE_TIMEOUT_MS = 3000
/** Where requestIdleCallback is missing (WebKit), a fixed delay instead. */
const BOOT_FALLBACK_DELAY_MS = 1500

let attentionSeq = 0

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
}

/** Keep only what belongs to `workspaceId`; the same array when nothing is narrowed. */
function inWorkspace<T extends { workspace_id: string }>(list: readonly T[], workspaceId: string | null): T[] {
  return workspaceId ? list.filter((it) => it.workspace_id === workspaceId) : (list as T[])
}

/**
 * `work` as the workspace span shows it: with a workspace to keep, its rows,
 * card rows, roster and workspace list narrowed to it; with none (the
 * switch on, or no active workspace known yet), `work` itself.
 *
 * Each field is narrowed on its own identity, so a ledger push that changed
 * only the rows hands the bots the same roster — the faces (teammate-bots.ts)
 * are rebuilt when the roster or the counts change, not on every push.
 */
export function useWorkInSpan(work: AgentWork, workspaceId: string | null): AgentWork {
  const rows = useMemo(() => (work.rows ? inWorkspace(work.rows, workspaceId) : null), [work.rows, workspaceId])
  const cardRows = useMemo(() => inWorkspace(work.cardRows, workspaceId), [work.cardRows, workspaceId])
  const roster = useMemo(() => inWorkspace(work.roster, workspaceId), [work.roster, workspaceId])
  const workspaceIds = useMemo(
    () => (workspaceId ? work.workspaceIds.filter((id) => id === workspaceId) : work.workspaceIds),
    [work.workspaceIds, workspaceId],
  )
  return useMemo(
    () => (workspaceId ? { ...work, rows, cardRows, roster, workspaceIds } : work),
    [work, workspaceId, rows, cardRows, roster, workspaceIds],
  )
}

/**
 * `work` as the one-face rule draws it (lib/bots/agent-face.ts, always-on-agent
 * §2c): every workspace's Assistant wears the agent's one look and its name
 * (`name`: the person's saved assistant name, else "Assistant"). The area faces stay in
 * the roster (the owner rule reads them, and an id naming one still
 * resolves); drawnBots leaves them out. The same object
 * while nothing changes.
 */
export function useAgentFacedWork(work: AgentWork, name: string): AgentWork {
  const roster = useMemo(() => agentFacedRoster(work.roster, name), [work.roster, name])
  return useMemo(() => (roster === work.roster ? work : { ...work, roster }), [work, roster])
}

/**
 * `work` as the owner rule has it (lib/work/bot-owner.ts): its rows and card
 * rows with work no reachable bot holds named for its workspace's Assistant,
 * and its row channel handing each pushed row on the same way. Each list
 * keeps its identity when nothing in it moves.
 */
export function useOwnedWork(work: AgentWork, owners: BotOwners): AgentWork {
  const rows = useMemo(() => (work.rows ? withBotOwners(work.rows, owners) : null), [work.rows, owners])
  const cardRows = useMemo(() => withBotOwners(work.cardRows, owners), [work.cardRows, owners])
  // The owners a push is read with: the newest, without re-subscribing anyone.
  const ownersRef = useRef(owners)
  useEffect(() => {
    ownersRef.current = owners
  }, [owners])
  const source = work.onWorkRow
  const onWorkRow = useCallback<OnWorkRow>(
    (listener) => source((event) => listener(event.type === 'row' ? { type: 'row', row: withBotOwner(event.row, ownersRef.current) } : event)),
    [source],
  )
  return useMemo(() => ({ ...work, rows, cardRows, onWorkRow }), [work, rows, cardRows, onWorkRow])
}

/** `attention` with each card as the owner rule has it (lib/work/bot-owner.ts withCardOwner). */
export function useOwnedAttention(attention: UseAttentionItems, owners: BotOwners): UseAttentionItems {
  const items = useMemo(() => withCardOwners(attention.items, owners), [attention.items, owners])
  return useMemo(() => (items === attention.items ? attention : { ...attention, items }), [attention, items])
}

/** `attention` with only `workspaceId`'s cards (all of them with none). */
export function useAttentionInSpan(attention: UseAttentionItems, workspaceId: string | null): UseAttentionItems {
  const items = useMemo(() => inWorkspace(attention.items, workspaceId), [attention.items, workspaceId])
  return useMemo(() => (workspaceId ? { ...attention, items } : attention), [attention, workspaceId, items])
}

export function AgentWorkProvider({ children }: { children: ReactNode }) {
  const [bootIdle, setBootIdle] = useState(false)
  useEffect(() => {
    const atIdle = () => setBootIdle(true)
    const w = window as IdleWindow
    let cancelIdle: () => void
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(atIdle, { timeout: BOOT_IDLE_TIMEOUT_MS })
      cancelIdle = () => w.cancelIdleCallback?.(id)
    } else {
      const t = setTimeout(atIdle, BOOT_FALLBACK_DELAY_MS)
      cancelIdle = () => clearTimeout(t)
    }
    return cancelIdle
  }, [])

  // One face: the agent's look and name on every Assistant (the name is this device's, assistant-name.ts).
  const savedName = useAssistantName()
  const allWork = useAgentFacedWork(useAgentWork({ enabled: bootIdle }), agentName(savedName.saved ? savedName.name : null))
  // Unique to this mount: supabase-js hands back the same channel object for a
  // repeated topic, so a fixed name would let another mount tear this one down.
  const [attentionChannel] = useState(() => `attention-rail-${++attentionSeq}`)
  const allAttention = useAttentionItems({ channel: attentionChannel })

  // The workspace span (see the doc): the one workspace to keep, or null for
  // all of them. The workspace cache's id first, the feed's own answer while
  // the cache is still loading.
  const showAll = useShowAllWorkspaces()
  const activeWorkspaceId = useWorkspaceId()
  const keepWorkspaceId = showAll ? null : (activeWorkspaceId ?? allWork.currentWorkspaceId)
  // Who owns what (the owner rule), read off the whole roster: the span only narrows.
  const owners = useMemo(() => botOwnersFromRoster(allWork.roster), [allWork.roster])
  // Whose bot a notice's teammate is (one face: an area face's is its Assistant's).
  const ownerOf = useMemo(() => teammateOwnerOf(allWork.roster), [allWork.roster])
  const work = useOwnedWork(useWorkInSpan(allWork, keepWorkspaceId), owners)
  const attention = useOwnedAttention(useAttentionInSpan(allAttention, keepWorkspaceId), owners)

  // The unread failed runs' notices the window holds (bots-v4 Phase 4c): held
  // by what they are, so a notice landing elsewhere recounts nothing.
  const { botNotices } = useNotifications()
  const failedSig = botNotices
    .filter(isUnreadFailedNotice)
    .map((n) => `${n.id}:${noticeTeammateId(n.metadata)}`)
    .join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const failed = useMemo(() => botNotices.filter(isUnreadFailedNotice), [failedSig])

  const counts = useMemo(() => {
    const rows = work.rows ?? []
    return withFailedNotices(countByOwner(rows, attention.items, cardLookupRows(rows, work.cardRows)), failed, ownerOf)
  }, [work.rows, work.cardRows, attention.items, failed, ownerOf])

  const value = useMemo(() => ({ work, counts, owners }), [work, counts, owners])
  return (
    <WorkContext.Provider value={value}>
      <WorkRowContext.Provider value={work.onWorkRow}>
        <AttentionContext.Provider value={attention}>{children}</AttentionContext.Provider>
      </WorkRowContext.Provider>
    </WorkContext.Provider>
  )
}

function useWorkContext(): WorkContextValue {
  const ctx = useContext(WorkContext)
  if (!ctx) throw new Error('Agent work is read inside AgentWorkProvider (the dashboard shell)')
  return ctx
}

/**
 * The shell's `tracked_job` channel, for a reader that keeps rows of its own
 * (a bot's work, use-bot-work.ts): every row it delivers, and `resync` when it
 * comes up again. Stable for the shell's life; reading it re-renders nothing.
 */
export function useOnWorkRow(): OnWorkRow {
  const onWorkRow = useContext(WorkRowContext)
  if (!onWorkRow) throw new Error('Work rows are read inside AgentWorkProvider (the dashboard shell)')
  return onWorkRow
}

/** The shell's attention cards. */
export function useSharedAttention(): UseAttentionItems {
  const attention = useContext(AttentionContext)
  if (!attention) throw new Error('Attention cards are read inside AgentWorkProvider (the dashboard shell)')
  return attention
}

/**
 * The shared source's work and counts, or null outside AgentWorkProvider (a
 * surface rendered on its own): the side panel's Agents row (chat-widgets.tsx)
 * and the delegate badge read it, and show nothing without it. Re-renders on
 * the same changes useAgentWorkShared does, minus the cards.
 */
export function useOptionalAgentWork(): Pick<AgentWorkShared, 'work' | 'counts'> | null {
  const ctx = useContext(WorkContext)
  return ctx ? { work: ctx.work, counts: ctx.counts } : null
}

/**
 * The whole shared source (work, cards and counts), or null outside
 * AgentWorkProvider: for a surface mounted where the provider may be absent
 * (the chat's For you column, inside a chat panel rendered on its own in a
 * test), which then simply shows nothing. Re-renders as useAgentWorkShared.
 */
export function useOptionalAgentWorkShared(): AgentWorkShared | null {
  const ctx = useContext(WorkContext)
  const attention = useContext(AttentionContext)
  return useMemo(
    () => (ctx && attention ? { work: ctx.work, attention, counts: ctx.counts } : null),
    [ctx, attention],
  )
}

/**
 * The owner rule's facts (lib/work/bot-owner.ts: each workspace's Assistant,
 * the bots you can reach), off the shared roster, for a reader with rows of
 * its own (a record's "Agent activity"); no owners outside the provider, so
 * nothing falls back there.
 */
export function useBotOwners(): BotOwners {
  return useContext(WorkContext)?.owners ?? NO_BOT_OWNERS
}

/** The shared source (the bots read this). */
export function useAgentWorkShared(): AgentWorkShared {
  const { work, counts } = useWorkContext()
  return { work, attention: useSharedAttention(), counts }
}
