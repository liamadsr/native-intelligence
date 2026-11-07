/**
 * Which call flows ride Triage's read of this call (flows F3, lenses.ts).
 * The capture_processed dispatcher calls it once per call, before it runs any
 * flow (src/lib/inngest/flow-functions.ts):
 *
 *   host      the workspace's seeded Triage loop, when it is on and its first
 *             enabled step runs a verdict skill: the ONE run that reads the call.
 *   rides     each lens flow whose condition holds on this call. It runs no
 *             skill of its own; its section rides the host's run, and the
 *             dispatcher records its outcome on its own flow's run afterwards.
 *   skipped   each lens flow whose condition does not hold (marketing on an
 *             internal call, content on a call its owner wasn't on): a
 *             skipped run, no model call.
 *   fallback  each lens flow that runs on its own because there is no host
 *             (Triage is off): its skill runs with the same section and schema.
 *
 * Deterministic and cheap: with only Triage on (the default), it reads one
 * recipe row; the call's facts are read only when a lens flow is on. Every
 * read is fenced by the workspace. Fails SOFT: any error yields an empty plan,
 * and every flow then runs exactly as it did before lenses.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
/** The seeded Triage loop's seed key (seed-default-loops.ts SEED_KEYS.triage; pinned equal by lenses.test.ts). Inlined: that module pulls the bot graph. */
export const TRIAGE_SEED_KEY = 'seed:triage'
import { isLensKey, lensSkipReason, type LensCallFacts, type LensKey, type LensRide } from './lenses'
import { blockedPhrases, contentWords, type OwnerSpeech } from '@/lib/content/public-safe'
import { channelOf, spokenWords } from '@/lib/transcript/quote-speakers'
import type { FlowAction, RunSkillActionConfig } from './types'

/** A flow as the dispatcher holds it. */
export interface PlannableFlow {
  id: string
  created_by: string | null
  seed_key?: string | null
  actions: FlowAction[]
}

export interface LensPlan {
  hostFlowId: string | null
  rides: LensRide[]
  skipped: Array<{ flowId: string; actionId: string; lens: LensKey; reason: string }>
  fallback: LensRide[]
  /** The call's facts, when a lens flow is on (frozen for delivery). */
  facts: LensCallFacts | null
}

export const EMPTY_LENS_PLAN: LensPlan = { hostFlowId: null, rides: [], skipped: [], fallback: [], facts: null }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A flow's first enabled run_skill step. */
function firstSkillStep(flow: PlannableFlow): FlowAction | null {
  return flow.actions.find((a) => a.type === 'run_skill' && a.enabled !== false && UUID_RE.test(String((a.config as RunSkillActionConfig)?.skill_id ?? ''))) ?? null
}

interface SkillRow {
  id: string
  agent_config: { lens?: unknown; output_contract?: unknown } | null
}

/**
 * Whether any lens could ride: a flow other than Triage runs a skill. Pure, so
 * the dispatcher checks it OUTSIDE an Inngest step (review N1): with only
 * Triage on (everyone today) no plan step runs at all.
 */
export function mayHaveLensFlows(flows: readonly PlannableFlow[]): boolean {
  return flows.some((f) => f.seed_key !== TRIAGE_SEED_KEY && firstSkillStep(f) !== null)
}

export async function planLensRides(
  supabase: SupabaseClient,
  args: { workspaceId: string; captureId: string; flows: readonly PlannableFlow[] },
): Promise<LensPlan> {
  try {
    const steps = new Map<string, FlowAction>()
    for (const flow of args.flows) {
      const step = firstSkillStep(flow)
      if (step) steps.set(flow.id, step)
    }
    // Only Triage (or nothing) is on: no lens can ride, nothing to read.
    if (!mayHaveLensFlows(args.flows)) return EMPTY_LENS_PLAN

    const skillIds = [...new Set([...steps.values()].map((a) => (a.config as RunSkillActionConfig).skill_id))]
    const { data: skillRows, error: skillError } = await supabase
      .from('recipe')
      .select('id, agent_config')
      .in('id', skillIds)
      .eq('category', 'skill')
      .or(`workspace_id.eq.${args.workspaceId},is_system.eq.true`)
    if (skillError) return EMPTY_LENS_PLAN
    const skills = new Map(((skillRows ?? []) as SkillRow[]).map((r) => [r.id, r.agent_config ?? {}]))
    const skillOf = (flowId: string) => skills.get((steps.get(flowId)!.config as RunSkillActionConfig).skill_id)

    const lensFlows = args.flows
      .filter((f) => steps.has(f.id) && f.seed_key !== TRIAGE_SEED_KEY)
      .flatMap((f) => {
        const lens = skillOf(f.id)?.lens
        return isLensKey(lens) && f.created_by ? [{ flow: f, lens, step: steps.get(f.id)! }] : []
      })
    if (lensFlows.length === 0) return EMPTY_LENS_PLAN

    const host = args.flows.find((f) => f.seed_key === TRIAGE_SEED_KEY && steps.has(f.id) && skillOf(f.id)?.output_contract === 'verdict') ?? null

    const facts = await loadCallFacts(supabase, args.workspaceId, args.captureId)
    if (!facts) return EMPTY_LENS_PLAN

    // The owners' member rows (name for the person lens's section).
    const ownerIds = [...new Set(lensFlows.map((l) => l.flow.created_by as string))]
    const { data: owners } = await supabase
      .from('member')
      .select('id, user_id, display_name')
      .eq('workspace_id', args.workspaceId)
      .in('user_id', ownerIds)
    const ownerByUser = new Map(((owners ?? []) as Array<{ id: string; user_id: string; display_name: string | null }>).map((o) => [o.user_id, o]))

    const plan: LensPlan = { hostFlowId: host?.id ?? null, rides: [], skipped: [], fallback: [], facts }
    for (const { flow, lens, step } of lensFlows) {
      const owner = ownerByUser.get(flow.created_by as string)
      if (!owner) {
        plan.skipped.push({ flowId: flow.id, actionId: step.id, lens, reason: "Skipped: this loop's owner is no longer in the workspace" })
        continue
      }
      const ride: LensRide = { flowId: flow.id, actionId: step.id, lens, ownerUserId: owner.user_id, ownerMemberId: owner.id, ownerName: owner.display_name ?? null }
      const skip = lensSkipReason(ride, facts)
      if (skip) plan.skipped.push({ flowId: flow.id, actionId: step.id, lens, reason: skip })
      else if (host) plan.rides.push(ride)
      else plan.fallback.push(ride)
    }
    return plan
  } catch {
    return EMPTY_LENS_PLAN
  }
}

/**
 * The call's facts the lenses' conditions read: who from the workspace was on
 * it (the capture's owner and member participants), and whether anyone from
 * outside was (a participant who is not a member and is a contact or has an
 * address), with their names and companies for the public-safe screen. Null
 * when the capture can't be read.
 */
export async function loadCallFacts(supabase: SupabaseClient, workspaceId: string, captureId: string): Promise<LensCallFacts | null> {
  const [{ data: capture }, { data: participants }, { data: links }] = await Promise.all([
    supabase.from('captures').select('id, title, user_id').eq('id', captureId).eq('workspace_id', workspaceId).maybeSingle(),
    supabase.from('capture_participant').select('member_id, external_name, external_email, contact_id, company, is_self').eq('capture_id', captureId).limit(200),
    // The CRM contacts and companies linked to the call (entity links, either direction).
    supabase
      .from('entity_link')
      .select('source_type, source_id, target_type, target_id')
      .eq('workspace_id', workspaceId)
      .or(`and(source_type.eq.capture,source_id.eq.${captureId}),and(target_type.eq.capture,target_id.eq.${captureId})`)
      .limit(200),
  ])
  if (!capture) return null
  const cap = capture as { id: string; title: string | null; user_id: string | null }
  const rows = (participants ?? []) as Array<{ member_id: string | null; external_name: string | null; external_email: string | null; contact_id: string | null; company: string | null; is_self: boolean | null }>
  const memberIds = new Set<string>(rows.map((p) => p.member_id).filter((id): id is string => !!id))
  if (cap.user_id) {
    const { data: ownerMember } = await supabase.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', cap.user_id).maybeSingle()
    const id = (ownerMember as { id?: unknown } | null)?.id
    if (typeof id === 'string') memberIds.add(id)
  }
  const nonMembers = rows.filter((p) => !p.member_id && !p.is_self)
  // External: someone from outside the workspace we can place (a contact, an address).
  const outside = nonMembers.filter((p) => !!p.contact_id || !!(p.external_email ?? '').trim())

  // The CRM's names for the call: its participants' contacts, and the contacts
  // and companies linked to it, with each contact's company.
  const contactIds = new Set<string>(nonMembers.map((p) => p.contact_id).filter((id): id is string => !!id))
  const companyIds = new Set<string>()
  for (const l of (links ?? []) as Array<{ source_type: string; source_id: string; target_type: string; target_id: string }>) {
    const [type, id] = l.source_type === 'capture' ? [l.target_type, l.target_id] : [l.source_type, l.source_id]
    if (type === 'contact') contactIds.add(id)
    if (type === 'company') companyIds.add(id)
  }
  const people: Array<{ full: string | null; last: string | null }> = nonMembers.map((p) => ({ full: p.external_name, last: null }))
  const companies: Array<string | null> = nonMembers.map((p) => p.company)
  if (contactIds.size) {
    const { data: contacts } = await supabase.from('contact').select('full_name, last_name, company_id').eq('workspace_id', workspaceId).in('id', [...contactIds].slice(0, 100))
    for (const c of (contacts ?? []) as Array<{ full_name: string | null; last_name: string | null; company_id: string | null }>) {
      people.push({ full: c.full_name, last: c.last_name })
      if (c.company_id) companyIds.add(c.company_id)
    }
  }
  if (companyIds.size) {
    const { data: rowsCo } = await supabase.from('company').select('name').eq('workspace_id', workspaceId).in('id', [...companyIds].slice(0, 100))
    for (const c of (rowsCo ?? []) as Array<{ name: string | null }>) companies.push(c.name)
  }
  const outsideNames = blockedPhrases({ people, companies })
  return { captureId: cap.id, captureTitle: cap.title ?? null, memberIdsOnCall: [...memberIds], external: outside.length > 0, outsideNames }
}

/**
 * What the lens flow's owner said on the call (F3 review S3/R3): each of their
 * utterances, as content words. Their voice is the participant row naming
 * them (their member id), or, on a call they recorded, their identified self
 * row; on their own recording with no voice identified, their own
 * microphone's lines stand in, but only when ONE voice is on that
 * microphone (several local voices: a room, so nobody's lines can be told
 * apart). Null when none of their lines can be told apart (then no moment is
 * kept), or on a failed read.
 */
export async function loadOwnerWords(
  supabase: SupabaseClient,
  args: { workspaceId: string; captureId: string; ownerMemberId: string; ownerUserId: string },
): Promise<OwnerSpeech | null> {
  try {
    const [{ data: capture }, { data: participants }] = await Promise.all([
      supabase.from('captures').select('transcript, user_id').eq('id', args.captureId).eq('workspace_id', args.workspaceId).maybeSingle(),
      supabase.from('capture_participant').select('member_id, speaker_label, is_self, self_binding').eq('capture_id', args.captureId).limit(200),
    ])
    const cap = capture as { transcript: string | null; user_id: string | null } | null
    if (!cap?.transcript) return null
    const rows = (participants ?? []) as Array<{ member_id: string | null; speaker_label: string | null; is_self: boolean | null; self_binding: string | null }>
    const recordedByOwner = cap.user_id === args.ownerUserId
    const labels = new Set<string>()
    for (const p of rows) {
      const label = p.speaker_label?.trim()
      if (!label) continue
      if (p.member_id === args.ownerMemberId) labels.add(label)
      else if (recordedByOwner && p.is_self === true && (p.self_binding ?? 'none') !== 'none') labels.add(label)
    }
    const words = spokenWords(cap.transcript)
    if (labels.size === 0 && recordedByOwner) {
      const localVoices = new Set(words.map((w) => w.label).filter((l): l is string => !!l && channelOf(l) === 'microphone'))
      const othersLabels = new Set(rows.filter((p) => p.speaker_label && p.member_id !== args.ownerMemberId && !p.is_self).map((p) => p.speaker_label!.trim()))
      if (localVoices.size === 1) for (const l of localVoices) if (!othersLabels.has(l)) labels.add(l)
    }
    if (labels.size === 0) return null
    const utterances: string[][] = []
    let current: string[] | null = null
    let currentLabel: string | null = null
    for (const w of words) {
      if (w.label !== currentLabel) {
        currentLabel = w.label
        current = w.label && labels.has(w.label) ? [] : null
        if (current) utterances.push(current)
      }
      if (current) current.push(...contentWords(w.word))
    }
    const kept = utterances.filter((u) => u.length > 0)
    return kept.length ? { utterances: kept } : null
  } catch {
    return null
  }
}
