/**
 * Which alert sound a live event plays, and the event key that makes it one
 * sound across every window and every path that sees the same happening.
 *
 * The paths (each only ever sees LIVE arrivals — realtime INSERT / UPDATE
 * payloads and streamed chat parts; page loads, refetches, reconnect
 * catch-ups and chat history never come through here):
 *
 *   notification INSERT (toast path only)  → announceNotification
 *   attention_item INSERT                   → announceAttentionItem
 *   tracked_job UPDATE                      → announceWorkTransition
 *   a clarifying question in a live reply   → useAskArrivalSound (./use-ask-arrival-sound)
 *
 * The most specific sound wins. Agent work already writes notification rows
 * (the recorder, src/lib/work/notify.ts): `work_needs_you` when a run parks on
 * a question (needs_input) or finishes with something to review
 * (needs_review), `work_failed` when it fails (at most one per kind per day),
 * and `flow_run_output` for a loop run that surfaced cards ("Triage: 2 need
 * you") or was skipped. Those rows map to the agent sound here, never to
 * notification-alert; the other paths only cover what has no row.
 *
 * Shared keys: a question is keyed by its text (`ask:<hash>`) — the
 * `work_needs_you` row's body IS the question (notify.ts questionText), so a
 * question surfacing as a notification and as a chat picker is one event. A
 * work item's transition is `work:<id>:<status>` (the notification's
 * target_id is the ledger row's id). Cards of one verdict run share its
 * run_key; their grouped notification lands within the alert cooldown and
 * coalesces.
 *
 * An AI teammate's arrivals sound like what they are (bots-v2 Phase 6): a
 * question waiting on you, finished work to review and a new card each have
 * their own sound (teammateArrivalSound, the one place that picks it). Only
 * the sound changes: the key, the path that plays it and every gate are as
 * they were, so an arrival is still one sound. Whose an arrival is comes from
 * the ledger rows this window has seen (./teammate-work).
 */

import { isNativeBannerPath } from '@/lib/native-notification-path'
import { playAlertSound, type AlertRequest, type AlertSound } from './alerts'
import { cardTeammateId, workRowOwner, type OwnedCardLike, type OwnedWorkRow, type WorkRowOwner } from './teammate-work'

// ── A teammate's arrivals ────────────────────────────────────────────────────

/** What arrived, as far as its sound goes. */
export type ArrivalKind = 'question' | 'review' | 'card' | 'done' | 'failed'

/**
 * The sound each kind of arrival makes when an AI teammate brings it. A kind
 * not listed keeps today's sound: a teammate's failed run is still surfaced
 * like one that needs you, and a run it finished with nothing to review still
 * plays agent-complete.
 */
const TEAMMATE_SOUNDS: Partial<Record<ArrivalKind, AlertSound>> = {
  question: 'agent-alert-questions',
  review: 'agent-alert-hopful',
  card: 'agent-alert-arivel',
}

export interface Arrival {
  kind: ArrivalKind
  /** The AI teammate it is attributed to; null for none (a person's own loop, a lane's run). */
  teammateId: string | null
  /** Today's sound for it: what it plays with no teammate. */
  fallback: AlertSound
}

/** Which sound an arrival plays: its teammate's sound for it, else today's. */
export function teammateArrivalSound({ kind, teammateId, fallback }: Arrival): AlertSound {
  if (!teammateId) return fallback
  return TEAMMATE_SOUNDS[kind] ?? fallback
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/** The same text the recorder puts in a `work_needs_you` body. */
export function normalizeQuestion(text: string): string {
  return text.trim().slice(0, 500)
}

/** 32-bit FNV-1a, hex: a short stable key for a question's text. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function askKey(questionText: string): string {
  return `ask:${hash(normalizeQuestion(questionText))}`
}

export function workKey(workItemId: string, status: string): string {
  return `work:${workItemId}:${status}`
}

// ── Notifications ────────────────────────────────────────────────────────────

export interface NotificationLike {
  id: string
  type: string
  body?: string | null
  target_type?: string | null
  target_id?: string | null
  is_read?: boolean
  metadata?: Record<string, unknown> | null
}

/** The kinds a person starts: their finishing is "your run is done". */
const USER_RUN_KINDS: ReadonlySet<string> = new Set(['work_run', 'coding_run'])

/** The ledger row a notification is about, when it is about one. */
function workItemOf(n: NotificationLike): string | null {
  return n?.target_type === 'work_item' && n.target_id ? n.target_id : null
}

/**
 * The sound a newly arrived notification plays, or null for none. `owner` is
 * whose its work item is (./teammate-work; null when this window hasn't seen
 * the row, which plays today's sound).
 */
export function notificationAlert(
  n: NotificationLike,
  owner: WorkRowOwner | null = workRowOwner(workItemOf(n)),
): AlertRequest | null {
  if (!n?.id || n.is_read) return null
  const meta = (n.metadata ?? {}) as Record<string, unknown>
  const workId = workItemOf(n)
  const whose = { teammateId: owner?.teammateId ?? null }
  switch (n.type) {
    case 'work_needs_you': {
      if (meta.status === 'needs_input') {
        const question = typeof n.body === 'string' ? normalizeQuestion(n.body) : ''
        return {
          sound: teammateArrivalSound({ kind: 'question', ...whose, fallback: 'agent-alert' }),
          key: question ? askKey(question) : workKey(workId ?? n.id, 'needs_input'),
        }
      }
      // needs_review: a run the user started finished (its result waits on
      // them); a loop's deliverable (drafts ready) is an agent needing them.
      const done = meta.status === 'needs_review' && typeof meta.kind === 'string' && USER_RUN_KINDS.has(meta.kind)
      return {
        sound: teammateArrivalSound({ kind: 'review', ...whose, fallback: done ? 'agent-complete' : 'agent-alert' }),
        key: workKey(workId ?? n.id, 'needs_review'),
      }
    }
    case 'work_failed':
      // A failed run is surfaced like one that needs you: not a success chime.
      return {
        sound: teammateArrivalSound({ kind: 'failed', ...whose, fallback: 'agent-alert' }),
        key: workKey(workId ?? n.id, 'failed'),
      }
    case 'flow_run_output':
      // Loop digests (cards to review, a skipped run). Sequences borrow the
      // type for their own updates; those are plain notifications. A
      // teammate's loop keeps this sound: its cards arrive first and play the
      // card sound, and this lands inside their cooldown.
      return n.target_type === 'sequence'
        ? { sound: 'notification-alert', key: `notification:${n.id}` }
        : { sound: 'agent-alert', key: `notification:${n.id}` }
    default:
      return { sound: 'notification-alert', key: `notification:${n.id}` }
  }
}

/** A notification was just shown as an in-app toast (never for the native
 *  banner, which makes its own sound). */
export function announceNotification(n: NotificationLike): void {
  const request = notificationAlert(n)
  if (request) void playAlertSound(request)
}

// ── Attention cards ──────────────────────────────────────────────────────────

export interface AttentionRowLike extends OwnedCardLike {
  id: string
  status?: string | null
}

/** The sound a card arriving plays. `teammateId` is the AI teammate it is
 *  attributable to (./teammate-work cardTeammateId), or null. */
export function attentionAlert(
  row: AttentionRowLike,
  teammateId: string | null = cardTeammateId(row),
): AlertRequest | null {
  if (!row?.id || row.status !== 'pending') return null
  const runKey = typeof row.run_key === 'string' && row.run_key ? row.run_key : null
  return {
    sound: teammateArrivalSound({ kind: 'card', teammateId, fallback: 'agent-alert' }),
    key: runKey ? `attention-run:${runKey}` : `attention:${row.id}`,
  }
}

/** A new card arrived live. Its run's grouped notification ("N need you")
 *  goes to a native banner when no window is focused; the banner's sound is
 *  the alert then. */
export function announceAttentionItem(row: AttentionRowLike): void {
  if (isNativeBannerPath()) return
  const request = attentionAlert(row)
  if (request) void playAlertSound(request)
}

// ── The work ledger (tracked_job) ────────────────────────────────────────────

export interface WorkRowLike extends OwnedWorkRow {
  status?: string | null
  origin?: string | null
  source?: { quiet?: boolean } | null
}

const LIVE_WORK: ReadonlySet<string> = new Set(['queued', 'running', 'needs_input', 'waiting_on_child'])

/**
 * The one completion no notification tells: a run the user started ending
 * `done` straight from executing (a coding run that finished without a PR).
 * Everything else a run does that needs a sound writes a notification row
 * (needs_input, needs_review, failed) and plays from there. A review closing
 * (needs_review → done) is the user's own act and stays silent, as do loop,
 * attempt and delegated runs and muted items.
 */
export function workTransitionAlert(next: WorkRowLike | null | undefined, prev: WorkRowLike | null | undefined): AlertRequest | null {
  if (!next?.id || !prev || typeof prev.status !== 'string') return null
  if (next.status !== 'done' || prev.status === next.status) return null
  if (!LIVE_WORK.has(prev.status)) return null
  if (!next.kind || !USER_RUN_KINDS.has(next.kind)) return null
  if ((next.origin ?? 'user') !== 'user') return null
  if (next.source?.quiet === true) return null
  return {
    sound: teammateArrivalSound({
      kind: 'done',
      teammateId: next.ai_team_member_id ?? null,
      fallback: 'agent-complete',
    }),
    key: workKey(next.id, 'done'),
  }
}

export function announceWorkTransition(next: WorkRowLike | null | undefined, prev: WorkRowLike | null | undefined): void {
  const request = workTransitionAlert(next, prev)
  if (request) void playAlertSound(request)
}
