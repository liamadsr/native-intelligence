// What the Studio has spent, video by video. The app cannot read the provider billing (the key and the signed-in
// tool are the worker's, on the provider accounts it holds), so the ledger is what the Studio itself spent:
// every paid narration and every generation records one charge when it is filed (voiceover.ts, generation.ts),
// with the video it was made for. Generations made elsewhere on the same accounts are not counted, and the summary
// says so in one line.
//
// Usage: these are provider spend on the accounts the Studio worker holds (one per server: only the workspaces
// STUDIO_PROVIDER_WORKSPACES lists may spend there, capabilities.ts; per-workspace provider keys do not exist yet),
// not Native Intelligence's AI usage. They are never debited from Native Intelligence credits (no logUsage / checkUsageLimits): they are recorded
// here, in the Studio's ledger, and nowhere else.
//
//   studio_record  collection `costs`       one record per charge, keyed by its id
//                  collection `cost-rates`  key `default`: dollars per credit for each provider
import { randomUUID } from 'node:crypto'
import { defaultRates, type CostEntry, type CostProvider, type CostRates, type CostSummary } from '../engine/server-types'
import { isUuid, type StudioContext } from './context'
import { StudioError } from './errors'
import { getRecord, getRecords, listRecords, putRecord } from './records'

export const COSTS_COLLECTION = 'costs'
export const RATES_COLLECTION = 'cost-rates'
const RATES_KEY = 'default'

/** The one line every summary carries: what is and isn't counted. */
export const COUNTED_HERE = 'Only what was spent through the Studio is counted: generations made elsewhere on these accounts are not.'

/** One charge: what the Studio spent once, with what the provider said about it. */
export type StudioCharge = {
  id: string
  provider: Exclude<CostProvider, 'claude'>
  at: string
  /** Higgsfield credits, or ElevenLabs characters (its credits). */
  credits: number
  model: string
  kind: string
  /** The video it was made for (null: none, or moved out). */
  videoId: string | null
  /** True once a person moved it between videos. */
  assigned?: boolean
  /** The Studio job that spent it. */
  jobId?: string
  /** The provider's own job or request id. */
  providerJobId?: string
  detail?: string
  /** True when the provider did not say what it charged and the count is the Studio's own (a narration's request length). */
  estimated?: true
  /** The provider's facts at the quote: the balance before, the plan. */
  balance?: number
  plan?: string
}

/** Record one charge. Its id is fixed by the job when there is one, so filing a job twice records it once. */
export async function recordCharge(ctx: StudioContext, charge: Omit<StudioCharge, 'id' | 'at'> & { id?: string; at?: string }): Promise<StudioCharge> {
  const id = charge.id ?? (charge.jobId ? `${charge.provider}:${charge.jobId}` : randomUUID())
  const stored: StudioCharge = {
    ...charge,
    id,
    at: charge.at ?? new Date().toISOString(),
    credits: Math.round(Math.max(0, Number(charge.credits) || 0) * 10_000) / 10_000,
    videoId: charge.videoId && isUuid(charge.videoId) ? charge.videoId : null,
    ...(charge.detail ? { detail: charge.detail.slice(0, 220) } : {}),
  }
  await putRecord(ctx, COSTS_COLLECTION, id, stored)
  return stored
}

/** The workspace's rates (defaults filled in). */
export async function getRates(ctx: StudioContext): Promise<CostRates> {
  const saved = await getRecord<Partial<CostRates>>(ctx, RATES_COLLECTION, RATES_KEY)
  return { higgsfield: { ...defaultRates.higgsfield, ...saved?.higgsfield }, elevenlabs: { ...defaultRates.elevenlabs, ...saved?.elevenlabs } }
}

type RatesPatch = Partial<Record<'higgsfield' | 'elevenlabs', { usdPerCredit?: unknown; plan?: unknown }>>

/** Rates after a change, checked (dollars per credit between 0 and 10, a plan name up to 60 characters). Pure. */
export function patchRates(rates: CostRates, patch: RatesPatch): CostRates {
  const next: CostRates = { higgsfield: { ...rates.higgsfield }, elevenlabs: { ...rates.elevenlabs } }
  for (const p of ['higgsfield', 'elevenlabs'] as const) {
    const r = patch?.[p]
    if (!r || typeof r !== 'object') continue
    if (r.usdPerCredit !== undefined) {
      const v = Number(r.usdPerCredit)
      if (!Number.isFinite(v) || v < 0 || v > 10) throw new StudioError(`${p} rate must be dollars per credit between 0 and 10`)
      next[p].usdPerCredit = v
    }
    if (r.plan !== undefined) next[p].plan = String(r.plan).slice(0, 60)
  }
  return next
}

/** Save the workspace's price per credit. */
export async function setRates(ctx: StudioContext, patch: unknown): Promise<CostRates> {
  const rates = patchRates(await getRates(ctx), (patch ?? {}) as RatesPatch)
  await putRecord(ctx, RATES_COLLECTION, RATES_KEY, rates)
  return rates
}

/** Every charge, oldest first. */
export async function listCharges(ctx: StudioContext): Promise<StudioCharge[]> {
  return (await listRecords<StudioCharge>(ctx, COSTS_COLLECTION, 5000)).map((row) => row.value).sort((a, b) => a.at.localeCompare(b.at))
}

/**
 * A charge as the editor reads it. Whose it is: a person's move first ('manual'), else the video it was made for
 * ('tag'), else nobody ('none'). Pure.
 */
export function toEntry(charge: StudioCharge, rates: CostRates): CostEntry {
  const usd = charge.credits * rates[charge.provider].usdPerCredit
  return {
    id: charge.id,
    provider: charge.provider,
    at: charge.at,
    credits: charge.credits,
    model: charge.model,
    kind: charge.kind,
    ...(charge.detail ? { detail: charge.detail } : {}),
    ...(charge.providerJobId ? { jobId: charge.providerJobId } : {}),
    usd,
    projectId: charge.videoId,
    via: charge.videoId === null ? 'none' : charge.assigned ? 'manual' : 'tag',
  }
}

const sum = (list: CostEntry[], f: (e: CostEntry) => number) => Math.round(list.reduce((s, e) => s + f(e), 0) * 10_000) / 10_000

/** What a video cost: totals by provider and by model, its charges newest first, and the charges no video owns. Pure. */
export function summarize(videoId: string, charges: StudioCharge[], rates: CostRates): CostSummary {
  const all = charges.map((c) => toEntry(c, rates))
  const entries = all.filter((e) => e.projectId === videoId)
  const unassigned = all.filter((e) => e.projectId === null).slice(-200)
  const group = (key: (e: CostEntry) => string) => {
    const m = new Map<string, CostEntry[]>()
    for (const e of entries) m.set(key(e), [...(m.get(key(e)) ?? []), e])
    return m
  }
  return {
    projectId: videoId,
    usd: sum(entries, (e) => e.usd),
    warnings: [COUNTED_HERE],
    rates,
    providers: [...group((e) => e.provider)].map(([provider, list]) => ({ provider: provider as CostProvider, credits: sum(list, (e) => e.credits), usd: sum(list, (e) => e.usd), count: list.length })).sort((a, b) => b.usd - a.usd),
    models: [...group((e) => `${e.provider}|${e.model}|${e.kind}`)]
      .map(([k, list]) => {
        const [provider, model, kind] = k.split('|') as [CostProvider, string, string]
        return { provider, model, kind, count: list.length, credits: sum(list, (e) => e.credits), usd: sum(list, (e) => e.usd) }
      })
      .sort((a, b) => b.usd - a.usd),
    entries: entries.reverse(),
    unassigned: unassigned.reverse(),
  }
}

/** GET /projects/:id/costs. */
export async function videoCosts(ctx: StudioContext, videoId: string): Promise<CostSummary> {
  const [charges, rates] = await Promise.all([listCharges(ctx), getRates(ctx)])
  return summarize(videoId, charges, rates)
}

/** Move charges to a video, or to none with null. Answers how many moved. */
export async function assignCharges(ctx: StudioContext, ids: unknown, videoId: unknown): Promise<number> {
  if (!Array.isArray(ids) || (videoId !== null && !isUuid(videoId))) throw new StudioError('ids (list) and projectId (or null) are required')
  const wanted = [...new Set(ids.map(String))].slice(0, 5000)
  const found = await getRecords<StudioCharge>(ctx, COSTS_COLLECTION, wanted)
  for (const charge of found.values()) await putRecord(ctx, COSTS_COLLECTION, charge.id, { ...charge, videoId, assigned: true } satisfies StudioCharge)
  return found.size
}
