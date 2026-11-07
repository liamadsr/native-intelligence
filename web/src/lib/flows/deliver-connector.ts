/**
 * Delivering a structured connector's validated output (F3: output-connectors.ts
 * says what each connector is). Server code on a service-role client: every
 * read and write is fenced by the run's workspace, and acts as the flow's
 * owner (the run-as person), never the model.
 *
 *   post_drafts    one For you `question` card per post (payload.post_draft,
 *                  src/lib/content/post-draft.ts) for the run-as person, at
 *                  most MAX_OPEN_POST_DRAFTS waiting at once, each aging out
 *                  after 7 days. Nothing is posted: the card's Post opens X.
 *   doc_proposals  section edits on the flow's canon document, as one batch:
 *                  each applied (P4's applyCanonSectionEdit, compare-and-swap,
 *                  in the history with its reason and sources), then ONE
 *                  digest line per document per day for the whole batch.
 *                  When the run read outside text (run-outside-reads.ts) the
 *                  edits still apply, labelled so in the history and on their
 *                  digest line (decision 16: apply with undo, never a card).
 *                  A person who may not edit the document gets nothing
 *                  applied, and is told why.
 *   email_drafts   the existing automatic-draft path (create_email_draft with
 *                  the shared daily cap and the open-draft check): a draft in
 *                  the person's mailbox and the review pile. Never sent.
 *
 * A dry run (test_flow) delivers nothing and says what it would have done.
 * Never throws: a failed item is refused with its reason.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { canonEditCheck } from '@/lib/documents/canon-lint'
import { evidenceFromSources } from '@/lib/marketing/claim-evidence'
import { resolveCanonDocument } from '@/lib/documents/canon-doc'
import { documentUpdateRefusal, loadDocumentAccess } from '@/lib/documents/access'
import { appendCanonBatchDigestLine, applyCanonSectionEdit } from '@/lib/documents/canon-edit'
import { canonOutsideLabel, classifyCanonSources, type CanonSource } from '@/lib/documents/canon-sources'
import { canonEditForbidden } from '@/lib/documents/canon'
import { knownOrOwnSenders } from '@/lib/safety/outside-text'
import { cardEntityRef } from './card-entity'
import { deterministicCardId } from './verdict-apply'
import {
  MAX_OPEN_POST_DRAFTS,
  connectorNoun,
  type StructuredConnector,
  type ValidDocEdit,
  type ValidEmailDraft,
  type ValidPostDraft,
  type PostSurface,
} from './output-connectors'
import { POST_SURFACE_NAME, postCardTitle } from '@/lib/content/post-draft'
import { resolveTypefullyAccount } from '@/lib/content/typefully'
import type { ConnectorDeliverySummary } from './types'

/** "You asked, we shipped": how long one person's note blocks another from the same loop, and the loop's daily cap (S7). */
export const RECENT_NOTE_DAYS = 14
export const MAX_NOTES_PER_FLOW_PER_DAY = 10

/** How long a post card waits (decision 3: a draft nobody touches ages out after 7 days). */
export const POST_CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Who and what a delivery is for: all set by the server from the flow and the run, never by the model. */
export interface ConnectorDeliveryContext {
  supabase: SupabaseClient
  workspaceId: string
  /** The flow's owner, whose run this is. */
  runAsUserId: string
  /** Their member row. */
  memberId: string
  /** Stable per-fire id: post cards dedupe on it (a retried step lands the same card) and the dispatcher back-links them by it. */
  runKey: string | null
  flowId: string | null
  /** The call the run was about, when it fired from one: the source of its edits and the cards' footer. */
  captureId: string | null
  captureTitle: string | null
  skillName: string
  /** Bots v3 attribution on cards. */
  teammateId?: string | null
  workItemId?: string | null
  /** The run read untrusted outside text (run-outside-reads.ts): its canon edits are labelled so. */
  readOutside: boolean
  /** When the run started (ISO): a contact created since then can't vouch for an email recipient (review R4). */
  runStartedAt?: string
  /** doc_proposals: what the edits came from, when the server knows better than the one call (a lens batch over several calls). */
  sources?: CanonSource[]
  /** doc_proposals: the flow's canon key. */
  docKey?: string | null
  /** doc_proposals: the revision the edits were written against (a batch built from a snapshot, P9 review nit): the apply's compare-and-swap base. */
  baseRevision?: number | null
  /**
   * email_drafts (P9 review S7, "you asked, we shipped"): no pile-up. A person
   * with a waiting or recent (RECENT_NOTE_DAYS) draft from this loop gets no
   * other, and the loop writes at most MAX_NOTES_PER_FLOW_PER_DAY a day. Each
   * draft is stamped with the loop (email_draft.metadata.flow_id) so it counts.
   */
  perFlowNotes?: boolean
  /** post_drafts: the surface. */
  surface?: PostSurface | null
  /** post_drafts (P9, the weekly pass): the most cards waiting at once (its slots). Absent: MAX_OPEN_POST_DRAFTS. */
  postCap?: number
  /** post_drafts (P9): the material's moment keys → their lens_finding rows, so a delivered post's moments are marked used. */
  momentIds?: Record<string, string>
  /** post_drafts (P9): the cadence line, said once in the run's summary. */
  cadenceNote?: string | null
  /** test_flow: deliver nothing, say what would have happened. */
  dryRun?: boolean
}

type ItemsFor = { post_drafts: ValidPostDraft[]; doc_proposals: ValidDocEdit[]; email_drafts: ValidEmailDraft[] }

/** Deliver one connector's validated items (see the header). Never throws. */
export async function deliverConnectorItems<C extends StructuredConnector>(
  to: C,
  items: ItemsFor[C],
  ctx: ConnectorDeliveryContext,
  alreadyRefused: string[] = [],
): Promise<ConnectorDeliverySummary> {
  try {
    if (ctx.dryRun) return dryRunSummary(to, items.length, alreadyRefused, ctx)
    if (items.length === 0) return { to, delivered: 0, refused: alreadyRefused, summary: emptySummary(to, alreadyRefused) }
    switch (to) {
      case 'post_drafts':
        return await deliverPostDrafts(items as ValidPostDraft[], ctx, alreadyRefused)
      case 'doc_proposals':
        return await deliverDocEdits(items as ValidDocEdit[], ctx, alreadyRefused)
      default:
        return await deliverEmailDrafts(items as ValidEmailDraft[], ctx, alreadyRefused)
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { to, delivered: 0, refused: [...alreadyRefused, reason].slice(0, 10), summary: `Nothing delivered: ${reason}`.slice(0, 200) }
  }
}

function emptySummary(to: StructuredConnector, refused: readonly string[]): string {
  if (refused.length) return `Nothing delivered: refused ${refused.length} (${refused[0]})`.slice(0, 200)
  return to === 'post_drafts' ? 'Nothing worth posting' : to === 'doc_proposals' ? 'Nothing to change' : 'Nobody to write to'
}

function dryRunSummary(to: StructuredConnector, n: number, refused: string[], ctx: ConnectorDeliveryContext): ConnectorDeliverySummary {
  const where =
    to === 'post_drafts' ? ' as For you cards' : to === 'doc_proposals' ? ` to \`${ctx.docKey ?? ''}\`${ctx.readOutside ? ', labelled as from outside text (the run read some)' : ''}` : ' in your mail'
  return {
    to,
    delivered: 0,
    refused,
    dry_run: true,
    summary: n ? `Test: would deliver ${connectorNoun(to, n)}${where}` : `Test: ${emptySummary(to, refused)}`,
  }
}

// ── post_drafts ──────────────────────────────────────────────────────────────

async function deliverPostDrafts(items: ValidPostDraft[], ctx: ConnectorDeliveryContext, refused: string[]): Promise<ConnectorDeliverySummary> {
  const { supabase } = ctx
  let delivered = 0
  let ideas = 0
  const out = [...refused]
  // The weekly pass's cadence (P9): never more than its slots waiting at once.
  const cap = Math.max(1, Math.min(5, ctx.postCap ?? MAX_OPEN_POST_DRAFTS))
  const usedMoments = new Set<string>()
  // C2a: with Typefully connected and ONE account to post as (named on the card,
  // P9 review S2), each card also offers posting through it (the click is the approval).
  const typefully = ctx.dryRun ? null : await resolveTypefullyAccount(supabase, ctx.runAsUserId)
  for (const item of items) {
    const payload: Record<string, unknown> = {
      post_draft: {
        text: item.text,
        surface: ctx.surface ?? 'x',
        chars: item.chars,
        limit: item.limit,
        based_on: item.based_on,
        notes: item.notes,
        ...(item.idea ? { idea: true } : {}),
        ...(typefully ? { typefully: true, ...(typefully.label ? { typefully_account: typefully.label } : {}), ...(typefully.id !== '' ? { typefully_account_id: typefully.id } : {}) } : {}),
      },
      skill_name: ctx.skillName,
      ...(ctx.captureTitle ? { capture_title: ctx.captureTitle } : {}),
      ...(ctx.captureId ? { capture_id: ctx.captureId } : {}),
      ...(ctx.teammateId ? { raised_by_ai_member_id: ctx.teammateId } : {}),
      ...(ctx.workItemId ? { work_item_id: ctx.workItemId } : {}),
      ...(ctx.flowId ? { flow_id: ctx.flowId } : {}),
    }
    const ref = cardEntityRef('question', payload)
    // At most MAX_OPEN_POST_DRAFTS waiting at once (decision 3), counted and
    // inserted in ONE call under the member's advisory lock (migration 397,
    // review S4). A retried step lands the same card (its id is the fire's and
    // the text's): 'duplicate', not counted twice.
    const { data, error } = await supabase.rpc('insert_post_draft_card', {
      p_card: {
        ...(ctx.runKey ? { id: deterministicCardId(ctx.runKey, 'post_draft', item.text) } : {}),
        workspace_id: ctx.workspaceId,
        member_id: ctx.memberId,
        title: postCardTitle(item.text, ctx.surface ?? 'x', item.idea === true),
        why: item.idea
          ? (item.based_on ? `An idea for a slow week: ${item.based_on}` : 'An idea for a slow week, not this week’s work').slice(0, 1000)
          : item.based_on
            ? `Based on ${item.based_on}`.slice(0, 1000)
            : null,
        payload,
        run_key: ctx.runKey,
        entity_type: ref.entityType,
        entity_id: ref.entityId,
        capture_id: ref.captureId,
        expires_at: new Date(Date.now() + POST_CARD_TTL_MS).toISOString(),
      },
      p_cap: cap,
    })
    if (error) out.push(`a post card could not be saved (${error.message})`)
    else if (data === 'inserted') {
      delivered++
      if (item.idea) ideas++
      for (const key of item.uses ?? []) usedMoments.add(key)
    } else if (data === 'full') out.push(`${cap} posts are already waiting`)
  }
  // The moments a delivered post drew on are spent: never drafted from twice (P9).
  if (usedMoments.size && ctx.momentIds) {
    const ids = [...usedMoments].map((k) => ctx.momentIds?.[k]).filter((id): id is string => !!id)
    if (ids.length) {
      const { error } = await supabase.from('lens_finding').update({ status: 'used', used_at: new Date().toISOString() }).eq('workspace_id', ctx.workspaceId).eq('member_id', ctx.memberId).in('id', ids)
      if (error) out.push(`the moments used could not be marked (${error.message})`)
    }
  }
  const surfaceName = POST_SURFACE_NAME[ctx.surface ?? 'x'] ?? 'X'
  const noun = delivered === ideas && ideas > 0 ? `${ideas} ${surfaceName} idea${ideas === 1 ? '' : 's'}` : connectorNoun('post_drafts', delivered, ctx.surface ?? 'x')
  return {
    to: 'post_drafts',
    delivered,
    refused: out.slice(0, 10),
    summary: delivered ? `${noun} for you${ctx.cadenceNote ? `. ${ctx.cadenceNote}` : ''}`.slice(0, 200) : emptySummary('post_drafts', out),
  }
}

// ── doc_proposals ────────────────────────────────────────────────────────────

/** The sources a run's edit names: the call it fired from, set by the server. */
export function runEditSources(captureId: string | null): CanonSource[] {
  return captureId ? [{ kind: 'capture', id: captureId }] : []
}

async function deliverDocEdits(items: ValidDocEdit[], ctx: ConnectorDeliveryContext, refused: string[]): Promise<ConnectorDeliverySummary> {
  const { supabase, workspaceId, runAsUserId } = ctx
  const key = ctx.docKey ?? ''
  const found = key ? await resolveCanonDocument(supabase, { workspaceId, userId: runAsUserId, key }) : null
  if (!found || !found.ok) {
    const why = !key ? 'the loop names no document' : found && found.reason === 'error' ? found.error : `there is no canon document \`${key}\``
    return { to: 'doc_proposals', delivered: 0, refused: [...refused, why].slice(0, 10), summary: `Nothing delivered: ${why}`.slice(0, 200) }
  }
  const { doc } = found
  const { access } = await loadDocumentAccess(supabase, workspaceId, runAsUserId, doc.id)
  const mayEdit = !!access && documentUpdateRefusal(access, { content: '' }) === null
  // #774's write rules: a run whose owner can't edit the document changes
  // nothing, and says why.
  if (!mayEdit) {
    const why = canonEditForbidden(key, doc.title).replace(/ Say what you'd change instead.*$/, '')
    return { to: 'doc_proposals', delivered: 0, refused: [...refused, why].slice(0, 10), summary: `Nothing delivered: ${why}`.slice(0, 200) }
  }
  const sources = ctx.sources ?? runEditSources(ctx.captureId)
  const trust = await classifyCanonSources(supabase, sources, { workspaceId, userId: runAsUserId, attended: false, runReadOutsideText: ctx.readOutside })
  const outside = canonOutsideLabel(sources, trust, { read: ctx.readOutside })

  const out = [...refused]
  const applied: string[] = []
  // The product doc's graded claims (marketing M0): a [proven] line needs the
  // evidence the run's sources show, counted once for the batch.
  const evidence = key === 'product' && items.some((e) => /\[proven\]/i.test(e.text)) ? await evidenceFromSources(supabase, workspaceId, sources, doc.id) : null
  for (const edit of items) {
    const check = canonEditCheck(key, { section: edit.section, text: edit.text, removes: edit.removes }, { evidence })
    const result = await applyCanonSectionEdit(supabase, {
      workspaceId,
      userId: runAsUserId,
      documentId: doc.id,
      key,
      section: edit.section,
      op: edit.op,
      text: edit.text,
      reason: edit.reason,
      sources,
      check,
      outside,
      // The batch's one line, below.
      logLine: false,
      // A batch built from a snapshot of the document applies against that snapshot: a person's edit in between is a conflict, never overwritten.
      ...(ctx.baseRevision != null ? { baseRevision: ctx.baseRevision } : {}),
    })
    if (result.ok) applied.push(result.section)
    else out.push(`${edit.section}: ${result.error}`)
  }
  if (applied.length) {
    await appendCanonBatchDigestLine(supabase, {
      workspaceId,
      userId: runAsUserId,
      documentId: doc.id,
      title: doc.title,
      sections: applied,
      canon: { key, createdBy: doc.created_by },
      outside,
    })
  }
  const title = doc.title?.trim() || key
  const summary = applied.length ? `Updated ${[...new Set(applied)].join(', ')} in ${title}${outside ? ` (from ${outside})` : ''}` : emptySummary('doc_proposals', out)
  return { to: 'doc_proposals', delivered: applied.length, refused: out.slice(0, 10), summary: summary.slice(0, 200) }
}

/** The addresses among these that the run-as person is in touch with (see deliverEmailDrafts). Fails closed: a failed read knows nobody. */
async function reachableAddresses(ctx: ConnectorDeliveryContext, addresses: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))]
  const out = new Set<string>()
  if (wanted.length === 0) return out
  try {
    for (const a of await knownOrOwnSenders(ctx.supabase, { workspaceId: ctx.workspaceId, userId: ctx.runAsUserId, addresses: wanted })) out.add(a.toLowerCase())
  } catch {
    /* nobody known */
  }
  // A contact this run could have made itself counts for nothing (review R4):
  // any contact with one of these addresses created since the run started is
  // taken out, whatever else vouched for it. Fails closed: a failed read
  // takes every known address out.
  if (out.size) {
    const since = ctx.runStartedAt ?? new Date(0).toISOString()
    try {
      const list = [...out]
      const [primary, secondary] = await Promise.all([
        ctx.supabase.from('contact').select('email').eq('workspace_id', ctx.workspaceId).gte('created_at', since).in('email', list).limit(100),
        ctx.supabase.from('contact').select('secondary_emails').eq('workspace_id', ctx.workspaceId).gte('created_at', since).overlaps('secondary_emails', list).limit(100),
      ])
      if (primary.error || secondary.error) throw new Error('contact read failed')
      for (const r of (primary.data ?? []) as Array<{ email?: unknown }>) if (typeof r.email === 'string') out.delete(r.email.toLowerCase())
      for (const r of (secondary.data ?? []) as Array<{ secondary_emails?: unknown }>) {
        for (const e of Array.isArray(r.secondary_emails) ? r.secondary_emails : []) if (typeof e === 'string') out.delete(e.toLowerCase())
      }
    } catch {
      out.clear()
    }
  }
  if (ctx.captureId) {
    try {
      const { data } = await ctx.supabase.from('capture_participant').select('external_email').eq('capture_id', ctx.captureId).limit(200)
      for (const p of (data ?? []) as Array<{ external_email?: unknown }>) {
        if (typeof p.external_email === 'string' && p.external_email.trim()) out.add(p.external_email.trim().toLowerCase())
      }
    } catch {
      /* nobody from the call */
    }
  }
  return out
}

/** This loop's drafts: the addresses with a waiting or recent one, and how many it wrote today (UTC). Null when unreadable. */
async function loopDraftHistory(ctx: ConnectorDeliveryContext, flowId: string): Promise<{ recent: Set<string>; today: number } | null> {
  try {
    const since = new Date(Date.now() - RECENT_NOTE_DAYS * 86_400_000).toISOString()
    const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
    const [recent, waiting] = await Promise.all([
      ctx.supabase.from('email_draft').select('to_emails, cc_emails, created_at').eq('workspace_id', ctx.workspaceId).eq('user_id', ctx.runAsUserId).eq('metadata->>flow_id', flowId).gte('created_at', since).limit(500),
      ctx.supabase.from('email_draft').select('to_emails, cc_emails').eq('workspace_id', ctx.workspaceId).eq('user_id', ctx.runAsUserId).eq('metadata->>flow_id', flowId).in('status', ['pending_review', 'edited', 'approved']).limit(500),
    ])
    if (recent.error || waiting.error) return null
    const out = new Set<string>()
    let today = 0
    const rows = [...((recent.data ?? []) as Array<{ to_emails?: unknown; cc_emails?: unknown }>), ...((waiting.data ?? []) as Array<{ to_emails?: unknown; cc_emails?: unknown }>)]
    for (const r of rows) {
      for (const list of [r.to_emails, r.cc_emails]) for (const a of Array.isArray(list) ? list : []) if (typeof a === 'string') out.add(a.toLowerCase())
    }
    for (const r of (recent.data ?? []) as Array<{ created_at?: unknown }>) if (typeof r.created_at === 'string' && r.created_at >= dayStart) today++
    return { recent: out, today }
  } catch {
    return null
  }
}

/** Mark a draft as this loop's (email_draft.metadata.flow_id), so the next run counts it. Best effort. */
async function stampLoopDraft(ctx: ConnectorDeliveryContext, flowId: string, providerDraftId: unknown): Promise<void> {
  if (typeof providerDraftId !== 'string' || !providerDraftId) return
  try {
    await ctx.supabase.from('email_draft').update({ metadata: { origin: 'automatic', flow_id: flowId } }).eq('user_id', ctx.runAsUserId).eq('provider_draft_id', providerDraftId)
  } catch {
    /* uncounted: the shared daily cap on automatic drafts still holds */
  }
}

// ── email_drafts ─────────────────────────────────────────────────────────────

async function deliverEmailDrafts(items: ValidEmailDraft[], ctx: ConnectorDeliveryContext, refused: string[]): Promise<ConnectorDeliverySummary> {
  // The chat's own create_email_draft, as an AUTOMATIC draft: the shared daily
  // cap, the open-draft check and the no-reply refusal all hold, and the draft
  // joins the review pile. It never sends.
  const { createEmailTools } = await import('@/lib/ai/tools/email')
  const tools = createEmailTools(ctx.runAsUserId, ctx.workspaceId, true, 'session', true)
  const execute = tools.create_email_draft.execute as unknown as (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown>
  let delivered = 0
  const out = [...refused]
  // Recipients are the model's choice: only people the person is already in
  // touch with may get a draft (review S9): a CRM contact, someone they've
  // written to (known senders, their own mailboxes), or someone on the call
  // the run is about. Anyone else is refused, never drafted to.
  const reachable = await reachableAddresses(ctx, items.flatMap((d) => [...d.to, ...d.cc]))
  // S7: this loop's own drafts, so nobody gets a pile of them. Fails closed.
  const perFlow = ctx.perFlowNotes && ctx.flowId ? await loopDraftHistory(ctx, ctx.flowId) : null
  if (ctx.perFlowNotes && !perFlow) {
    return { to: 'email_drafts', delivered: 0, refused: [...out, "this loop's earlier drafts could not be checked, so none was written"].slice(0, 10), summary: 'Nothing delivered: earlier drafts could not be checked' }
  }
  let budget = perFlow ? Math.max(0, MAX_NOTES_PER_FLOW_PER_DAY - perFlow.today) : Infinity
  for (const draft of items) {
    const stranger = [...draft.to, ...draft.cc].find((a) => !reachable.has(a))
    if (stranger) {
      out.push(`the draft to ${stranger}: not a contact, someone you've written to, or someone on the call`)
      continue
    }
    if (perFlow) {
      const recent = [...draft.to, ...draft.cc].find((a) => perFlow.recent.has(a.toLowerCase()))
      if (recent) {
        out.push(`the draft to ${recent}: they already have a note from this loop (waiting, or in the last ${RECENT_NOTE_DAYS} days)`)
        continue
      }
      if (budget <= 0) {
        out.push(`more than ${MAX_NOTES_PER_FLOW_PER_DAY} notes from this loop today`)
        continue
      }
    }
    const callId = `flow-connector-${createHash('sha256').update(`${ctx.runKey ?? ''}\n${draft.to.join(',')}\n${draft.subject}`).digest('hex').slice(0, 16)}`
    const result = (await execute(
      { to: draft.to, ...(draft.cc.length ? { cc: draft.cc } : {}), subject: draft.subject, body: draft.body },
      { toolCallId: callId, messages: [] },
    )) as { success?: boolean; error?: string } | null
    if (result && result.success) {
      delivered++
      if (perFlow && ctx.flowId) {
        budget--
        for (const a of [...draft.to, ...draft.cc]) perFlow.recent.add(a.toLowerCase())
        await stampLoopDraft(ctx, ctx.flowId, (result as { draft_id?: unknown }).draft_id)
      }
    } else out.push(`the draft to ${draft.to[0]}: ${(result?.error ?? 'not written').slice(0, 160)}`)
  }
  return {
    to: 'email_drafts',
    delivered,
    refused: out.slice(0, 10),
    summary: delivered ? `${connectorNoun('email_drafts', delivered)} waiting in your mail` : emptySummary('email_drafts', out),
  }
}
