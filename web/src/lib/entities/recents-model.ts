/**
 * RECENT as plain data, shared by the server's direct reads (./recents.ts)
 * and the home panel (page-panel/recents-model.ts): one row's shape, the kinds
 * a row can be, and the filter's types. Client-safe and pure.
 * docs/plans/recent-panel.md.
 */
import type { ActivityEntityType } from '@/lib/knowledge/entity-registry'

/**
 * What a row can be: a kind of the activity log, or one read from its own
 * table (a Drive file, a coding job; through 713's my_recent_work a team chat
 * channel, a spreadsheet, a canvas, an agent chat).
 */
export type RecentKind = ActivityEntityType | 'attachment' | 'code_job' | 'team_chat_channel' | 'spreadsheet' | 'canvas' | 'conversation'

/** One record the person did something to, from its own table: its newest time (ISO). */
export interface RecentSourceEntry {
  type: RecentKind
  id: string
  label: string
  /** Where it sits, when that helps. */
  context: string | null
  at: string
  /** A coding chat (`code_job`): what its row shows of it beyond its title. Absent for every other kind. */
  code?: RecentCodeInfo
}

/**
 * A coding chat as Recent's row needs it (docs/plans/one-home.md: "a coding
 * chat is a row like any other", with its state): the session's own columns,
 * read with the row, so the list makes no second read.
 */
export interface RecentCodeInfo {
  /** The session's status (lib/local-agent/store.ts LocalAgentStatus). */
  status: string
  /** What its agent last signalled: a question, a finished turn, or neither. */
  lastSignal: 'ask' | 'finish' | null
  /** Its current turn's ledger row (the work item its review hangs on), or null. */
  workItemId: string | null
  /** The action it works (an action's Start), by its identifier (ENG-42), or null. */
  actionIdentifier: string | null
  /** The Mac has it waiting in its line (claimed, not begun). */
  queuedOnMac: boolean
}

/** GET /api/account/recents's answer. */
export interface RecentsResponse {
  entries: RecentSourceEntry[]
  workspace_id: string
}

export const RECENTS_URL = '/api/account/recents'

// ── The filter's types ─────────────────────────────────────

/** The Type filter's choices: one per kind the person would name (several record kinds can share one). */
export type RecentTypeKey =
  | 'channels'
  | 'chats'
  | 'email'
  | 'agents'
  | 'docs'
  | 'actions'
  | 'projects'
  | 'initiatives'
  | 'spreadsheets'
  | 'canvases'
  | 'tables'
  | 'files'
  | 'contacts'
  | 'companies'
  | 'captures'
  | 'flows'

/**
 * The Type's word for the person's coding chats (docs/plans/one-home.md, decision 3; listed with One Home's other
 * decisions in app/account/(dashboard)/chat/one-home-decisions.ts). It was "Agents".
 */
export const CODING_TYPE_LABEL = 'Coding'

/** In the filter's order, with their words. */
export const RECENT_TYPES: ReadonlyArray<{ key: RecentTypeKey; label: string }> = [
  { key: 'channels', label: 'Channels' },
  { key: 'chats', label: 'Chats' },
  { key: 'email', label: 'Email' },
  // The person's coding chats (code_job). The key is from when the word was "Agents": a saved filter holds.
  { key: 'agents', label: CODING_TYPE_LABEL },
  { key: 'docs', label: 'Docs' },
  { key: 'actions', label: 'Actions' },
  { key: 'projects', label: 'Projects' },
  { key: 'initiatives', label: 'Initiatives' },
  { key: 'spreadsheets', label: 'Spreadsheets' },
  { key: 'canvases', label: 'Canvases' },
  { key: 'tables', label: 'Tables and deals' },
  { key: 'files', label: 'Files' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'companies', label: 'Companies' },
  { key: 'captures', label: 'Captures' },
  { key: 'flows', label: 'Flows' },
]

/** The Type a row's kind falls under, or null for a kind the filter has no word for. */
export function recentTypeOf(kind: string): RecentTypeKey | null {
  switch (kind) {
    case 'team_chat_channel':
    case 'team_chat_message':
      return 'channels'
    case 'conversation':
      return 'chats'
    case 'email_thread':
      return 'email'
    case 'code_job':
      return 'agents'
    case 'document':
      return 'docs'
    case 'action':
      return 'actions'
    case 'project':
      return 'projects'
    case 'initiative':
      return 'initiatives'
    case 'spreadsheet':
      return 'spreadsheets'
    case 'canvas':
      return 'canvases'
    case 'data_table':
    case 'data_row':
      return 'tables'
    case 'attachment':
      return 'files'
    case 'contact':
      return 'contacts'
    case 'company':
      return 'companies'
    case 'capture':
      return 'captures'
    case 'flow':
      return 'flows'
    default:
      return null
  }
}

const TITLE_MAX = 120

/** A free-text request's first line with something in it, on one line, cut to a title ("Untitled" for none). */
export function firstLineTitle(text: string | null | undefined): string {
  const line = (text ?? '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) ?? ''
  if (!line) return 'Untitled'
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line
}
