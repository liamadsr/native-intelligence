/**
 * A call's outcome in the owner's home thread, one message per burst (P13;
 * Liam, 2026-10-20: "Add them itself when it's confident, with undo; only ask
 * in chat when it isn't sure").
 *
 * Nothing about what Triage decides changes here. Its gates are the ones it
 * always had (src/lib/flows/verdict-apply.ts: decideAutoApply's verdict
 * authority — the person's own explicit commitment, confidence at the flow's
 * floor, act mode, actions only; Attempt mode for work; a new to-do it isn't
 * sure of stays in its capture as before). Only where the result shows moves:
 *
 *   - what it ADDED on its own (an auto-applied create: an action) is said
 *     with its identifier and an Undo (the capture's existing undo route,
 *     undoAppliedProposal: the action is deleted, the proposal re-staged);
 *   - what it ASKS (every card but a post draft or an approval: a change it
 *     wasn't sure of, an email to draft, work to start, a question) is inline,
 *     each card with its own verbs;
 *   - nothing reaches For you, and a call that added and asked nothing writes
 *     nothing.
 *
 * A run that added or carded something sends `home/asks.requested` with what
 * it added. The Inngest function batches those per person and workspace
 * (HOME_ASKS_BATCH_TIMEOUT), so a burst (a morning of calls processed
 * together, the reconciler re-reading a backlog) is ONE message, and runs one
 * batch at a time per person. announcePendingAsks then:
 *
 *   - reads the person's pending, unexpired asking cards no message has asked
 *     yet (`payload.asked_in_chat_at` unset; an approval asks by itself,
 *     src/lib/safety/approvals.ts), at most ASKS_PER_MESSAGE;
 *   - groups them, with what the batch's runs added, by source: the call
 *     (`capture_id`), else the run;
 *   - writes ONE agent message: per source a line in Native Intelligence's own words ("From
 *     your call “Acme sync”: added 2 actions (ENG-51, ENG-52), and one
 *     suggestion to look at.") and a `data-ask-cards` part (chat-ask-card.tsx
 *     ChatAskCardGroup: the added items each with Undo, then the cards). Its id
 *     comes from what it holds, so a retried step writes it once;
 *   - marks each card asked (a payload key), so it is never asked again.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendHomeMessage } from '@/lib/chat/home-message-writer'
import { ASK_CARDS_MESSAGE_KIND, ASK_CARDS_PART_TYPE, isChatAskCard, type AskCardsPartData, type AddedItem } from './chat-asks'
import { normalizeProposedChange } from '@/lib/proposed-changes/appliable-combos'
import { escapeMarkdownInline } from '@/lib/chat/teammate-report'

/** The event a run that added or carded something sends (consumer: src/lib/inngest/home-asks.ts). */
export const HOME_ASKS_REQUESTED_EVENT = 'home/asks.requested' as const
/**
 * A burst of runs is one message: a batch closes this long after its first run.
 * Inngest refuses a batch timeout longer than 30 s on this account's plan (and,
 * like the batch size below, that refusal fails the whole app sync).
 */
export const HOME_ASKS_BATCH_TIMEOUT = '30s'
/**
 * …or once this many runs are in it. Inngest refuses a batch larger than 5 on
 * this account's plan, and that refusal fails the WHOLE app sync (every
 * function's changes stay unregistered), so this must stay at 5 or below.
 * A bigger burst simply becomes a second message shortly after.
 */
export const HOME_ASKS_BATCH_MAX = 5
/** At most this many cards in one message. */
export const ASKS_PER_MESSAGE = 20
/** At most this many added items one run reports. */
export const ADDED_PER_RUN = 20
/** Cards older than this are not announced late (they were in For you before P13, or will expire). */
export const ASKS_LOOKBACK_MS = 48 * 60 * 60_000
/** The payload key that says a card has been asked in the chat. */
export const ASKED_KEY = 'asked_in_chat_at'

export interface HomeAsksRequested {
  workspaceId: string
  userId: string
  /** What the run added on its own (an auto-applied create), for the message's "added … · Undo". */
  added?: AddedItem[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An added item off an event, shape-checked (an event is data), or null. */
export function parseAddedItem(value: unknown): AddedItem | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.change_id !== 'string' || !UUID_RE.test(v.change_id)) return null
  if (typeof v.entity_id !== 'string' || !UUID_RE.test(v.entity_id)) return null
  const entityType = typeof v.entity_type === 'string' && /^[a-z_]{1,40}$/.test(v.entity_type) ? v.entity_type : 'action'
  const title = typeof v.title === 'string' ? v.title.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  return {
    change_id: v.change_id,
    entity_id: v.entity_id,
    entity_type: entityType,
    ...(typeof v.capture_id === 'string' && UUID_RE.test(v.capture_id) ? { capture_id: v.capture_id } : {}),
    ...(typeof v.source === 'string' && v.source.trim() ? { source: v.source.trim().slice(0, 120) } : {}),
    ...(title ? { title } : {}),
    ...(typeof v.identifier === 'string' && /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/.test(v.identifier) ? { identifier: v.identifier } : {}),
  }
}

/** The event's data, shape-checked. */
export function parseHomeAsksRequested(data: unknown): HomeAsksRequested | null {
  const d = (data ?? {}) as Record<string, unknown>
  if (!(typeof d.workspaceId === 'string' && d.workspaceId && typeof d.userId === 'string' && d.userId)) return null
  const added = Array.isArray(d.added) ? d.added.map(parseAddedItem).filter((a): a is AddedItem => !!a).slice(0, ADDED_PER_RUN) : []
  return { workspaceId: d.workspaceId, userId: d.userId, ...(added.length ? { added } : {}) }
}

/**
 * A batch's requests as one (the batch key keeps them to one person and
 * workspace): every run's added items, each once, in order. Null when none
 * is readable.
 */
export function mergeHomeAsksRequests(data: readonly unknown[]): HomeAsksRequested | null {
  const requests = data.map(parseHomeAsksRequested).filter((r): r is HomeAsksRequested => !!r)
  const first = requests[0]
  if (!first) return null
  const mine = requests.filter((r) => r.workspaceId === first.workspaceId && r.userId === first.userId)
  const seen = new Set<string>()
  const added: AddedItem[] = []
  for (const r of mine) {
    for (const a of r.added ?? []) {
      if (seen.has(a.change_id)) continue
      seen.add(a.change_id)
      added.push(a)
    }
  }
  return { workspaceId: first.workspaceId, userId: first.userId, ...(added.length ? { added } : {}) }
}

/** Ask for the batched message (best effort: a lost request leaves the cards for the next one). */
export async function requestHomeAsks(
  args: HomeAsksRequested,
  send?: (event: { name: string; data: Record<string, unknown> }) => Promise<unknown>,
): Promise<void> {
  try {
    const event = {
      name: HOME_ASKS_REQUESTED_EVENT,
      data: { workspaceId: args.workspaceId, userId: args.userId, ...(args.added?.length ? { added: args.added.slice(0, ADDED_PER_RUN) } : {}) },
    }
    if (send) await send(event)
    else {
      const { inngest } = await import('@/lib/inngest/client')
      await inngest.send(event)
    }
  } catch (err) {
    console.warn('[home-asks] could not request the home ask:', err instanceof Error ? err.message : String(err))
  }
}

export interface AskCardRow {
  id: string
  kind: string
  title: string
  payload: Record<string, unknown> | null
  run_key: string | null
  created_at: string
}

export interface AskGroup {
  key: string
  /** Native Intelligence's words for where they came from ("your call “Acme sync”"). */
  source: string
  added: AddedItem[]
  cards: AskCardRow[]
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : null
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

const LOOPS = 'one of your loops'

/** A source's words: the call's title, else the skill's name, else "one of your loops". Pure. */
export function sourceWords(captureTitle: unknown, skillName: unknown): string {
  const call = str(captureTitle)
  if (call) return `your call “${clip(call, 80)}”`
  const skill = str(skillName)
  return skill ? clip(skill, 60) : LOOPS
}

/**
 * What was added and what asks, grouped by source (a call, else a run), each
 * group's cards oldest first, groups in the order their first item arrived. Pure.
 */
export function groupAsks(cards: readonly AskCardRow[], added: readonly AddedItem[] = []): AskGroup[] {
  const groups = new Map<string, AskGroup>()
  const at = (key: string, source: string): AskGroup => {
    let g = groups.get(key)
    if (!g) {
      g = { key, source, added: [], cards: [] }
      groups.set(key, g)
    }
    return g
  }
  for (const item of added) {
    const key = item.capture_id ? `capture:${item.capture_id}` : `added:${item.source ?? LOOPS}`
    const g = at(key, item.source ?? LOOPS)
    if (!g.added.some((a) => a.change_id === item.change_id)) g.added.push(item)
  }
  for (const card of [...cards].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const p = card.payload ?? {}
    const capture = str(p.capture_id)
    const key = capture ? `capture:${capture}` : card.run_key ? `run:${card.run_key}` : `card:${card.id}`
    at(key, sourceWords(p.capture_title, p.skill_name)).cards.push(card)
  }
  return [...groups.values()]
}

/** What a group's cards ask, in a few words: "3 things to add", "a question", "2 suggestions". Pure. */
export function asksPhrase(cards: readonly Pick<AskCardRow, 'kind' | 'payload'>[]): string {
  const n = cards.length
  const allAdd = cards.every((c) => c.kind === 'action_card' && normalizeProposedChange(c.payload ?? {}).change_type === 'create')
  if (allAdd) return n === 1 ? 'one thing to add' : `${n} things to add`
  if (cards.every((c) => c.kind === 'work_proposal')) return n === 1 ? 'one piece of work to start' : `${n} pieces of work to start`
  if (cards.every((c) => c.kind === 'question')) return n === 1 ? 'a question' : `${n} questions`
  return n === 1 ? 'one suggestion to look at' : `${n} suggestions to look at`
}

/** What a group added, in a few words: "added 2 actions (ENG-51, ENG-52)". Pure. */
export function addedPhrase(added: readonly AddedItem[]): string {
  const n = added.length
  const noun = added.every((a) => a.entity_type === 'action') ? (n === 1 ? 'action' : 'actions') : n === 1 ? 'item' : 'items'
  const ids = added.flatMap((a) => (a.identifier ? [a.identifier] : []))
  const named = ids.length ? ` (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? `, +${ids.length - 4}` : ''})` : ''
  return `added ${n === 1 ? 'one' : n} ${noun}${named}`
}

/**
 * One group's line, in Native Intelligence's words around the source's title. Pure. The
 * line is markdown in the agent's voice, so the title (a calendar invite's,
 * a skill's name: anyone's text) is escaped: it can never become a link or
 * emphasis there.
 */
export function groupLine(group: AskGroup): string {
  const from = group.source === LOOPS ? 'From one of your loops' : `From ${escapeMarkdownInline(group.source)}`
  const said = [group.added.length ? addedPhrase(group.added) : null, group.cards.length ? asksPhrase(group.cards) : null].filter(Boolean)
  const body = said.length === 2 ? `${said[0]}, and ${said[1]}` : (said[0] ?? '')
  return `${from}: ${body}.`
}

/** The message's id: one per set of things it holds, so a retried step converges on one row. */
export function asksMessageId(cardIds: readonly string[], addedIds: readonly string[] = []): string {
  return `ask-cards-${createHash('sha256').update(`${[...cardIds].sort().join(',')}|${[...addedIds].sort().join(',')}`).digest('hex').slice(0, 24)}`
}

export type AnnounceOutcome = { written: boolean; cards: number; added: number; groups: number; reason?: string }

/** The added items' identifiers (ENG-51), read once for the actions among them. Never throws. */
async function withIdentifiers(supabase: SupabaseClient, workspaceId: string, added: AddedItem[]): Promise<AddedItem[]> {
  const ids = added.filter((a) => a.entity_type === 'action' && !a.identifier).map((a) => a.entity_id)
  if (!ids.length) return added
  try {
    const { data } = await supabase.from('actions').select('id, identifier').eq('workspace_id', workspaceId).in('id', ids)
    const byId = new Map(((data ?? []) as Array<{ id: string; identifier: string | null }>).map((r) => [r.id, r.identifier]))
    return added.map((a) => {
      const identifier = byId.get(a.entity_id)
      return identifier && /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/.test(identifier) ? { ...a, identifier } : a
    })
  } catch {
    return added
  }
}

/**
 * Say in the person's home thread what their runs added and ask what they
 * weren't sure of, in one message (see the header). Service client. Never throws.
 */
export async function announcePendingAsks(
  supabase: SupabaseClient,
  args: HomeAsksRequested & { nowMs?: number },
  deps: { append?: typeof appendHomeMessage } = {},
): Promise<AnnounceOutcome> {
  const nowMs = args.nowMs ?? Date.now()
  const none = (reason: string): AnnounceOutcome => ({ written: false, cards: 0, added: 0, groups: 0, reason })
  try {
    const { data: member } = await supabase.from('member').select('id').eq('workspace_id', args.workspaceId).eq('user_id', args.userId).maybeSingle<{ id: string }>()
    if (!member?.id) return none('not_a_member')
    const nowIso = new Date(nowMs).toISOString()
    const { data, error } = await supabase
      .from('attention_item')
      .select('id, kind, title, payload, run_key, created_at, expires_at')
      .eq('workspace_id', args.workspaceId)
      .eq('member_id', member.id)
      .eq('status', 'pending')
      .neq('kind', 'approval')
      .gte('created_at', new Date(nowMs - ASKS_LOOKBACK_MS).toISOString())
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) return none('read_failed')
    const fresh = ((data ?? []) as Array<AskCardRow & { expires_at: string | null }>)
      .filter((c) => isChatAskCard(c) && !(c.payload && typeof c.payload === 'object' && ASKED_KEY in c.payload))
      .slice(0, ASKS_PER_MESSAGE)
    const added = await withIdentifiers(supabase, args.workspaceId, args.added ?? [])
    // A call that added and asked nothing says nothing.
    if (!fresh.length && !added.length) return none('nothing_to_say')
    const groups = groupAsks(fresh, added)
    const parts: Array<{ type: string; text?: string; data?: AskCardsPartData }> = []
    for (const group of groups) {
      parts.push({ type: 'text', text: groupLine(group) })
      parts.push({
        type: ASK_CARDS_PART_TYPE,
        data: {
          card_ids: group.cards.map((c) => c.id),
          workspace_id: args.workspaceId,
          source: group.source,
          ...(group.added.length ? { added: group.added } : {}),
        },
      })
    }
    const ids = fresh.map((c) => c.id)
    const written = await (deps.append ?? appendHomeMessage)(supabase, {
      userId: args.userId,
      workspaceId: args.workspaceId,
      messageId: asksMessageId(ids, added.map((a) => a.change_id)),
      parts: parts as never,
      metadata: { kind: ASK_CARDS_MESSAGE_KIND, card_ids: ids, added_change_ids: added.map((a) => a.change_id) },
    })
    if (!written.written && written.reason) return { written: false, cards: ids.length, added: added.length, groups: groups.length, reason: written.reason }
    // Asked: never again (fenced on still pending; a settled one needs nothing).
    for (const card of fresh) {
      await supabase
        .from('attention_item')
        .update({ payload: { ...(card.payload ?? {}), [ASKED_KEY]: nowIso } })
        .eq('id', card.id)
        .eq('status', 'pending')
    }
    return { written: true, cards: ids.length, added: added.length, groups: groups.length }
  } catch (err) {
    console.warn('[home-asks] could not ask in the home thread:', err instanceof Error ? err.message : String(err))
    return none('error')
  }
}
