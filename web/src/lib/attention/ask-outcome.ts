/**
 * What became of a chat ask once its card left the shared source (P13,
 * chat-ask-card.tsx): approved and ran, declined, expired, refused, or
 * answered. The live card is the shared source's (useAttentionItems' `asks`);
 * only a card that is no longer pending is read here, once, from the
 * caller's own rows (tool_approval and attention_item are owner-only by RLS),
 * so a thread full of settled asks costs one batched read per screen and
 * nothing per turn.
 *
 * Pure mapping (approvalOutcome, cardOutcome, askOutcomeLine) plus the
 * batched browser read (loadAskOutcome).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type AskOutcome =
  /** An approval that ran. */
  | 'approved'
  /** Approved, but a re-check refused it or the call failed. */
  | 'failed'
  /** Declined, or a loop step skipped: nothing ran. */
  | 'declined'
  /** Its wait ran out: nothing ran. */
  | 'expired'
  /** A question card the person answered. */
  | 'answered'
  /** A question card the person dismissed. */
  | 'dismissed'
  /** Still pending, but not in the shared source (another workspace's): it waits on the person. */
  | 'waiting'
  /** Not the viewer's row: it waits on someone else (a takeover, a hand-over). */
  | 'theirs'

/** An approval's row as the outcome read takes it: its status, its expiry, and the two result flags (never the result's text). */
export interface ApprovalOutcomeRow {
  status?: unknown
  expires_at?: unknown
  success?: unknown
  is_error?: unknown
}

/** Pending, but its wait is over (the hourly sweep hasn't marked it yet). */
function lapsed(expiresAt: unknown, nowMs: number): boolean {
  return typeof expiresAt === 'string' && Date.parse(expiresAt) <= nowMs
}

/** An approval's outcome off its row (null: not the viewer's). Pure. */
export function approvalOutcome(row: ApprovalOutcomeRow | null | undefined, nowMs: number = Date.now()): AskOutcome {
  if (!row) return 'theirs'
  switch (row.status) {
    case 'approved':
      // Approved and claimed but not run yet reads as approved: the result lands in a moment.
      return row.success === false || row.is_error === true ? 'failed' : 'approved'
    case 'failed':
      return 'failed'
    case 'denied':
      return 'declined'
    case 'expired':
      return 'expired'
    default:
      return lapsed(row.expires_at, nowMs) ? 'expired' : 'waiting'
  }
}

/** A plain ask card's outcome off its row (null: not the viewer's). Pure. */
export function cardOutcome(row: { status?: unknown; expires_at?: unknown } | null | undefined, nowMs: number = Date.now()): AskOutcome {
  if (!row) return 'theirs'
  switch (row.status) {
    case 'accepted':
      return 'answered'
    case 'dismissed':
      return 'dismissed'
    case 'expired':
      return 'expired'
    default:
      return lapsed(row.expires_at, nowMs) ? 'expired' : 'waiting'
  }
}

/** The settled card's line. Pure. */
export function askOutcomeLine(outcome: AskOutcome): string {
  switch (outcome) {
    case 'approved':
      return 'Approved. It ran.'
    case 'failed':
      return 'Approved, but it didn’t run.'
    case 'declined':
      return 'Declined. Nothing ran.'
    case 'expired':
      return 'Expired. Nothing ran.'
    case 'answered':
      return 'Answered.'
    case 'dismissed':
      return 'Dismissed.'
    case 'waiting':
      return 'Waiting for your answer.'
    case 'theirs':
      return 'Waiting on someone else’s yes.'
  }
}

/** What a settled ask is looked up by: its approval (an approval card) or its card. */
export interface AskRef {
  approvalId?: string | null
  cardId?: string | null
}

function keyOf(ref: AskRef): string | null {
  return ref.approvalId ? `a:${ref.approvalId}` : ref.cardId ? `c:${ref.cardId}` : null
}

/** Settled outcomes are final; a pending one, or one not the viewer's (it may become theirs to see settled), is read again next time. */
const settled = new Map<string, AskOutcome>()
let queue: Array<{ key: string; ref: AskRef; resolve: (o: AskOutcome) => void }> = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** The outcome already known for `ref`, if it is settled. */
export function knownAskOutcome(ref: AskRef): AskOutcome | undefined {
  const key = keyOf(ref)
  return key ? settled.get(key) : undefined
}

/**
 * Read one settled ask's outcome, batched with every other read asked for in
 * the same tick (one query per table). `fresh` skips the cache (the person
 * just acted on it). Resolves 'waiting' on a failed read.
 */
export function loadAskOutcome(client: () => SupabaseClient, ref: AskRef, opts: { fresh?: boolean } = {}): Promise<AskOutcome> {
  const key = keyOf(ref)
  if (!key) return Promise.resolve('theirs')
  const known = settled.get(key)
  if (known && !opts.fresh) return Promise.resolve(known)
  return new Promise((resolve) => {
    queue.push({ key, ref, resolve })
    if (!flushTimer) flushTimer = setTimeout(() => void flush(client), 0)
  })
}

async function flush(client: () => SupabaseClient): Promise<void> {
  flushTimer = null
  const batch = queue
  queue = []
  const approvalIds = [...new Set(batch.flatMap((b) => (b.ref.approvalId ? [b.ref.approvalId] : [])))]
  const cardIds = [...new Set(batch.flatMap((b) => (!b.ref.approvalId && b.ref.cardId ? [b.ref.cardId] : [])))]
  const out = new Map<string, AskOutcome>()
  try {
    const supabase = client()
    const [approvals, cards] = await Promise.all([
      // The two flags only, never the result's text (it can be long, and it is the tool's).
      approvalIds.length ? supabase.from('tool_approval').select('id, status, expires_at, success:result->success, is_error:result->isError').in('id', approvalIds) : Promise.resolve({ data: [], error: null }),
      cardIds.length ? supabase.from('attention_item').select('id, status, expires_at').in('id', cardIds) : Promise.resolve({ data: [], error: null }),
    ])
    const nowMs = Date.now()
    if (!approvals.error) {
      const rows = new Map(((approvals.data ?? []) as Array<ApprovalOutcomeRow & { id: string }>).map((r) => [r.id, r]))
      for (const id of approvalIds) out.set(`a:${id}`, approvalOutcome(rows.get(id) ?? null, nowMs))
    }
    if (!cards.error) {
      const rows = new Map(((cards.data ?? []) as Array<{ id: string; status: string; expires_at: string | null }>).map((r) => [r.id, r]))
      for (const id of cardIds) out.set(`c:${id}`, cardOutcome(rows.get(id) ?? null, nowMs))
    }
  } catch {
    // A failed read: each reads as waiting, and is read again next time.
  }
  for (const b of batch) {
    const outcome = out.get(b.key) ?? 'waiting'
    if (outcome !== 'waiting' && outcome !== 'theirs') settled.set(b.key, outcome)
    b.resolve(outcome)
  }
}

/** Tests only: forget every outcome. */
export function __resetAskOutcomesForTests(): void {
  settled.clear()
  queue = []
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
}
