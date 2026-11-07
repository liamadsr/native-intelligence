/**
 * Delivering each lens's section of a call's read (flows F3, lenses.ts). Runs
 * on the server after the ONE run that read the call: the Triage run the
 * lenses rode (deliverVerdictRun), or a lens flow's own run when Triage is off
 * (deliverLensRun). The model chose nothing here: what each lens keeps, where
 * it goes and as whom are code, and every write acts as the lens flow's owner.
 *
 *   content    each moment of that person's → a lens_finding row (migration
 *              397) for the weekly post pass. Nothing is posted or drafted.
 *   marketing  every item → a lens_finding row (the internal record;
 *              testimonials stay only here, decision 8). Then the product
 *              doc's batch, at most one a day per workspace: the first
 *              external call of a day applies every open finding (today's
 *              and any left from earlier) as section edits through the
 *              doc_proposals connector, with one digest line, and marks them
 *              used; later calls that day only keep theirs for the next
 *              batch. Findings from a run that read outside text apply too,
 *              as a batch of their own, labelled so in the history and on
 *              their own digest line (decision 16: apply with undo, never a
 *              card).
 *
 * Provenance: whether the run read outside text comes from the tools its
 * stream shows it called (run-outside-reads.ts), set by the server. It is kept
 * on each marketing finding, so a batch applied tomorrow still labels what
 * today's run could not vouch for, and such a finding never counts as
 * evidence for another line's grade (M1).
 *
 * Never throws: a lens that fails is recorded as failed on its own flow's
 * run, and the triage it rode is unaffected.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCanonDocument } from '@/lib/documents/canon-doc'
import type { CanonSource } from '@/lib/documents/canon-sources'
import { deliverConnectorItems } from './deliver-connector'
import { evidenceFromSources } from '@/lib/marketing/claim-evidence'
import { gradeClaim, lineGrade, type ClaimGrade } from '@/lib/marketing/grade'
import { matchingLine, regradedSection, sectionLines, similarLine, withGrade } from '@/lib/marketing/regrade'
import { loadOwnerWords } from './lens-plan'
import {
  MARKETING_SECTION_FOR,
  lensItemHash,
  lensScope,
  marketingLine,
  parseContentMoments,
  parseMarketingItems,
  sortRides,
  type LensCallFacts,
  type LensRide,
  type MarketingItem,
} from './lenses'
import type { ValidDocEdit } from './output-connectors'
import type { ConnectorDeliverySummary, LensRideResult } from './types'

export interface LensDeliveryContext {
  supabase: SupabaseClient
  workspaceId: string
  captureId: string | null
  captureTitle: string | null
  /** The fire's stable id (lens edits' and cards' retry keys). */
  runKey: string | null
  /** The reading run read untrusted outside text (run-outside-reads.ts). */
  readOutside: boolean
  /** The call's facts (lens-plan.ts); null on a run with none (a test-fire): no outside names to screen. */
  facts: LensCallFacts | null
  /** The skill that read the call (provenance on the doc edits' reason). */
  skillName: string
  dryRun?: boolean
}

/** The product doc's key: where the marketing lens's batch goes. */
export const MARKETING_DOC_KEY = 'product'
/** Open findings one batch reads at most. */
const MAX_BATCH_FINDINGS = 30
/** Earlier findings a batch reads for a line's evidence (M1): how far back, and how many. */
const HISTORY_DAYS = 90
const MAX_HISTORY = 300

/** A lens's raw section off the run's committed `lenses` object. */
function sectionOf(raw: unknown, lens: string): unknown {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[lens] : undefined
}

function result(ride: LensRide, delivered: ConnectorDeliverySummary | null, error: string | null = null): LensRideResult {
  return { flow_id: ride.flowId, action_id: ride.actionId, lens: ride.lens, status: error ? 'failed' : 'success', delivered, error_message: error }
}

/**
 * Every ride's outcome for one read of a call. `raw` is the run's committed
 * `lenses` object ({content?, marketing?}). A workspace lens is delivered once,
 * by its first flow; another flow of it records that it rode along.
 */
export async function deliverLensSections(raw: unknown, rides: readonly LensRide[], ctx: LensDeliveryContext): Promise<LensRideResult[]> {
  const out: LensRideResult[] = []
  const deliveredBy = new Map<string, string>()
  for (const ride of sortRides(rides)) {
    try {
      if (lensScope(ride.lens) === 'workspace') {
        const first = deliveredBy.get(ride.lens)
        if (first) {
          out.push(result(ride, { to: `lens:${ride.lens}`, delivered: 0, refused: [], summary: `Delivered once for the workspace, by loop ${first.slice(0, 8)}` }))
          continue
        }
        deliveredBy.set(ride.lens, ride.flowId)
      }
      const section = sectionOf(raw, ride.lens)
      if (section === undefined || section === null) {
        out.push(result(ride, { to: `lens:${ride.lens}`, delivered: 0, refused: [], summary: 'Nothing worth keeping from this call' }))
        continue
      }
      out.push(ride.lens === 'content' ? await deliverContent(section, ride, ctx) : await deliverMarketing(section, ride, ctx))
    } catch (err) {
      out.push(result(ride, null, err instanceof Error ? err.message : String(err)))
    }
  }
  return out
}

/** Every ride failed the same way: the read they rode produced nothing. */
export function lensRidesFailed(rides: readonly LensRide[], reason: string): LensRideResult[] {
  return sortRides(rides).map((ride) => result(ride, null, reason))
}

// ── content ─────────────────────────────────────────────────────────────────

async function deliverContent(section: unknown, ride: LensRide, ctx: LensDeliveryContext): Promise<LensRideResult> {
  // Their own lines on the call (S3): a moment must be in their own words.
  const ownWords = ctx.captureId
    ? await loadOwnerWords(ctx.supabase, { workspaceId: ctx.workspaceId, captureId: ctx.captureId, ownerMemberId: ride.ownerMemberId, ownerUserId: ride.ownerUserId })
    : null
  const parsed = parseContentMoments(section, ride, { outsideNames: ctx.facts?.outsideNames ?? [] }, ownWords)
  if (!parsed.ok) return result(ride, null, parsed.error)
  const n = parsed.items.length
  if (ctx.dryRun) {
    return result(ride, { to: 'lens:content', delivered: 0, refused: parsed.refused, dry_run: true, summary: `Test: would keep ${n} moment${n === 1 ? '' : 's'} for your posts` })
  }
  if (n === 0) return result(ride, { to: 'lens:content', delivered: 0, refused: parsed.refused, summary: 'Nothing post-worthy on this call' })
  const rows = parsed.items.map((m) => ({
    workspace_id: ctx.workspaceId,
    member_id: ride.ownerMemberId,
    flow_id: ride.flowId,
    capture_id: ctx.captureId,
    lens: 'content',
    kind: 'post_moment',
    body: { text: m.text, ...(m.theme ? { theme: m.theme } : {}), ...(ctx.captureTitle ? { capture_title: ctx.captureTitle } : {}) },
    item_hash: lensItemHash([m.text]),
  }))
  const { error } = await ctx.supabase.from('lens_finding').upsert(rows, { onConflict: 'flow_id,capture_id,lens,item_hash', ignoreDuplicates: true })
  if (error) return result(ride, null, `The moments could not be saved: ${error.message}`)
  return result(ride, { to: 'lens:content', delivered: n, refused: parsed.refused, summary: `Kept ${n} moment${n === 1 ? '' : 's'} for your posts` })
}

// ── marketing ───────────────────────────────────────────────────────────────

interface StoredFinding {
  id: string
  capture_id: string | null
  kind: string
  body: { text?: unknown; quote?: unknown; speaker?: unknown; read_outside?: unknown } | null
}

async function deliverMarketing(section: unknown, ride: LensRide, ctx: LensDeliveryContext): Promise<LensRideResult> {
  const parsed = parseMarketingItems(section)
  if (!parsed.ok) return result(ride, null, parsed.error)
  const n = parsed.items.length
  if (ctx.dryRun) {
    const edits = parsed.items.filter((i) => i.kind !== 'testimonial').length
    return result(ride, {
      to: 'lens:marketing',
      delivered: 0,
      refused: parsed.refused,
      dry_run: true,
      summary: `Test: would keep ${n} finding${n === 1 ? '' : 's'}${edits ? ` and propose ${edits} line${edits === 1 ? '' : 's'} for the product doc` : ''}`,
    })
  }
  const { supabase } = ctx
  if (n > 0) {
    const rows = parsed.items.map((it) => ({
      workspace_id: ctx.workspaceId,
      member_id: ride.ownerMemberId,
      flow_id: ride.flowId,
      capture_id: ctx.captureId,
      lens: 'marketing',
      kind: it.kind,
      // read_outside: set by the server from the run's stream, so a later batch still labels it.
      body: { text: it.text, quote: it.quote, ...(it.speaker ? { speaker: it.speaker } : {}), read_outside: ctx.readOutside },
      item_hash: lensItemHash([it.kind, it.quote]),
    }))
    const { error } = await supabase.from('lens_finding').upsert(rows, { onConflict: 'flow_id,capture_id,lens,item_hash', ignoreDuplicates: true })
    if (error) return result(ride, null, `The findings could not be saved: ${error.message}`)
  }

  // At most one product-doc batch a day per workspace (review S5): the claim
  // is atomic under a per-workspace lock (migration 397 claim_lens_batch), so
  // two calls processed at once can't both batch. Nothing claimed: today's
  // batch already ran, or nothing is open; findings at most 30 days old.
  const kept = `Kept ${n} finding${n === 1 ? '' : 's'} from this call`
  const { data: claimed, error: claimError } = await supabase.rpc('claim_lens_batch', { p_workspace_id: ctx.workspaceId, p_lens: 'marketing', p_limit: MAX_BATCH_FINDINGS })
  if (claimError) return result(ride, null, `Could not claim the product doc's batch: ${claimError.message}`)
  const findings = ((claimed ?? []) as StoredFinding[]).filter((f) => f.kind !== 'testimonial')
  if (findings.length === 0) {
    return result(ride, { to: 'lens:marketing', delivered: n, refused: parsed.refused, summary: n ? `${kept}; the product doc gets them in the next batch (at most one a day)` : 'Nothing new on this call' })
  }

  // Lines already in the doc (the same quote) are not proposed twice.
  const docLookup = await resolveCanonDocument(supabase, { workspaceId: ctx.workspaceId, userId: ride.ownerUserId, key: MARKETING_DOC_KEY })
  const current = docLookup.ok ? (docLookup.doc.content ?? '') : ''

  // Earlier findings of the workspace's marketing lens: more evidence for a
  // line already in the doc that a new call repeats (M1, regrade.ts). Read
  // once per batch, bounded.
  let history: StoredFinding[] | null = null
  const rideOwner = ride.ownerUserId
  const earlier = async (): Promise<StoredFinding[]> => {
    if (history) return history
    const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString()
    const { data } = await supabase
      .from('lens_finding')
      .select('id, capture_id, kind, body')
      .eq('workspace_id', ctx.workspaceId)
      .eq('lens', 'marketing')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(MAX_HISTORY)
    const rows = ((data ?? []) as StoredFinding[]).filter((f) => f.capture_id && f.body?.read_outside !== true)
    // Only calls this ride's owner may see (P9 review S9): a workspace call, or
    // their own private one; never another member's private call. Fails closed.
    const ids = [...new Set(rows.map((f) => f.capture_id as string))]
    const visible = new Set<string>()
    if (ids.length) {
      const { data: caps, error } = await supabase.from('captures').select('id, visibility, user_id').eq('workspace_id', ctx.workspaceId).neq('is_eval', true).in('id', ids.slice(0, 300))
      if (!error) {
        for (const c of (caps ?? []) as Array<{ id: string; visibility: string | null; user_id: string | null }>) {
          if (c.visibility !== 'private' || c.user_id === rideOwner) visible.add(c.id)
        }
      }
    }
    history = rows.filter((f) => visible.has(f.capture_id as string))
    return history
  }
  /** The grade a line's calls allow (claim-evidence.ts → gradeClaim). */
  const gradeOf = async (captures: ReadonlySet<string>): Promise<ClaimGrade> =>
    gradeClaim(await evidenceFromSources(supabase, ctx.workspaceId, [...captures].slice(0, 10).map((id) => ({ kind: 'capture' as const, id }))))

  const batch = async (subset: StoredFinding[], readOutside: boolean): Promise<{ summary: ConnectorDeliverySummary | null; used: string[] }> => {
    type Entry = { fresh: Array<{ line: string; captures: Set<string> }>; matched: Map<string, Set<string>>; ids: string[]; captures: Set<string> }
    const bySection = new Map<string, Entry>()
    const used: string[] = []
    for (const f of subset) {
      const item = findingItem(f)
      if (!item) continue
      const section = MARKETING_SECTION_FOR[item.kind as Exclude<MarketingItem['kind'], 'testimonial'>]
      if (!section) continue
      // Our words only (B2); nothing of ours left: spent.
      const line = marketingLine(item)
      if (!line) {
        used.push(f.id)
        continue
      }
      const entry: Entry = bySection.get(section) ?? { fresh: [], matched: new Map<string, Set<string>>(), ids: [], captures: new Set<string>() }
      bySection.set(section, entry)
      entry.ids.push(f.id)
      if (f.capture_id) entry.captures.add(f.capture_id)
      // Already in the doc (the same line, or one that says the same thing):
      // no second line, its call is more evidence for that one (M1).
      const docLines = sectionLines(current, section) ?? []
      const existing = docLines.includes(line) ? line : matchingLine(docLines, line)
      if (existing) {
        const set = entry.matched.get(existing) ?? new Set<string>()
        if (f.capture_id) set.add(f.capture_id)
        entry.matched.set(existing, set)
        continue
      }
      // Two findings of this batch that say the same thing are one line.
      const same = entry.fresh.find((x) => similarLine(x.line, line))
      if (same) {
        if (f.capture_id) same.captures.add(f.capture_id)
        continue
      }
      entry.fresh.push({ line, captures: new Set(f.capture_id ? [f.capture_id] : []) })
    }

    const edits: ValidDocEdit[] = []
    const editIds: string[] = []
    let regraded = 0
    for (const [section, e] of bySection) {
      // A new line said on calls with two or more companies goes in proven.
      // Findings from a run that read outside text never raise a grade: they
      // land as assumptions, and are no evidence for a line already there.
      const lines: string[] = []
      for (const x of e.fresh) lines.push(!readOutside && x.captures.size >= 2 ? withGrade(x.line, await gradeOf(x.captures)) : x.line)
      // A line already there regrades from all the calls behind it, earlier ones too.
      const regrades = new Map<string, ClaimGrade>()
      for (const [docLine, captures] of e.matched) {
        if (readOutside || lineGrade(docLine) === 'proven') continue
        const all = new Set(captures)
        for (const h of await earlier()) {
          const hl = findingItem(h)
          const l = hl ? marketingLine(hl) : null
          if (l && h.capture_id && (l === docLine || similarLine(l, docLine))) all.add(h.capture_id)
        }
        if (all.size < 2) continue
        const g = await gradeOf(all)
        if (g !== (lineGrade(docLine) ?? 'assumption') && withGrade(docLine, g) !== docLine) {
          regrades.set(docLine, g)
          for (const id of all) e.captures.add(id)
        }
      }
      const regradedBody = regrades.size ? regradedSection(sectionLines(current, section) ?? [], regrades) : null
      if (!regradedBody && lines.length === 0) {
        // Nothing new and no grade moved: the findings are spent.
        used.push(...e.ids)
        continue
      }
      regraded += regradedBody ? regrades.size : 0
      const calls = e.captures.size === 1 ? 'a call' : `${e.captures.size} calls`
      edits.push(
        regradedBody
          ? {
              section,
              op: 'replace',
              text: [regradedBody, ...lines].filter(Boolean).join('\n'),
              reason: `What customers said on ${calls} (${ctx.skillName}'s marketing lens); regraded ${regrades.size} line${regrades.size === 1 ? '' : 's'} from the evidence`,
              removes: null,
            }
          : { section, op: 'append', text: lines.join('\n'), reason: `What customers said on ${calls} (${ctx.skillName}'s marketing lens)`, removes: null },
      )
      editIds.push(...e.ids)
    }
    if (edits.length === 0) return { summary: null, used }
    const captures = new Set([...bySection.values()].flatMap((e) => [...e.captures]))
    const sources: CanonSource[] = [...captures].slice(0, 10).map((id) => ({ kind: 'capture', id }))
    const summary = await deliverConnectorItems('doc_proposals', edits, {
      supabase,
      workspaceId: ctx.workspaceId,
      runAsUserId: ride.ownerUserId,
      memberId: ride.ownerMemberId,
      runKey: ctx.runKey,
      flowId: ride.flowId,
      captureId: ctx.captureId,
      captureTitle: ctx.captureTitle,
      skillName: ctx.skillName,
      readOutside,
      sources,
      docKey: MARKETING_DOC_KEY,
      ...(docLookup.ok && typeof docLookup.doc.revision === 'number' ? { baseRevision: docLookup.doc.revision } : {}),
    })
    // Applied, a section's findings are spent; refused ones stay open.
    const landed = summary.delivered > 0
    if (landed) used.push(...editIds)
    if (landed && regraded) summary.summary = `${summary.summary}; ${regraded} grade${regraded === 1 ? '' : 's'} moved with the evidence`.slice(0, 200)
    return { summary, used }
  }

  const clean = findings.filter((f) => f.body?.read_outside !== true)
  const outside = findings.filter((f) => f.body?.read_outside === true)
  // Two batches, so each edit's label says what it rests on.
  const applied = await batch(clean, false)
  const appliedOutside = await batch(outside, true)
  const used = new Set([...applied.used, ...appliedOutside.used])
  // What landed (or was already in the doc) is used; the rest goes back for the next batch.
  if (used.size) {
    await supabase.from('lens_finding').update({ status: 'used', used_at: new Date().toISOString() }).eq('workspace_id', ctx.workspaceId).in('id', [...used])
  }
  const back = findings.map((f) => f.id).filter((id) => !used.has(id))
  if (back.length) {
    await supabase.from('lens_finding').update({ status: 'new', used_at: null }).eq('workspace_id', ctx.workspaceId).in('id', back)
  }
  const parts = [applied.summary, appliedOutside.summary].filter((s): s is ConnectorDeliverySummary => !!s)
  const refused = [...parsed.refused, ...parts.flatMap((p) => p.refused)].slice(0, 10)
  const docLine = parts.map((p) => p.summary).join('; ')
  return result(ride, {
    to: 'lens:marketing',
    delivered: n,
    refused,
    summary: [n ? kept : null, docLine || null].filter(Boolean).join('. ').slice(0, 200) || 'Nothing new on this call',
  })
}

function findingItem(f: StoredFinding): MarketingItem | null {
  const text = typeof f.body?.text === 'string' ? f.body.text : ''
  const quote = typeof f.body?.quote === 'string' ? f.body.quote : ''
  if (!text || !quote) return null
  if (f.kind !== 'objection' && f.kind !== 'competitor' && f.kind !== 'customer_language' && f.kind !== 'contradiction') return null
  return { kind: f.kind, text, quote, speaker: typeof f.body?.speaker === 'string' ? f.body.speaker : null }
}
