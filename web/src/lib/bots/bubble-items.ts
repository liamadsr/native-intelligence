/**
 * What a bot has waiting on you, as items (bots-v2.md Phase 2, bots-v4.md
 * "What the bubble lists: new, then seen"): `bubbleItems` (what's new) and
 * `seenItems` (what still waits that you've seen), over the shared source's
 * rows, cards and countByOwner's counts.
 *
 * Pure, and safe on the server: no React, no window. The agent's page, the
 * For you column and the main agent's reads (./bot-work-server.ts, bots-v4.md
 * Phase A1) all read it here, so their per-bot lists and counts agree.
 */
import type { UseAttentionItems } from '@/hooks/use-attention-items'
import { mayBeckon, teammateKey, type OwnerCounts } from '@/lib/work/agent-work-lanes'
import type { LightWorkRow } from '@/lib/work/queries'
import { foldsIntoRoot, statusLookup } from '@/lib/work/tree'
import { workNeedsYou, type WorkItem } from '@/lib/work/types'
import { batchKeyOf, batchWorkItemId, type BatchableCard } from './batch'

/** A row the shared source holds. */
export type BubbleRow = WorkItem | LightWorkRow
/** A pending attention card. */
export type BubbleCard = UseAttentionItems['items'][number]

/**
 * One thing new from a teammate: a row waiting on you, a pending card, or a
 * run's cards folded into one (`batch`, bots v3 1b: two or more cards one run
 * left, keyed on the run, `batchKeyOf`).
 */
export type BubbleItem =
  | { kind: 'row'; id: string; row: BubbleRow }
  /** `runChat`: the run that left the card parked its session (bots v3 Phase 4). */
  | { kind: 'card'; id: string; card: BubbleCard; runChat?: true }
  | { kind: 'batch'; id: string; workItemId: string | null; cards: BubbleCard[]; runChat?: true }

/** A ledger row as far as its chat goes: its id and `source` (bots v3 Phase 4, `source.run_chat`). */
export type RunChatRow = { id: string; source?: Record<string, unknown> | null }

/**
 * Whether a row's run parked its session, so its item continues that chat
 * (`source.run_chat`). Never for a row the Assistant shows for a bot you can't
 * reach (`source.owner_fallback`, lib/work/bot-owner.ts): that chat runs as
 * the other bot, so talking about it goes to the Assistant's own thread.
 */
export function rowHasRunChat(row: RunChatRow | null | undefined): boolean {
  return row?.source?.run_chat === true && row.source.owner_fallback !== true
}

/** The run an item is about: a row's own id, a batch's run, a card's stamped run; null when none is known. */
export function itemWorkItemId(item: BubbleItem): string | null {
  if (item.kind === 'row') return item.row.id
  if (item.kind === 'batch') return item.workItemId
  const p = item.card.payload as Record<string, unknown> | null | undefined
  return typeof p?.work_item_id === 'string' && p.work_item_id ? p.work_item_id : null
}

/**
 * What's new from one teammate, in the order its bot calls for them: its
 * `beckoning` (countByOwner: its waiting rows not opened yet, then its pending
 * cards), each as the row or card the source holds. Two or more cards from one
 * run (`batchKeyOf`) are one `batch` item, where the first of them stands; a
 * run's one card stays a card.
 *
 * A card or batch whose run parked its session (its ledger row's
 * `source.run_chat`, found in `rows` or `runRows`: the rows pending cards point
 * at, AgentWork.cardRows) carries `runChat`, so a reply continues that run's
 * chat (bots v3 Phase 4, item-run-chat.ts).
 */
export function bubbleItems(
  teammateId: string,
  counts: ReadonlyMap<string, OwnerCounts>,
  rows: readonly BubbleRow[],
  cards: readonly BubbleCard[],
  runRows: readonly RunChatRow[] = [],
): BubbleItem[] {
  const chatty = new Set<string>()
  for (const r of rows) if (rowHasRunChat(r as RunChatRow)) chatty.add(r.id)
  for (const r of runRows) if (rowHasRunChat(r)) chatty.add(r.id)
  const withChat = <T extends BubbleItem>(item: T): T => {
    if (item.kind === 'row' || chatty.size === 0) return item
    const workItemId = itemWorkItemId(item)
    return workItemId && chatty.has(workItemId) ? { ...item, runChat: true } : item
  }
  const out: Array<BubbleItem | { kind: 'group'; key: string }> = []
  const groups = new Map<string, BubbleCard[]>()
  for (const id of counts.get(teammateKey(teammateId))?.beckoning ?? []) {
    const row = rows.find((r) => r.id === id)
    if (row) {
      out.push({ kind: 'row', id, row })
      continue
    }
    const card = cards.find((c) => c.id === id)
    if (!card) continue
    const key = batchKeyOf(card as BatchableCard)
    if (!key) {
      out.push(withChat({ kind: 'card', id, card }))
      continue
    }
    const group = groups.get(key)
    if (group) group.push(card)
    else {
      groups.set(key, [card])
      out.push({ kind: 'group', key })
    }
  }
  return out.map((entry): BubbleItem => {
    if (entry.kind !== 'group') return entry
    const group = groups.get(entry.key)!
    if (group.length === 1) return withChat({ kind: 'card', id: group[0].id, card: group[0] })
    return withChat({ kind: 'batch', id: entry.key, workItemId: batchWorkItemId(entry.key), cards: group })
  })
}

/**
 * What still waits on you from one teammate but isn't new (bots-v4.md, "What
 * the bubble lists: new, then seen"): its waiting rows you've opened since
 * they last started waiting (`opened_at`), in the rows' order. They are
 * exactly the waiting rows countByOwner counts for it that aren't in its
 * `beckoning`, so nothing is in both this and bubbleItems: a handoff reviewed
 * with its root is skipped (foldsIntoRoot, over every row given), and a row
 * that went back to waiting is new again (the recorder clears `opened_at`).
 * Cards are never in it: a pending card is new until it's settled.
 *
 * Only the bubble's list, the desktop relay's list, the bot's page and the main
 * agent's "what's pending" (bot-work-server.ts) read it, each after
 * bubbleItems (the first two through the bubble's capped list, bubble.ts).
 * Peeks, going out on the desktop, a banner's or bell row's ask, a tap
 * nothing covers, and the dot, hop and coming to you stay new only (the
 * plan's caller table, pinned in seen-items-callers.test.ts).
 */
export function seenItems(teammateId: string, rows: readonly BubbleRow[]): BubbleItem[] {
  const rootStatus = statusLookup(rows)
  const out: BubbleItem[] = []
  for (const row of rows) {
    if (row.ai_team_member_id !== teammateId || !workNeedsYou(row.status)) continue
    if (foldsIntoRoot(row, rootStatus) || mayBeckon(row)) continue
    out.push({ kind: 'row', id: row.id, row })
  }
  return out
}

/**
 * Which of one teammate's items is about run `workItemId` (a notice's): the
 * row itself, the batch of its cards, or its one card. Null when none is.
 */
export function itemForWorkItem(items: readonly BubbleItem[], workItemId: string | null | undefined): BubbleItem | null {
  if (!workItemId) return null
  return items.find((item) => itemWorkItemId(item) === workItemId) ?? null
}
