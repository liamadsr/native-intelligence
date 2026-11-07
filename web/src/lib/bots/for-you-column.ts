/**
 * What the chat's For you column lists (docs/plans/always-on-agent.md,
 * decision 13): everything the bots count for you, across all of them, as
 * each bot's own For you has it (bot-page/for-you.tsx: bubbleItems, then
 * seenItems), one entry per thing, newest first, each with the bot it came
 * from. For each bot drawn, its entries are exactly its own list, so the
 * column's count is the sum of the bots' counts (a card two bots share once).
 *
 *   a card      a post draft or a slow-week idea, the one card that is
 *               delivered work (chat-asks.ts), a run's cards one by one;
 *   a review    a work item waiting on your review (needs_review): a report,
 *               a document, a draft it made;
 *   a draft     an email draft a bot wrote that still waits in Mail
 *               (src/lib/email/agent-drafts.ts, Liam 10-18: each draft its
 *               own card, not one "Reply drafts for 29 threads" item), under
 *               the workspace's Correspondent, else the agent (labelled Mail).
 *
 * For you is delivered work only (P13; Liam, 2026-10-20: "For you is like
 * delivered artifacts, not a place to ask me a question"). Every card but a
 * post draft is the chat's (the shared source's `asks`, never the `cards`
 * given here: src/lib/attention/chat-asks.ts), and a run parked on a question
 * (needs_input) asks in its run's chat and in the home thread, so neither is
 * listed. A review is marked Seen when you've opened it since it started
 * waiting (seenItems). Read off the shell's shared
 * source only, so a thing settled here leaves the bots too, and one settled
 * there leaves here. Pure: no React, no fetch.
 *
 * One face (docs/plans/always-on-agent.md §2c, decision 11): the area faces
 * aren't drawn (drawnBots), their work is the agent's (the owner rule,
 * bot-owner.ts), so it lists under the agent, each card with the area it came
 * from (`area`: Captures, Mail, …) as a small label. Custom agents, role
 * teammates and loop bots keep their own groups and faces.
 */
import type { AttentionItem } from '@/hooks/use-attention-items'
import { AGENT_DRAFT_ITEM_PREFIX, type AgentDraft } from '@/lib/email/agent-drafts'
import type { OwnerCounts } from '@/lib/work/agent-work-lanes'
import type { RosterTeammate } from '@/lib/work/agent-roster'
import { waitingSince } from '@/lib/work/presentation'
import type { CardRunRow } from '@/lib/work/queries'
import type { WorkItem } from '@/lib/work/types'
import { faceAreaOf } from '@/lib/work/bot-owner'
import { isAreaFaceKey } from '@/lib/work/work-area'
import { PACKS, isAreaKey } from '@/lib/packs/registry'
import { isAgentTeammate } from './agent-face'
import { bubbleItems, seenItems, type BubbleCard, type BubbleItem, type BubbleRow } from './bubble-items'
import { drawnBots } from './teammate-faces'

/** The agent a card came from: its id and name. */
export interface ColumnSource {
  teammateId: string
  name: string
  /** The agent's own face (the workspace's Assistant): its cards carry the area they came from. */
  agent?: boolean
}

/** The area label on an agent's card: the area's plain name ("Mail"), or absent for none. */
type AreaLabel = { area?: string }

export type ColumnEntry =
  | ({ kind: 'card'; id: string; at: string; card: AttentionItem; source: ColumnSource } & AreaLabel)
  | ({ kind: 'review'; id: string; at: string; row: BubbleRow; seen: boolean; source: ColumnSource } & AreaLabel)
  | ({ kind: 'draft'; id: string; at: string; draft: AgentDraft; source: ColumnSource } & AreaLabel)

/** A draft entry's id: never one of a card's or a row's (the same id list_bot_work gives it). */
export const DRAFT_ENTRY_PREFIX = AGENT_DRAFT_ITEM_PREFIX

/** An area key's plain name, or undefined for none (or one the registry doesn't know). */
function areaName(area: unknown): string | undefined {
  return isAreaKey(area) ? PACKS[area].name : undefined
}

/** The area a row came from: the area face the owner rule moved it from (`face_area`), else its own `area` (a whole row). */
export function rowAreaName(row: BubbleRow): string | undefined {
  return areaName(faceAreaOf(row) ?? ('area' in row ? row.area : null))
}

/** The area a card came from: the area face that raised it (`raised_by_area`), else its run's row's. */
export function cardAreaName(card: Pick<BubbleCard, 'payload' | 'source_flow_run_id'>, rows: readonly BubbleRow[], cardRows: readonly CardRunRow[]): string | undefined {
  const raised = card.payload?.raised_by_area
  if (isAreaFaceKey(raised)) return areaName(raised)
  const named = typeof card.payload?.work_item_id === 'string' ? card.payload.work_item_id : null
  const run =
    (named ? (rows.find((r) => r.id === named) ?? cardRows.find((r) => r.id === named)) : undefined) ??
    (card.source_flow_run_id ? (rows.find((r) => r.flow_run_id === card.source_flow_run_id) ?? cardRows.find((r) => r.flow_run_id === card.source_flow_run_id)) : undefined)
  return run ? rowAreaName(run as BubbleRow) : undefined
}

export interface ColumnInput {
  roster: readonly (Pick<RosterTeammate, 'id' | 'name' | 'bot_character' | 'reachable'> & Partial<Pick<RosterTeammate, 'workspace_id' | 'is_system' | 'system_key' | 'role'>>)[]
  counts: ReadonlyMap<string, OwnerCounts>
  rows: readonly BubbleRow[]
  cards: readonly BubbleCard[]
  cardRows?: readonly CardRunRow[]
  /** The open drafts the bots wrote (useAgentDrafts). */
  drafts?: readonly AgentDraft[]
}

function timeOf(iso: string): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/**
 * Everything the bots you can see count for you (drawnBots: the crew's own
 * rule), newest first, each once. Ties keep the bots' order.
 */
export function forYouColumnEntries({ roster, counts, rows, cards, cardRows = [], drafts = [] }: ColumnInput): ColumnEntry[] {
  const out: ColumnEntry[] = []
  const have = new Set<string>()
  const drawn = drawnBots(roster)
  // Each draft under the bot that writes a workspace's mail: its Correspondent,
  // else the agent (where the Mail face's work lists), with the Mail label.
  for (const draft of drafts) {
    const inWs = drawn.filter((t) => t.workspace_id === draft.workspace_id)
    const writer = inWs.find((t) => t.role === 'correspondent') ?? inWs.find((t) => isAgentTeammate(t))
    if (!writer) continue
    const agent = isAgentTeammate(writer)
    const id = `${DRAFT_ENTRY_PREFIX}${draft.id}`
    if (have.has(id)) continue
    have.add(id)
    out.push({
      kind: 'draft',
      id,
      at: draft.created_at,
      draft,
      source: { teammateId: writer.id, name: writer.name?.trim() || 'Teammate', ...(agent ? { agent: true } : {}) },
      ...(agent ? { area: areaName('mail') } : {}),
    })
  }
  for (const teammate of drawn) {
    const source: ColumnSource = {
      teammateId: teammate.id,
      name: teammate.name?.trim() || 'Teammate',
      ...(isAgentTeammate(teammate) ? { agent: true } : {}),
    }
    // Only the agent's cards say their area: a custom or role bot's are its own.
    const label = (area: string | undefined): AreaLabel => (source.agent && area ? { area } : {})
    const place = (item: BubbleItem, seen: boolean) => {
      if (item.kind === 'card' || item.kind === 'batch') {
        for (const card of item.kind === 'card' ? [item.card] : item.cards) {
          if (have.has(card.id)) continue
          have.add(card.id)
          out.push({ kind: 'card', id: card.id, at: card.created_at, card: card as AttentionItem, source, ...label(cardAreaName(card, rows, cardRows)) })
        }
        return
      }
      // A row waiting on your review: its output is delivered work. One parked
      // on your answer (needs_input) asks in the chat, not here (P13).
      if (item.row.status !== 'needs_review' || have.has(item.row.id)) return
      have.add(item.row.id)
      out.push({ kind: 'review', id: item.row.id, at: waitingSince(item.row as WorkItem), row: item.row, seen, source, ...label(rowAreaName(item.row)) })
    }
    for (const item of bubbleItems(teammate.id, counts, rows, cards, cardRows)) place(item, false)
    for (const item of seenItems(teammate.id, rows)) place(item, true)
  }
  // Stable: equal times keep the order above.
  return out
    .map((entry, i) => ({ entry, i, t: timeOf(entry.at) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map(({ entry }) => entry)
}

/** One bot's entries in the column, newest first. */
export interface ColumnGroup {
  source: ColumnSource
  entries: ColumnEntry[]
}

/**
 * The column's entries under their bots (Liam, 2026-10-14: "grouped under the
 * same agent"): one group per bot, newest first within it, the groups in order
 * of their newest entry. Takes forYouColumnEntries' list (newest first, each
 * thing once, under the bot it was first placed with), so a bot's first entry
 * is its newest and the groups fall out in order. Ties keep the list's order.
 * A thing listed twice still shows once, under the bot that had it first.
 */
export function groupColumnEntries(entries: readonly ColumnEntry[]): ColumnGroup[] {
  const groups = new Map<string, ColumnGroup>()
  const have = new Set<string>()
  for (const entry of entries) {
    if (have.has(entry.id)) continue
    have.add(entry.id)
    const id = entry.source.teammateId
    const group = groups.get(id)
    if (group) group.entries.push(entry)
    else groups.set(id, { source: entry.source, entries: [entry] })
  }
  return [...groups.values()]
}
