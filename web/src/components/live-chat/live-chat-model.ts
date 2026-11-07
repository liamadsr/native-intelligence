/**
 * What the live chat shows, read from the capture conversation's messages
 * (components/live-chat/live-chat.tsx). Pure: no React, no fetches.
 *
 * The conversation holds two writers' rows:
 *   - the person's turns and the live agent's replies (the chat's own eve
 *     transport writes both);
 *   - the ambient loop's rows (lib/live-agent/conversation-writer.ts):
 *     `say_to_user` heads-ups, an `ask_user` question (a `tool-ask_user` part
 *     that's `input-available` until answered) and the rolling proposals card
 *     (`proposals-<capture>`, a `data-proposals` part, grown in place).
 *
 * The card shows the proposals as one line above the thread and the open
 * question above the box, so neither is part of the thread. The rest is
 * grouped into exchanges: each of the person's messages starts one, and what
 * the agent says after it belongs to it (what it says before the first is an
 * exchange of its own). Collapsed, the card shows the last two.
 */
import type { UIMessage } from '@ai-sdk/react'
import type { AgentQuestion } from '@/lib/chat/eve/agent-question'

/** How many exchanges the collapsed chat shows. */
export const COLLAPSED_EXCHANGES = 2

export type LiveChatRow =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'reply'; id: string; text: string }
  | { kind: 'say'; id: string; text: string; nudgeKind: string }
  | { kind: 'question'; id: string; toolCallId: string; questions: AgentQuestion[]; open: boolean }
  | { kind: 'proposals'; id: string; captureId: string; proposalIds: string[] }

/** A row of the thread (not the proposals line, not a question). */
export type ThreadRow = Extract<LiveChatRow, { kind: 'user' | 'reply' | 'say' }>

type Part = Record<string, unknown> & { type?: string }

function textOf(parts: readonly Part[]): string {
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
    .trim()
}

function metaKind(message: UIMessage): string | null {
  const meta = message.metadata as Record<string, unknown> | undefined
  return meta && typeof meta.kind === 'string' ? meta.kind : null
}

/** The conversation's messages as rows, in order. A message with nothing to show is left out. */
export function liveChatRows(messages: readonly UIMessage[]): LiveChatRow[] {
  const rows: LiveChatRow[] = []
  for (const message of messages) {
    const parts = (Array.isArray(message.parts) ? message.parts : []) as Part[]
    if (message.role === 'user') {
      const text = textOf(parts)
      if (text) rows.push({ kind: 'user', id: message.id, text })
      continue
    }
    if (message.role !== 'assistant') continue

    const proposals = parts.find((p) => p.type === 'data-proposals')
    if (proposals) {
      const data = (proposals.data ?? {}) as { capture_id?: unknown; proposal_ids?: unknown }
      const ids = Array.isArray(data.proposal_ids) ? data.proposal_ids.filter((x): x is string => typeof x === 'string') : []
      if (typeof data.capture_id === 'string' && ids.length > 0) {
        rows.push({ kind: 'proposals', id: message.id, captureId: data.capture_id, proposalIds: ids })
      }
      continue
    }

    const ask = parts.find((p) => p.type === 'tool-ask_user' && typeof p.toolCallId === 'string')
    if (ask) {
      const input = (ask.input ?? {}) as { questions?: unknown }
      const questions = Array.isArray(input.questions) ? (input.questions as AgentQuestion[]) : []
      rows.push({
        kind: 'question',
        id: message.id,
        toolCallId: ask.toolCallId as string,
        questions,
        open: ask.state === 'input-available',
      })
      continue
    }

    const text = textOf(parts)
    if (metaKind(message) === 'say_to_user') {
      const meta = message.metadata as Record<string, unknown>
      if (text) rows.push({ kind: 'say', id: message.id, text, nudgeKind: typeof meta.nudge_kind === 'string' ? meta.nudge_kind : 'insight' })
      continue
    }
    // A reply (or the agent's greeting). One still streaming with no words
    // yet is kept, empty: the card shows it thinking.
    rows.push({ kind: 'reply', id: message.id, text })
  }
  return rows
}

/** The thread's rows grouped into exchanges, oldest first. */
export function exchangesOf(rows: readonly LiveChatRow[]): ThreadRow[][] {
  const groups: ThreadRow[][] = []
  for (const row of rows) {
    if (row.kind !== 'user' && row.kind !== 'reply' && row.kind !== 'say') continue
    if (row.kind === 'user' || groups.length === 0) groups.push([row])
    else groups[groups.length - 1].push(row)
  }
  return groups
}

/** The rows of the last `count` exchanges. */
export function lastExchanges(rows: readonly LiveChatRow[], count = COLLAPSED_EXCHANGES): ThreadRow[] {
  return exchangesOf(rows).slice(-count).flat()
}

/** The question the ambient loop is waiting on (the latest unanswered one), or null. */
export function openQuestion(rows: readonly LiveChatRow[]): Extract<LiveChatRow, { kind: 'question' }> | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row.kind === 'question') return row.open ? row : null
  }
  return null
}

/** The rolling proposals card (the latest one), or null. */
export function proposalsRow(rows: readonly LiveChatRow[]): Extract<LiveChatRow, { kind: 'proposals' }> | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row.kind === 'proposals') return row
  }
  return null
}

/** A heads-up's words, compared across its two paths (the chat row and the HUD's broadcast). */
export function sayKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** A heads-up that reached the HUD as a broadcast (the nudge), not (yet) as a conversation row. */
export interface BroadcastSay {
  /** The nudge's id: the same id as its conversation row (ui_message.id). */
  id: string
  text: string
  kind?: string
  /** The row it came after when it arrived (null: before everything): where it shows. */
  after: string | null
}

/**
 * `rows` with the broadcast heads-ups the conversation doesn't hold, each as
 * a say row after the row it arrived after. A say_to_user reaches the HUD
 * twice — its conversation row and its broadcast — so it shows once: as the
 * row when there is one (the row is the record), else as the broadcast (the
 * row is not in yet, or its write failed).
 *
 * The two share one id (lib/live-agent/tools.ts), so a broadcast is held when
 * a say row has its id. The words are the fallback, for a row written before
 * the ids matched. A broadcast row keeps the nudge's id, so when its row
 * lands the thread swaps one for the other under the same key.
 */
export function withBroadcastSays(rows: readonly LiveChatRow[], says: readonly BroadcastSay[]): LiveChatRow[] {
  if (says.length === 0) return rows as LiveChatRow[]
  const heldIds = new Set<string>()
  const heldText = new Set<string>()
  for (const r of rows) {
    if (r.kind !== 'say') continue
    heldIds.add(r.id)
    heldText.add(sayKey(r.text))
  }
  const pending = says.filter((s) => s.text.trim() && !heldIds.has(s.id) && !heldText.has(sayKey(s.text)))
  if (pending.length === 0) return rows as LiveChatRow[]
  const asRow = (s: BroadcastSay): LiveChatRow => ({ kind: 'say', id: s.id, text: s.text.trim(), nudgeKind: s.kind ?? 'insight' })
  const ids = new Set(rows.map((r) => r.id))
  const out: LiveChatRow[] = pending.filter((s) => s.after === null).map(asRow)
  for (const row of rows) {
    out.push(row)
    for (const s of pending) if (s.after === row.id) out.push(asRow(s))
  }
  // Its row gone from the thread: at the foot.
  for (const s of pending) if (s.after !== null && !ids.has(s.after)) out.push(asRow(s))
  return out
}

/** `messages` with the ask_user part `toolCallId` answered (state and output), the rest untouched. */
export function withQuestionAnswered(messages: UIMessage[], toolCallId: string, output: Record<string, unknown>): UIMessage[] {
  let changed = false
  const next = messages.map((m) => {
    if (m.role !== 'assistant') return m
    let hit = false
    const parts = m.parts.map((p) => {
      const part = p as Part
      if (part.type !== 'tool-ask_user' || part.toolCallId !== toolCallId) return p
      hit = true
      return { ...part, state: 'output-available', output } as unknown as typeof p
    })
    if (!hit) return m
    changed = true
    return { ...m, parts }
  })
  return changed ? next : messages
}

/** A reply's markdown as plain text for a small card: no #, *, `, or table pipes; bullets kept as •. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, ''))
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
