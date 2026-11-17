/**
 * The Code view's list, as plain data (Liam, 11-16: "if you start a new
 * coding chat you'd see it in the recent panel on the side"): the person's
 * coding chats, the Code jobs they started from the composer's Code tab
 * (lib/local-agent/code-tab.ts codeJobOf), newest first, each once.
 *
 * Pure: no clock, no reads.
 */
import { codeJobOpen, codeJobWorking } from '@/lib/local-agent/code-tab'
import type { PanelSession } from '@/components/local-agent/session-api'

export interface CodeChatItem {
  /** The job's session id: its one key. */
  key: string
  sessionId: string
  /** Its current turn's ledger row: what opens its page; null until it has one (then its session is read). */
  workItemId: string | null
  /** The first line of what the person asked for. */
  title: string
  /** The folder it works in. */
  folder: string
  /** When it last moved (ISO): where it sorts and what its time says. */
  at: string
  /** It works right now. */
  working: boolean
  /** Its agent asked the person something and waits for the answer: the dot. */
  needsYou: boolean
}

const TITLE_MAX = 120

/** The request's first line with something in it, on one line, cut to a title. */
export function codeChatTitle(request: string | null | undefined): string {
  const line = (request ?? '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) ?? ''
  if (!line) return 'Untitled'
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line
}

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? -Infinity : t
}

/** The person's coding chats from their local agents' list: the Code jobs only, newest first. */
export function codeChatsOf(sessions: readonly PanelSession[]): CodeChatItem[] {
  const out: CodeChatItem[] = []
  for (const s of sessions) {
    // A Code job is one the person started from the composer's Code tab (its send's request id).
    if (typeof s.codeRequestId !== 'string' || !s.codeRequestId) continue
    out.push({
      key: s.id,
      sessionId: s.id,
      workItemId: s.trackedJobId ?? null,
      title: codeChatTitle(s.request),
      folder: s.folderLabel ?? '',
      at: s.updatedAt || s.createdAt,
      working: codeJobWorking(s.status),
      needsYou: codeJobOpen(s.status) && s.lastSignal === 'ask',
    })
  }
  return out.sort((a, b) => ms(b.at) - ms(a.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
