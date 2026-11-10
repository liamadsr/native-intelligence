/**
 * Discard email drafts Native Intelligence wrote, at the person's word (GEN-1165): the
 * main agent's `discard_email_draft`, and Dismiss on a Mail draft item
 * through `settle_work_item` (src/lib/bots/bot-work-acts.ts). "Clean up my
 * junk drafts" ends with them gone from the mailbox and from Native Intelligence's pending
 * list, in one turn.
 *
 * Which drafts. Only Native Intelligence's own: an `email_draft` row of the caller's
 * (`user_id = the caller`, in a workspace they are a member of), named by its
 * row id, by the list item id that carries it (`draft:<row id>`), or by the
 * mailbox draft (message) id the row names. A draft the person wrote in their
 * mailbox has no row, so no id reaches it: it is never touched. A draft
 * already sent or dismissed is left as it is.
 *
 * Per draft, in this order:
 *   1. the mailbox copy is deleted, at the mailbox the row names
 *      (deleteDraftOfRow), and its thread indexed again. When the mailbox
 *      can't delete it (no token, a refusal), nothing changes in Native Intelligence
 *      either, so Native Intelligence and the mailbox never disagree, and the answer says
 *      so: MAILBOX_FAILED. When nothing in the mailbox holds that id any more
 *      (`mailbox: 'not_found'`: sent or deleted there, or, at Gmail, saved
 *      again there under a new id) the row still goes, and the answer says it
 *      may still be in their Drafts;
 *   2. the row is released as the person's own Discard releases it
 *      (releaseDraftRows, `reviewed`): the row goes, and its hold (the
 *      thread's copy) with it, unless another open draft still rides on that
 *      hold (`keepSharedHolds`: discarding one of two drafts on a thread keeps
 *      the other's review row). A row still there afterwards (the delete
 *      failed) is FAILED, never reported discarded;
 *   3. the work that delivered it stops waiting (resolveWorkForDeliverable,
 *      by the row and by its mailbox id);
 *   4. the reason is kept for the needs-reply gate and the drafter (GEN-1164):
 *      a `draft_dismissed` evals candidate (pointers only, never mail text:
 *      migration 442), and for a reason that says no reply was owed
 *      (no_reply_needed, outdated) the thread is remembered as needing none,
 *      as Jev's confident no is (email-reply-gate.ts rememberNoReply), so
 *      neither the drafting passes nor the agent's inbox pick it up again
 *      until a new message arrives: only while its latest message is no newer
 *      than the draft (a message that came after is still to be read).
 *      Best-effort: a lost label never fails a discard.
 *
 * Every read and write is fenced on the caller explicitly, whatever client
 * runs it (the tool routes use a service-role client). Never throws: a
 * failure is a result the model can read. Nothing is ever sent.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveMemberIdsForUser } from '@/lib/workspace'
import { resolveWorkForDeliverable } from '@/lib/work/resolve'
import { recordEvalCandidate } from '@/lib/evals/flywheel/record'
import { draftOrigin } from '@/lib/evals/flywheel/draft-rewrite'
import { evalCandidateKey, type DraftDismissReason, type DraftDismissedEvidence } from '@/lib/evals/flywheel/types'
import { OPEN_DRAFT_STATUSES } from '@/lib/crm/email-drafts'
import { mailboxAddresses } from './reply-policy'
import { AGENT_DRAFT_ITEM_PREFIX } from './agent-drafts'
import { releaseDraftRows } from './hold'
import { deleteDraftOfRow, isProviderId } from './provider-drafts'

/** The most drafts one call discards. */
export const DISCARD_DRAFTS_MAX = 50
/**
 * More drafts than this, when the person didn't name each one, wait for their
 * yes in the chat first (the tool's `confirmed`: discard_email_draft answers
 * CONFIRM_FIRST with the list to show them).
 */
export const DISCARD_CONFIRM_OVER = 5

/** The reasons that say no reply was owed: the thread is remembered as needing none. */
const NO_REPLY_REASONS: ReadonlySet<DraftDismissReason> = new Set(['no_reply_needed', 'outdated'])

/** True for a draft that still waits on the person (the review pile's statuses). */
export function isOpenDraftStatus(status: string | null | undefined): boolean {
  return (OPEN_DRAFT_STATUSES as readonly string[]).includes(status ?? '')
}

/** Mailbox deletes running at once (a Gmail delete reads its drafts list first). */
const MAILBOX_CONCURRENCY = 4

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A draft row as a discard reads it. */
export interface DiscardDraftRow {
  id: string
  workspace_id: string
  status: string | null
  subject: string | null
  to_emails: string[] | null
  provider: string | null
  account_id: string | null
  provider_thread_id: string | null
  provider_draft_id: string | null
  /** The hold it rides on (migration 343), released with it. */
  hold_id: string | null
  metadata: unknown
  created_at: string | null
}

const ROW_SELECT = 'id, workspace_id, status, subject, to_emails, provider, account_id, provider_thread_id, provider_draft_id, hold_id, metadata, created_at'

export type DiscardCode = 'NOT_FOUND' | 'ALREADY_SETTLED' | 'MAILBOX_FAILED' | 'FAILED'

/** What became of one id. */
export type DiscardOutcome =
  | {
      /** The id as it was given. */
      id: string
      discarded: true
      draft_row_id: string
      workspace_id: string
      /**
       * 'deleted': gone from the mailbox too. 'none': it had no mailbox copy
       * (Native Intelligence only). 'not_found': nothing in the mailbox held that id any
       * more (sent or deleted there, or edited there since: then it may still
       * be in their Drafts; `note` says so).
       */
      mailbox: 'deleted' | 'none' | 'not_found'
      note?: string
    }
  | { id: string; discarded: false; draft_row_id?: string; code: DiscardCode; error: string }

export interface DiscardDraftsResult {
  success: boolean
  /** How many were discarded. */
  discarded: number
  results: DiscardOutcome[]
  message: string
}

export interface DiscardDraftsInput {
  draftIds: readonly string[]
  reason: DraftDismissReason
  /** The person's words about why, when they gave some (kept with the label, clipped). */
  note?: string | null
  /** Who decided: the agent at the person's word (default), or the person's own click. */
  by?: 'agent' | 'person'
}

const NOT_FOUND_ERROR = "No draft Native Intelligence wrote for you with that id. Drafts the person wrote themselves can't be discarded here."
const MAILBOX_NOT_FOUND_NOTE =
  "The mailbox no longer had it under the id Native Intelligence saved: already sent or deleted there, or edited in their mailbox since (then it may still be in their Drafts for them to delete)."

/** An id as the discard reads it: a row id (from `draft:<id>` too), or a mailbox draft id. */
function parseId(raw: string): { rowId: string } | { providerId: string } | null {
  const id = typeof raw === 'string' ? raw.trim() : ''
  const bare = id.startsWith(AGENT_DRAFT_ITEM_PREFIX) ? id.slice(AGENT_DRAFT_ITEM_PREFIX.length) : id
  if (UUID.test(bare)) return { rowId: bare.toLowerCase() }
  if (bare === id && isProviderId(id)) return { providerId: id }
  return null
}

/**
 * The caller's own Native Intelligence draft rows for `ids`, each id with its row or none.
 * Fenced on `user_id = the caller` and the caller's workspaces. Throws on a
 * failed read.
 */
export async function readOwnDraftRows(
  supabase: SupabaseClient,
  userId: string,
  ids: readonly string[],
): Promise<Array<{ id: string; row: DiscardDraftRow | null }>> {
  const parsed = ids.map((id) => ({ id, ref: parseId(id) }))
  const rowIds = [...new Set(parsed.flatMap((p) => (p.ref && 'rowId' in p.ref ? [p.ref.rowId] : [])))]
  const providerIds = [...new Set(parsed.flatMap((p) => (p.ref && 'providerId' in p.ref ? [p.ref.providerId] : [])))]
  if (!rowIds.length && !providerIds.length) return parsed.map((p) => ({ id: p.id, row: null }))

  const workspaceIds = [...new Set((await resolveMemberIdsForUser(supabase, userId)).map((m) => m.workspaceId))]
  if (!workspaceIds.length) return parsed.map((p) => ({ id: p.id, row: null }))
  const read = async (column: 'id' | 'provider_draft_id', values: string[]): Promise<DiscardDraftRow[]> => {
    if (!values.length) return []
    const { data, error } = await supabase
      .from('email_draft')
      .select(ROW_SELECT)
      .eq('user_id', userId)
      .in('workspace_id', workspaceIds)
      .in(column, values)
    if (error) throw new Error(`draft rows: ${error.message}`)
    return (data ?? []) as unknown as DiscardDraftRow[]
  }
  const [byId, byProvider] = await Promise.all([read('id', rowIds), read('provider_draft_id', providerIds)])
  const rows = new Map(byId.map((r) => [r.id.toLowerCase(), r]))
  const byMailbox = new Map<string, DiscardDraftRow>()
  // An open row first, when two rows name one mailbox draft (a settled one waits to be swept).
  for (const r of byProvider) {
    if (!r.provider_draft_id) continue
    const had = byMailbox.get(r.provider_draft_id)
    if (!had || (!isOpenDraftStatus(had.status) && isOpenDraftStatus(r.status))) byMailbox.set(r.provider_draft_id, r)
  }
  return parsed.map((p) => ({
    id: p.id,
    row: !p.ref ? null : 'rowId' in p.ref ? (rows.get(p.ref.rowId) ?? null) : (byMailbox.get(p.ref.providerId) ?? null),
  }))
}

/** The domain a reply would have gone to, never the address: "reply2.squareup.com". */
export function recipientDomain(to: readonly string[] | null | undefined): string | undefined {
  const first = Array.isArray(to) ? mailboxAddresses(to.join(', '))[0] : undefined
  const domain = first?.split('@')[1]?.toLowerCase()
  return domain && /^[a-z0-9.-]+$/.test(domain) ? domain : undefined
}

/** Run `fn` over `items`, at most `limit` at once, results in order. */
async function inPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return out
}

/** Discard the caller's drafts `input.draftIds` (see the header). Never throws. */
export async function discardEmailDrafts(supabase: SupabaseClient, userId: string, input: DiscardDraftsInput): Promise<DiscardDraftsResult> {
  const ids = [...new Set(input.draftIds.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean))].slice(0, DISCARD_DRAFTS_MAX)
  if (!ids.length) return { success: false, discarded: 0, results: [], message: 'No draft ids were given.' }
  let found: Array<{ id: string; row: DiscardDraftRow | null }>
  try {
    found = await readOwnDraftRows(supabase, userId, ids)
  } catch (err) {
    console.warn('[discard-drafts] read failed:', err instanceof Error ? err.message : err)
    return { success: false, discarded: 0, results: [], message: 'The drafts could not be read just now; nothing was discarded.' }
  }

  // One outcome per id; a row named twice (its row id and its mailbox id) is discarded once.
  const results = new Map<string, DiscardOutcome>()
  const work: Array<{ id: string; row: DiscardDraftRow }> = []
  const claimed = new Set<string>()
  for (const { id, row } of found) {
    if (!row) results.set(id, { id, discarded: false, code: 'NOT_FOUND', error: NOT_FOUND_ERROR })
    else if (!isOpenDraftStatus(row.status)) {
      results.set(id, { id, discarded: false, draft_row_id: row.id, code: 'ALREADY_SETTLED', error: `This draft is already ${row.status ?? 'settled'}; nothing to discard.` })
    } else if (claimed.has(row.id)) {
      results.set(id, { id, discarded: false, draft_row_id: row.id, code: 'ALREADY_SETTLED', error: 'The same draft as another id in this call: discarded once.' })
    } else {
      claimed.add(row.id)
      work.push({ id, row })
    }
  }

  // 1. The mailbox first: a draft the mailbox kept stays in Native Intelligence too.
  const mailbox = await inPool(work, MAILBOX_CONCURRENCY, async ({ row }) =>
    row.provider_draft_id ? deleteDraftOfRow(userId, { ...row, provider_draft_id: row.provider_draft_id }) : ('none' as const),
  )
  let going: Array<{ id: string; row: DiscardDraftRow; mailbox: 'deleted' | 'none' | 'not_found' }> = []
  work.forEach(({ id, row }, i) => {
    const m = mailbox[i]
    if (m === 'failed') {
      results.set(id, {
        id,
        discarded: false,
        draft_row_id: row.id,
        code: 'MAILBOX_FAILED',
        error: "The mailbox wouldn't delete it just now (it is still in their Drafts), so it was left in Native Intelligence too. Try again later, or they can delete it in their mailbox.",
      })
    } else going.push({ id, row, mailbox: m })
  })

  // 2. The rows, in one release, so drafts sharing a hold are weighed together.
  if (going.length) {
    // `reviewed`: the person's verdict, said to the agent or clicked (dormancy reads it).
    const held = going.map(({ row }) => ({ id: row.id, workspace_id: row.workspace_id, hold_id: row.hold_id ?? null, status: row.status, provider_draft_id: row.provider_draft_id }))
    await releaseDraftRows(supabase, userId, held, { reviewed: true, keepSharedHolds: true })
    // A row the release didn't take (a failed delete) is still listed: never said to be discarded.
    const left = await stillListed(supabase, userId, going.map((g) => g.row.id))
    for (const g of going.filter((g) => left.has(g.row.id))) {
      results.set(g.id, {
        id: g.id,
        discarded: false,
        draft_row_id: g.row.id,
        code: 'FAILED',
        error: `${g.mailbox === 'none' ? 'It' : 'It is gone from the mailbox, but it'} is still listed in Native Intelligence (the delete didn't go through). Try again.`,
      })
    }
    going = going.filter((g) => !left.has(g.row.id))
  }

  // 3 and 4. The work that delivered each, and the label.
  const now = new Date().toISOString()
  for (const { id, row, mailbox: m } of going) {
    results.set(id, {
      id,
      discarded: true,
      draft_row_id: row.id,
      workspace_id: row.workspace_id,
      mailbox: m,
      ...(m === 'not_found' ? { note: MAILBOX_NOT_FOUND_NOTE } : {}),
    })
    for (const ref of [row.id, row.provider_draft_id]) {
      if (ref) await resolveWorkForDeliverable(supabase, { type: 'email_draft', id: ref }, { nowIso: now }).catch(() => {})
    }
    await recordDismissal(supabase, userId, row, input, now)
  }

  const ordered = ids.map((id) => results.get(id)).filter((r): r is DiscardOutcome => !!r)
  const discarded = going.length
  const settled = ordered.filter((r) => !r.discarded && r.code === 'ALREADY_SETTLED').length
  const missed = ordered.length - discarded - settled
  const notFound = going.filter((g) => g.mailbox === 'not_found').length
  const message =
    discarded === 0
      ? missed === 0
        ? 'Nothing to discard: those drafts were already sent or dismissed.'
        : 'Nothing was discarded: see each result.'
      : `Discarded ${discarded} draft${discarded === 1 ? '' : 's'}${going.some((g) => g.mailbox === 'deleted') ? ', in Native Intelligence and in the mailbox' : ' in Native Intelligence'}.` +
        (notFound ? ` ${notFound} ${notFound === 1 ? 'was' : 'were'} no longer in the mailbox under the id Native Intelligence saved: if they edited ${notFound === 1 ? 'it' : 'them'} in their mailbox, ${notFound === 1 ? 'it' : 'they'} may still be in their Drafts.` : '') +
        (missed ? ` ${missed} could not be: see each result.` : '') +
        ' Nothing was sent.'
  return { success: discarded > 0 || missed === 0, discarded, results: ordered, message }
}

/** Which of `rowIds` are still open rows of the caller's (the release missed them). A failed read assumes none. */
async function stillListed(supabase: SupabaseClient, userId: string, rowIds: readonly string[]): Promise<Set<string>> {
  try {
    const { data, error } = await supabase.from('email_draft').select('id, status').eq('user_id', userId).in('id', [...rowIds])
    if (error) throw new Error(error.message)
    return new Set(((data ?? []) as Array<{ id: string; status: string | null }>).filter((r) => isOpenDraftStatus(r.status)).map((r) => r.id))
  } catch (err) {
    console.warn('[discard-drafts] release not checked:', err instanceof Error ? err.message : err)
    return new Set()
  }
}

/**
 * The label for the needs-reply gate and the drafter (GEN-1164): a
 * `draft_dismissed` candidate, and for a reason that says no reply was owed
 * the thread's index row remembered as needing none: only while its latest
 * message is no newer than the draft (one that came after is still to be
 * read), and this revision only (the sync reads the next message afresh).
 * Never throws.
 */
async function recordDismissal(
  supabase: SupabaseClient,
  userId: string,
  row: DiscardDraftRow,
  input: DiscardDraftsInput,
  at: string,
): Promise<void> {
  const domain = recipientDomain(row.to_emails)
  const evidence: DraftDismissedEvidence = {
    kind: 'draft_dismissed',
    reason: input.reason,
    origin: draftOrigin(row.metadata),
    by: input.by ?? 'agent',
    ...(domain ? { recipientDomain: domain } : {}),
    ...(row.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {}),
    ...(row.account_id ? { accountId: row.account_id } : {}),
    at,
  }
  await recordEvalCandidate(supabase, {
    workspaceId: row.workspace_id,
    userId,
    source: 'draft_dismissed',
    dedupeKey: evalCandidateKey.draftDismissed(row.id),
    evidence,
    refType: 'email_draft',
    refId: row.id,
    ...(input.note?.trim() ? { reason: input.note } : {}),
    onExisting: 'skip',
  })
  if (!NO_REPLY_REASONS.has(input.reason) || !row.provider_thread_id || !row.created_at) return
  try {
    let q = supabase
      .from('email_thread_index')
      .update({ needs_reply: false })
      .eq('user_id', userId)
      .eq('workspace_id', row.workspace_id)
      .eq('provider_thread_id', row.provider_thread_id)
      .lte('last_message_at', row.created_at)
    if (row.account_id) q = q.eq('account_id', row.account_id)
    const { error } = await q
    if (error) console.warn('[discard-drafts] thread not marked as needing no reply:', error.message)
  } catch (err) {
    console.warn('[discard-drafts] thread not marked as needing no reply:', err instanceof Error ? err.message : err)
  }
}
