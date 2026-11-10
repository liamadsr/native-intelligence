/**
 * What a card in the chat keeps per device, keyed by its show tool call
 * (docs/plans/one-agent-and-chat-pages.md: "Your own changes stay with the
 * card"). The person's filters, sort, columns and search, a record they opened
 * inside it, whether they collapsed it, when they last touched it, and what it
 * showed then (its query, count and first rows), so after a reload the agent's
 * note rebuilds exactly, before the card even mounts. It never rewrites the
 * agent's tool result.
 *
 * Browser storage is a per-device convenience: every read and write is
 * guarded, and a card without its record is simply the agent's page.
 */
import type { CalendarQuery, CardOpenType, CardQuery, MailQuery } from '@/lib/chat-cards/kinds'
import type { OpenCardSeed } from '@/lib/chat-cards/open-card'
import type { PagePlace } from '@/lib/chat-cards/pages'
import { storageKeyAfterRename } from '@/lib/storage-key-rename'
import type { ViewEntityType } from '@/lib/views/types'

export interface CardOpenRecord {
  type: CardOpenType
  id: string
  label?: string
  /** An action's inner view (its Cloud run, its agents). */
  section?: 'cloud' | 'agents'
}

export interface StoredCardState {
  /** The person's changes to the view config (useViewConfig overrides). */
  overrides?: Record<string, unknown>
  search?: string
  open?: CardOpenRecord | null
  /** The person collapsed it to its pill. */
  collapsed?: boolean
  touchedAt?: number
  /**
   * When the person last had it full screen (or opened it): the pages they
   * opened and visited last stay mounted by it (card-store.ts keptPages).
   */
  visitedAt?: number
  /** What it showed when last mounted, for the agent's note. */
  base?: CardQuery
  cur?: CardQuery
  /** A calendar card: the range it shows now (the person's moves kept). */
  cal?: CalendarQuery
  /** A mail card: the folder, search or thread it shows now. */
  mail?: MailQuery
  count?: number | null
  rows?: Array<{ identifier?: string; title: string }>
  /** A page card: where in the page the person is (null: its top level), and on which tab. */
  at?: PagePlace | null
  tab?: string
  /** A page card: the views-system list it shows now, if any (what `base`/`cur` describe). */
  entity?: ViewEntityType
  /** A page card: the places above `at` the person came through (an eval case's suite), for Back. */
  trail?: PagePlace[]
  /** A page card: what its page's full-screen editor is on (the flow canvas), null for none. */
  editing?: string | null
  /** The flows card: the run its editor lands on when it opens (a notification about one run). */
  editingRun?: string | null
  /** A page card: the person's changes to each list inside it, by entity and scope. */
  lists?: Record<string, Record<string, unknown>>
  /** The saved view each list inside the card has picked (null: the page itself), by list. */
  views?: Record<string, string | null>
  savedAt?: number
}

const PREFIX = 'ni:chat-card:'
/** A card nobody touched for this long loses its record (it is the agent's page again). */
export const CARD_STATE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000

function key(toolCallId: string): string {
  return `${PREFIX}${toolCallId}`
}

/**
 * Where a card opened from outside the chat starts (lib/chat-cards/open-card.ts),
 * as the state its body reads when it mounts.
 */
export function seedCardState(seed: OpenCardSeed): StoredCardState {
  const out: StoredCardState = {}
  if (seed.open) out.open = { type: seed.open.type, id: seed.open.id, ...(seed.open.label ? { label: seed.open.label } : {}) }
  if (seed.at !== undefined) out.at = seed.at
  if (seed.trail) out.trail = seed.trail
  if (seed.editing !== undefined) out.editing = seed.editing
  if (seed.editingRun) out.editingRun = seed.editingRun
  return out
}

export function readCardState(toolCallId: string): StoredCardState {
  try {
    const raw = window.localStorage.getItem(key(toolCallId))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as StoredCardState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeCardState(toolCallId: string, state: StoredCardState): void {
  try {
    window.localStorage.setItem(key(toolCallId), JSON.stringify({ ...state, savedAt: Date.now() }))
  } catch {
    /* storage full or blocked: the card keeps working, unremembered */
  }
}

/** Drop the records of cards untouched for CARD_STATE_MAX_AGE_MS. Cheap; safe to call on mount. */
export function sweepCardStates(now = Date.now()): void {
  try {
    const stale: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      // The copy the storage rename script left under the old name is judged, and goes, with it.
      if (!k || !storageKeyAfterRename(k).startsWith(PREFIX)) continue
      try {
        const saved = (JSON.parse(window.localStorage.getItem(k) ?? '{}') as StoredCardState).savedAt ?? 0
        if (now - saved > CARD_STATE_MAX_AGE_MS) stale.push(k)
      } catch {
        stale.push(k)
      }
    }
    for (const k of stale) window.localStorage.removeItem(k)
  } catch {
    /* storage unavailable */
  }
}
