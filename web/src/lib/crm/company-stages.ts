/**
 * A company's own lifecycle stage, owner and revenue (migration 679).
 *
 * Stages are the workspace's (`company_stage`, defaults Lead, Demo,
 * Customer, Churned); a company sits at one or at none ("No stage"). Only an
 * owner or admin edits the list (RLS and reset_company_stages decide, never
 * this file); deleting a stage moves its companies to No stage (the foreign
 * key sets null). Nothing moves a company's stage on its own: the
 * kept-up-to-date system leaves it alone in this round.
 *
 * The owner is a workspace member; revenue is a currency value
 * ({ amount, currency }, the custom fields' shape). The database's trigger
 * (company_crm_fields_guard) refuses a stage or owner from another
 * workspace; `parseCompanyCrmFields` gives a person a clear reason first.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_CURRENCY,
  formatCurrency,
  isCurrencyCode,
  parseCurrency,
  type CurrencyValue,
} from '@/lib/crm/custom-field-types'

export interface CompanyStage {
  id: string
  name: string
  position: number
}

export const DEFAULT_COMPANY_STAGES = ['Lead', 'Demo', 'Customer', 'Churned'] as const
export const NO_STAGE_LABEL = 'No stage'
export const STAGE_NAME_MAX = 60
export const MAX_COMPANY_STAGES = 30

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/** The workspace's stages, in order. */
export async function listCompanyStages(db: SupabaseClient, workspaceId: string): Promise<CompanyStage[]> {
  const { data, error } = await db
    .from('company_stage')
    .select('id, name, position')
    .eq('workspace_id', workspaceId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as CompanyStage[]
}

/** A stage name as stored, or why not. */
export function cleanStageName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'A stage needs a name.' }
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name) return { ok: false, error: 'A stage needs a name.' }
  if (name.length > STAGE_NAME_MAX) return { ok: false, error: `A stage name is at most ${STAGE_NAME_MAX} characters.` }
  return { ok: true, name }
}

/** The stage a person or the agent named: an id, or a name (any case). */
export function resolveStage(stages: readonly CompanyStage[], raw: unknown): CompanyStage | null | undefined {
  if (raw === null || raw === '' || (typeof raw === 'string' && raw.trim().toLowerCase() === NO_STAGE_LABEL.toLowerCase())) return null
  if (typeof raw !== 'string') return undefined
  const byId = stages.find((s) => s.id === raw)
  if (byId) return byId
  const lower = raw.trim().toLowerCase()
  return stages.find((s) => s.name.toLowerCase() === lower)
}

/** A revenue as stored: { amount, currency }, from a number, "€120k"-ish text or a value. */
export function coerceRevenue(raw: unknown, fallbackCurrency = DEFAULT_CURRENCY): { ok: true; value: CurrencyValue | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && Math.abs(raw) < 1e15 ? { ok: true, value: { amount: raw, currency: fallbackCurrency } } : { ok: false, error: 'Revenue is an amount.' }
  }
  if (typeof raw === 'string') {
    const k = /^\s*([$€£]?)\s*([\d.,]+)\s*([kKmMbB])\s*([A-Za-z]{3})?\s*$/.exec(raw)
    if (k) {
      const base = Number(k[2].replace(/,/g, ''))
      const mult = { k: 1e3, m: 1e6, b: 1e9 }[k[3].toLowerCase() as 'k' | 'm' | 'b']
      const rest = parseCurrency(`${k[1]}1 ${k[4] ?? ''}`.trim(), fallbackCurrency)
      if (Number.isFinite(base) && rest) return { ok: true, value: { amount: base * mult, currency: rest.currency } }
    }
    const v = parseCurrency(raw, fallbackCurrency)
    return v ? { ok: true, value: v } : { ok: false, error: 'Revenue is an amount, like 120000 or "€120,000".' }
  }
  if (typeof raw === 'object') {
    const v = raw as Partial<CurrencyValue>
    const amount = typeof v.amount === 'string' ? Number(v.amount) : v.amount
    const currency = typeof v.currency === 'string' ? v.currency.toUpperCase() : fallbackCurrency
    if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.abs(amount) >= 1e15) return { ok: false, error: 'Revenue is an amount.' }
    if (!isCurrencyCode(currency)) return { ok: false, error: 'A currency is a three-letter code, like USD.' }
    return { ok: true, value: { amount, currency } }
  }
  return { ok: false, error: 'Revenue is an amount.' }
}

export function formatRevenue(v: unknown): string {
  const r = v as Partial<CurrencyValue> | null
  return r && typeof r.amount === 'number' && typeof r.currency === 'string' ? formatCurrency(r as CurrencyValue) : ''
}

export interface CompanyCrmInput {
  stage?: unknown
  stage_id?: unknown
  owner_member_id?: unknown
  revenue?: unknown
}

export type CompanyCrmUpdates = { stage_id?: string | null; owner_member_id?: string | null; revenue?: CurrencyValue | null }

/**
 * The stage, owner and revenue a caller sent, as columns, checked against
 * the workspace (its stages, its members). Only the keys sent come back.
 */
export async function parseCompanyCrmFields(
  db: SupabaseClient,
  workspaceId: string,
  input: CompanyCrmInput,
): Promise<{ ok: true; updates: CompanyCrmUpdates } | { ok: false; error: string }> {
  const updates: CompanyCrmUpdates = {}
  const stageRaw = input.stage_id !== undefined ? input.stage_id : input.stage
  if (stageRaw !== undefined) {
    const stages = await listCompanyStages(db, workspaceId)
    const stage = resolveStage(stages, stageRaw)
    if (stage === undefined) {
      return { ok: false, error: `No company stage named that. The stages are: ${stages.map((s) => s.name).join(', ') || 'none yet'} (or "${NO_STAGE_LABEL}").` }
    }
    updates.stage_id = stage?.id ?? null
  }
  if (input.owner_member_id !== undefined) {
    if (input.owner_member_id === null || input.owner_member_id === '') updates.owner_member_id = null
    else {
      if (!isUuid(input.owner_member_id)) return { ok: false, error: 'The owner is a workspace member id.' }
      const { data } = await db.from('member').select('id').eq('id', input.owner_member_id).eq('workspace_id', workspaceId).maybeSingle()
      if (!data) return { ok: false, error: 'The owner must be a member of this workspace.' }
      updates.owner_member_id = input.owner_member_id
    }
  }
  if (input.revenue !== undefined) {
    const r = coerceRevenue(input.revenue)
    if (!r.ok) return r
    updates.revenue = r.value
  }
  return { ok: true, updates }
}

/** A grouped list's groups, laid out by stage: one per stage in order, empty ones too, then No stage. */
export interface StageGroup {
  key: string
  label: string
  items: Record<string, unknown>[]
  metadata?: Record<string, unknown>
}

export function layoutCompanyStageGroups<G extends StageGroup>(
  grouped: G[],
  stages: readonly CompanyStage[],
  direction: 'asc' | 'desc' = 'asc',
  make: (key: string, label: string) => G = (key, label) => ({ key, label, items: [] }) as unknown as G,
): G[] {
  const byKey = new Map(grouped.map((g) => [g.key, g]))
  const ordered: G[] = []
  const list = direction === 'desc' ? [...stages].reverse() : [...stages]
  for (const s of list) {
    const g = byKey.get(s.id) ?? make(s.id, s.name)
    g.label = s.name
    ordered.push(g)
    byKey.delete(s.id)
  }
  // A stage the list no longer has (deleted meanwhile) keeps its rows visible.
  for (const [key, g] of byKey) if (key !== '__none__') ordered.push(g)
  const none = byKey.get('__none__') ?? make('__none__', NO_STAGE_LABEL)
  none.label = NO_STAGE_LABEL
  ordered.push(none)
  return ordered
}
