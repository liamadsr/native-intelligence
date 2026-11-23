/**
 * The Code view's list, as plain data (Liam, 11-16: "if you start a new
 * coding chat you'd see it in the recent panel on the side"): the person's
 * coding chats, newest first, each once. Every coding job of theirs in the
 * workspace (Liam, 11-20: "shows any chat/agent that's working on something
 * including the ones that were started from an action item"): the Code jobs
 * they started from the composer's Code tab, an action's Start, the chat
 * agent's, a loop's. A job working on an action is named by the action (its
 * identifier and title), so the list shows which actions are being worked on.
 *
 * Pure: no clock, no reads.
 */
import { firstLineTitle } from '@/lib/entities/recents-model'
import { codeJobOpen, codeJobWorking } from '@/lib/local-agent/code-tab'
import type { PanelSession } from '@/components/local-agent/session-api'
import type { SessionAction } from '@/lib/local-agent/store'

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
  /** The action it works (an action's Start), named; null for every other job. */
  action: SessionAction | null
}

/** The request's first line with something in it, on one line, cut to a title. */
export const codeChatTitle = firstLineTitle

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? -Infinity : t
}

/** A job's action, as the list names it: its title (or identifier) to go by, else nothing. */
function actionOf(s: PanelSession): SessionAction | null {
  const a = s.action
  return a && (a.title.trim() || a.identifier) ? a : null
}

/** The person's coding chats from the Code view's list (every coding job in the workspace), newest first. */
export function codeChatsOf(sessions: readonly PanelSession[]): CodeChatItem[] {
  const out: CodeChatItem[] = []
  for (const s of sessions) {
    const action = actionOf(s)
    out.push({
      key: s.id,
      sessionId: s.id,
      workItemId: s.trackedJobId ?? null,
      // An action's job goes by its action (its request is the agent's long brief), every other by what was asked.
      title: action ? codeChatTitle(action.title || action.identifier) : codeChatTitle(s.request),
      folder: s.folderLabel ?? '',
      at: s.updatedAt || s.createdAt,
      working: codeJobWorking(s.status),
      needsYou: codeJobOpen(s.status) && s.lastSignal === 'ask',
      action,
    })
  }
  return out.sort((a, b) => ms(b.at) - ms(a.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
