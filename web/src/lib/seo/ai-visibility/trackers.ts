/**
 * Creating, changing and deleting AI visibility trackers and their prompts:
 * the one core behind the SEO page's routes and the agent's tools, so both
 * follow the same rules.
 *
 *   - Any member of the workspace may set up and change trackers. Saving
 *     costs nothing; only a check spends (./runs.ts).
 *   - No website named means the workspace's own (../site.ts).
 *   - The caps (./limits.ts) hold here: trackers per workspace, prompts per
 *     tracker (under a lock in seo_ai_add_prompts), competitors, other names,
 *     engines. An engine that cannot answer in the chosen country is refused.
 *   - A schedule spends every period, so recurring spend is set up or raised
 *     only by a person who may spend and said yes:
 *       - turning a schedule on (a new tracker with one, off or paused to
 *         on), even with no prompts yet, and ANY change that raises the
 *         monthly cost of a tracker whose schedule is on (more prompts,
 *         prompts turned back on, more or pricier engines, weekly instead of
 *         monthly) first passes the access check (../access.ts: a turn
 *         nobody is in, a workspace guest and a plan that does not pay are
 *         refused), then needs `confirmed` (the person saw the estimate and
 *         said yes). Without it the answer is CONFIRMATION_REQUIRED with the
 *         estimate before and after, and nothing is saved. There is no
 *         floor: a recurring rise of a cent asks too, so splitting an
 *         addition into small parts never skips the question.
 *       - changing a running schedule's interval passes the access check
 *         too, because it makes the person the schedule's owner.
 *   - The schedule's owner (created_by) pays for it: their plan is what a
 *     scheduled check checks (./gate.ts), and the workspace's ceiling pays.
 *     It changes only to a person who just passed the access check, when
 *     they turn the schedule on or change its interval. (A tracker saved
 *     with no running schedule records who made it; turning its schedule on
 *     later replaces that with the person who did.)
 *   - A tracker with a check running can't be deleted (stop the check first).
 */
import {
  checkSeoDataAccess,
  type SeoDataAccess,
  type SeoDataRefusal,
} from '@/lib/seo/access'
import {
  aiEnginesWithoutLocation,
  type AiEngine,
} from '@/lib/seo/shared/ai-visibility'
import { normalizeDomain } from '@/lib/seo/shared/domain'
import {
  isSupportedLanguageCode,
  isSupportedLocationCode,
} from '@/lib/seo/shared/keyword-locations'
import { computeNextCheckAt } from '@/lib/seo/shared/rank-tracking'
import { isValidDomainHost } from '@/lib/seo/shared/researchScope'
import { workspaceSiteUrl } from '@/lib/seo/site'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { estimateAiCost, formatUsd } from './cost'
import {
  AI_SCHEDULE_INTERVALS,
  ALL_AI_ENGINES,
  DEFAULT_ENGINES,
  DEFAULT_SCHEDULE,
  MAX_ALIASES,
  MAX_BRAND_NAME_LENGTH,
  MAX_COMPETITORS,
  MAX_PROMPT_LENGTH,
  MAX_PROMPTS_PER_ADD,
  MAX_PROMPTS_PER_TRACKER,
  MAX_TRACKERS_PER_WORKSPACE,
  type AiScheduleSetting,
} from './limits'
import {
  getLiveRun,
  getTrackerRow,
  listPrompts,
  promptView,
  TRACKER_FIELDS,
  trackerView,
  type TrackerRow,
} from './queries'
import {
  engineLabel,
  type AiBrandRef,
  type AiCostEstimate,
  type AiPromptSource,
  type AiPromptView,
  type AiTrackerView,
} from './view'

export interface TrackerInput {
  brand_name?: string
  brand_aliases?: string[]
  /** The brand's website. Create: default the workspace's own. */
  domain?: string | null
  competitors?: Array<{
    name?: string | null
    domain: string
    aliases?: string[]
  }>
  location_code?: number
  language_code?: string
  engines?: AiEngine[]
  schedule_interval?: AiScheduleSetting
  paused?: boolean
}

export interface PromptInput {
  text: string
  source?: AiPromptSource
}

export type TrackerFailure =
  | {
      ok: false
      code:
        | 'VALIDATION_ERROR'
        | 'NO_SITE'
        | 'TRACKER_LIMIT'
        | 'DUPLICATE_TRACKER'
        | 'NOT_FOUND'
        | 'RUN_IN_PROGRESS'
        | 'SAVE_FAILED'
      message: string
    }
  | {
      ok: false
      code: 'CONFIRMATION_REQUIRED'
      message: string
      estimate: AiCostEstimate
      previous_estimate: AiCostEstimate | null
    }
  | SeoDataRefusal

/** `unattended`: a turn nobody is in (a loop, a scheduled skill run). It never sets up or raises recurring spend. */
export type Who = { workspaceId: string; userId: string; unattended?: boolean }

export interface TrackerDeps {
  checkAccess?: (who: {
    userId: string | null
    workspaceId?: string | null
    unattended?: boolean
  }) => Promise<SeoDataAccess>
}

const invalid = (message: string): TrackerFailure => ({
  ok: false,
  code: 'VALIDATION_ERROR',
  message,
})
const notFound: TrackerFailure = {
  ok: false,
  code: 'NOT_FOUND',
  message: 'That tracker doesn’t exist.',
}

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim()

/** A prompt as stored: spaces collapsed. Its key: also lowercased (the same question typed twice is one prompt). */
export function normalizePrompt(text: string): { text: string; key: string } {
  const clean = collapse(text.replaceAll('\0', ''))
  return { text: clean, key: clean.toLowerCase() }
}

function cleanDomain(value: string): string | null {
  try {
    const host = normalizeDomain(value)
    return host.includes('.') && isValidDomainHost(host) && host.length <= 253
      ? host
      : null
  } catch {
    return null
  }
}

function cleanAliases(
  values: string[] | undefined,
  exclude: string[],
): string[] | TrackerFailure {
  const out: string[] = []
  const seen = new Set(exclude.map((v) => v.toLowerCase()))
  for (const raw of values ?? []) {
    const alias = collapse(String(raw))
    if (alias.length < 2) continue
    if (alias.length > MAX_BRAND_NAME_LENGTH)
      return invalid(
        `Keep each other name under ${MAX_BRAND_NAME_LENGTH} characters.`,
      )
    if (seen.has(alias.toLowerCase())) continue
    seen.add(alias.toLowerCase())
    out.push(alias)
  }
  if (out.length > MAX_ALIASES)
    return invalid(`A brand can have up to ${MAX_ALIASES} other names.`)
  return out
}

function isFailure(value: unknown): value is TrackerFailure {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { ok?: unknown }).ok === false
  )
}

interface CleanTracker {
  brand_name: string
  brand_aliases: string[]
  domain: string
  competitors: AiBrandRef[]
  location_code: number
  language_code: string
  engines: AiEngine[]
  schedule_interval: AiScheduleSetting
  paused: boolean
}

/** The whole tracker after `input` is laid over `base`, validated. */
function cleanTracker(
  base: CleanTracker,
  input: TrackerInput,
): CleanTracker | TrackerFailure {
  const brandName =
    input.brand_name !== undefined
      ? collapse(input.brand_name)
      : base.brand_name
  if (!brandName)
    return invalid('Give the brand’s name, the way people write it.')
  if (brandName.length > MAX_BRAND_NAME_LENGTH)
    return invalid(
      `Keep the brand name under ${MAX_BRAND_NAME_LENGTH} characters.`,
    )

  let domain = base.domain
  if (input.domain !== undefined && input.domain !== null) {
    const cleaned = cleanDomain(input.domain)
    if (!cleaned)
      return invalid(
        'That isn’t a website address. Give a domain like example.com.',
      )
    domain = cleaned
  }

  const aliases =
    input.brand_aliases !== undefined
      ? cleanAliases(input.brand_aliases, [brandName])
      : base.brand_aliases
  if (isFailure(aliases)) return aliases

  let competitors = base.competitors
  if (input.competitors !== undefined) {
    competitors = []
    for (const c of input.competitors) {
      const d = cleanDomain(String(c?.domain ?? ''))
      if (!d)
        return invalid(
          `“${String(c?.domain ?? '')}” isn’t a website address. Give each competitor’s domain, like example.com.`,
        )
      if (d === domain || competitors.some((x) => x.domain === d)) continue
      const name = collapse(String(c.name ?? '')) || d
      if (name.length > MAX_BRAND_NAME_LENGTH)
        return invalid(
          `Keep each competitor’s name under ${MAX_BRAND_NAME_LENGTH} characters.`,
        )
      const competitorAliases = cleanAliases(c.aliases, [name])
      if (isFailure(competitorAliases)) return competitorAliases
      competitors.push({ name, domain: d, aliases: competitorAliases })
    }
    if (competitors.length > MAX_COMPETITORS)
      return invalid(
        `A tracker compares with up to ${MAX_COMPETITORS} competitors.`,
      )
  }

  const locationCode = input.location_code ?? base.location_code
  const languageCode = (input.language_code ?? base.language_code)
    .trim()
    .toLowerCase()
  if (!Number.isInteger(locationCode) || !isSupportedLocationCode(locationCode))
    return invalid('That country isn’t one we can check.')
  if (!isSupportedLanguageCode(languageCode))
    return invalid('That language isn’t one we can check.')

  let engines = base.engines
  if (input.engines !== undefined) {
    engines = ALL_AI_ENGINES.filter((e) => input.engines?.includes(e))
    if (input.engines.some((e) => !ALL_AI_ENGINES.includes(e)))
      return invalid(`Engines are ${ALL_AI_ENGINES.join(', ')}.`)
    if (engines.length === 0) return invalid('Choose at least one AI engine.')
  }
  const unsupported = aiEnginesWithoutLocation(engines, locationCode)
  if (unsupported.length) {
    return invalid(
      `${unsupported.map(engineLabel).join(' and ')} can’t be checked in this country. Leave ${unsupported.length === 1 ? 'it' : 'them'} out or pick another country.`,
    )
  }

  const interval = input.schedule_interval ?? base.schedule_interval
  if (!AI_SCHEDULE_INTERVALS.includes(interval))
    return invalid('The schedule is off, weekly or monthly.')

  return {
    brand_name: brandName,
    brand_aliases: aliases,
    domain,
    competitors,
    location_code: locationCode,
    language_code: languageCode,
    engines,
    schedule_interval: interval,
    paused: input.paused ?? base.paused,
  }
}

function estimateFor(
  t: Pick<
    CleanTracker,
    'engines' | 'schedule_interval' | 'location_code' | 'paused'
  >,
  promptCount: number,
): AiCostEstimate {
  return estimateAiCost({
    promptCount,
    engines: t.engines,
    scheduleInterval: t.paused ? 'off' : t.schedule_interval,
    locationCode: t.location_code,
  })
}

function confirmationRequired(
  message: string,
  estimate: AiCostEstimate,
  previous: AiCostEstimate | null,
): TrackerFailure {
  return {
    ok: false,
    code: 'CONFIRMATION_REQUIRED',
    message,
    estimate,
    previous_estimate: previous,
  }
}

/** The schedule runs: on, and not paused. */
function scheduleRuns(t: Pick<CleanTracker, 'schedule_interval' | 'paused'>) {
  return t.schedule_interval !== 'off' && !t.paused
}

/** May this person set up or change recurring spend? The access check, as a paid lookup would run it. */
async function mayRunSchedule(
  who: Who,
  deps: TrackerDeps,
): Promise<SeoDataRefusal | null> {
  const access = await (deps.checkAccess ?? checkSeoDataAccess)({
    userId: who.userId,
    workspaceId: who.workspaceId,
    unattended: who.unattended === true,
  })
  return access.ok ? null : access
}

/**
 * Recurring spend set up or raised: the access check first (so a guest, a
 * plan that does not pay or a turn nobody is in is refused before being
 * asked), then the person's yes. Null when it may go ahead.
 */
async function recurringSpendGate(
  who: Who,
  deps: TrackerDeps,
  confirmed: boolean | undefined,
  ask: {
    message: string
    estimate: AiCostEstimate
    previous: AiCostEstimate | null
  },
): Promise<TrackerFailure | null> {
  const refused = await mayRunSchedule(who, deps)
  if (refused) return refused
  if (confirmed !== true)
    return confirmationRequired(ask.message, ask.estimate, ask.previous)
  return null
}

/** What turning a schedule on costs, in words. */
function scheduleOnMessage(
  interval: AiScheduleSetting,
  estimate: AiCostEstimate,
  action: string,
): string {
  const spend = `A ${interval} schedule spends on every check: about ${formatUsd(estimate.run_usd)} a check, ${formatUsd(estimate.monthly_usd)} a month with ${estimate.prompt_count} prompts.`
  const later =
    estimate.prompt_count === 0
      ? ' It costs nothing until prompts are added, and each addition asks again.'
      : ''
  return `${spend}${later} Confirm to ${action}.`
}

/** Whether the monthly cost goes up (beyond rounding). */
const monthlyRises = (before: AiCostEstimate, after: AiCostEstimate) =>
  after.monthly_usd > before.monthly_usd + 1e-9

function rowAsClean(row: TrackerRow): CleanTracker {
  const view = trackerView(row)
  return {
    brand_name: view.brand_name,
    brand_aliases: view.brand_aliases,
    domain: view.domain,
    competitors: view.competitors,
    location_code: view.location_code,
    language_code: view.language_code,
    engines: view.engines,
    schedule_interval: view.schedule_interval,
    paused: view.paused,
  }
}

async function activePromptCount(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
): Promise<number> {
  const { count, error } = await svc
    .from('seo_ai_prompt')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('tracker_id', trackerId)
    .eq('active', true)
  if (error) throw new Error(`seo ai prompt count failed: ${error.message}`)
  return count ?? 0
}

/** The estimate of one check and a month of the schedule for a saved tracker, as it is or with `override` laid over it. Free. */
export async function estimateTracker(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
  override: TrackerInput & { prompt_count?: number } = {},
): Promise<{ ok: true; estimate: AiCostEstimate } | TrackerFailure> {
  const row = await getTrackerRow(svc, workspaceId, trackerId)
  if (!row) return notFound
  const merged = cleanTracker(rowAsClean(row), override)
  if (isFailure(merged)) return merged
  const prompts =
    override.prompt_count ??
    (await activePromptCount(svc, workspaceId, trackerId))
  return { ok: true, estimate: estimateFor(merged, prompts) }
}

/** The estimate for settings not saved yet (the setup form, or the agent proposing a tracker). Free. */
export function estimateProposal(
  input: TrackerInput & { prompt_count: number },
): { ok: true; estimate: AiCostEstimate } | TrackerFailure {
  const merged = cleanTracker(
    {
      brand_name: input.brand_name?.trim() || 'Brand',
      brand_aliases: [],
      domain: 'example.com',
      competitors: [],
      location_code: 2840,
      language_code: 'en',
      engines: [...DEFAULT_ENGINES],
      schedule_interval: DEFAULT_SCHEDULE,
      paused: false,
    },
    { ...input, domain: input.domain ?? undefined },
  )
  if (isFailure(merged)) return merged
  return {
    ok: true,
    estimate: estimateFor(
      merged,
      Math.min(
        Math.max(0, Math.floor(input.prompt_count)),
        MAX_PROMPTS_PER_TRACKER,
      ),
    ),
  }
}

function cleanPrompts(
  prompts: PromptInput[],
):
  | Array<{ text: string; text_key: string; source: AiPromptSource }>
  | TrackerFailure {
  if (prompts.length > MAX_PROMPTS_PER_ADD)
    return invalid(`Add up to ${MAX_PROMPTS_PER_ADD} prompts at a time.`)
  const out: Array<{ text: string; text_key: string; source: AiPromptSource }> =
    []
  for (const p of prompts) {
    const { text, key } = normalizePrompt(String(p?.text ?? ''))
    if (!text) continue
    if (text.length > MAX_PROMPT_LENGTH)
      return invalid(`Keep each prompt under ${MAX_PROMPT_LENGTH} characters.`)
    if (out.some((o) => o.text_key === key)) continue
    out.push({
      text,
      text_key: key,
      source: p.source === 'suggested' ? 'suggested' : 'typed',
    })
  }
  return out
}

/**
 * Create a tracker (and, optionally, its first prompts). A running schedule
 * needs the access check and `confirmed`, even with no prompts; the first
 * scheduled check is due a full period out, so creating never spends on its
 * own.
 */
export async function createTracker(
  svc: SupabaseClient,
  who: Who,
  input: TrackerInput,
  opts: { confirmed?: boolean; prompts?: PromptInput[]; now?: Date } = {},
  deps: TrackerDeps = {},
): Promise<
  | {
      ok: true
      tracker: AiTrackerView
      prompts: AiPromptView[]
      estimate: AiCostEstimate
    }
  | TrackerFailure
> {
  let domain = input.domain ?? null
  if (!domain) {
    const site = await workspaceSiteUrl(svc, who.workspaceId)
    if (!site)
      return {
        ok: false,
        code: 'NO_SITE',
        message:
          'Which website is the brand’s? Give its domain (for example example.com).',
      }
    domain = site
  }
  const cleanDomainValue = cleanDomain(domain)
  if (!cleanDomainValue)
    return invalid(
      'That isn’t a website address. Give a domain like example.com.',
    )
  const tracker = cleanTracker(
    {
      brand_name: '',
      brand_aliases: [],
      domain: cleanDomainValue,
      competitors: [],
      location_code: 2840,
      language_code: 'en',
      engines: [...DEFAULT_ENGINES],
      schedule_interval: DEFAULT_SCHEDULE,
      paused: false,
    },
    { ...input, domain: undefined },
  )
  if (isFailure(tracker)) return tracker
  const prompts = cleanPrompts(opts.prompts ?? [])
  if (isFailure(prompts)) return prompts
  const firstPrompts = prompts.slice(0, MAX_PROMPTS_PER_TRACKER)
  const estimate = estimateFor(tracker, firstPrompts.length)
  if (scheduleRuns(tracker)) {
    const stop = await recurringSpendGate(who, deps, opts.confirmed, {
      message: scheduleOnMessage(tracker.schedule_interval, estimate, 'save it'),
      estimate,
      previous: null,
    })
    if (stop) return stop
  }

  const { data: existing, error: listError } = await svc
    .from('seo_ai_tracker')
    .select('id, domain, location_code, language_code')
    .eq('workspace_id', who.workspaceId)
    .limit(MAX_TRACKERS_PER_WORKSPACE + 1)
  if (listError)
    throw new Error(`seo ai tracker list failed: ${listError.message}`)
  const others = (existing ?? []) as Array<{
    id: string
    domain: string
    location_code: number
    language_code: string
  }>
  if (others.length >= MAX_TRACKERS_PER_WORKSPACE) {
    return {
      ok: false,
      code: 'TRACKER_LIMIT',
      message: `A workspace can have up to ${MAX_TRACKERS_PER_WORKSPACE} AI visibility trackers. Delete one you no longer need first.`,
    }
  }
  if (
    others.some(
      (o) =>
        o.domain === tracker.domain &&
        o.location_code === tracker.location_code &&
        o.language_code === tracker.language_code,
    )
  ) {
    return {
      ok: false,
      code: 'DUPLICATE_TRACKER',
      message:
        'This brand is already tracked in that market. Change that tracker instead.',
    }
  }

  const now = opts.now ?? new Date()
  const { data, error } = await svc
    .from('seo_ai_tracker')
    .insert({
      workspace_id: who.workspaceId,
      created_by: who.userId,
      ...tracker,
      next_run_at:
        tracker.schedule_interval === 'off'
          ? null
          : computeNextCheckAt(tracker.schedule_interval),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .select(TRACKER_FIELDS)
    .single()
  if (error || !data) {
    console.error('[seo-ai] create tracker failed', error?.message)
    return {
      ok: false,
      code: 'SAVE_FAILED',
      message: 'Could not save the tracker just now. Try again in a moment.',
    }
  }
  const row = data as TrackerRow
  let added: AiPromptView[] = []
  if (firstPrompts.length) {
    const out = await insertPrompts(svc, row.id, firstPrompts, who.userId)
    added = out
  }
  return {
    ok: true,
    tracker: trackerView(row),
    prompts: added,
    estimate: estimateFor(tracker, added.length),
  }
}

async function insertPrompts(
  svc: SupabaseClient,
  trackerId: string,
  rows: Array<{ text: string; text_key: string; source: AiPromptSource }>,
  userId: string,
): Promise<AiPromptView[]> {
  const { data, error } = await svc.rpc('seo_ai_add_prompts', {
    p_tracker: trackerId,
    p_rows: rows.map((r) => ({ ...r, created_by: userId })),
    p_cap: MAX_PROMPTS_PER_TRACKER,
  })
  if (error) throw new Error(`seo ai add prompts failed: ${error.message}`)
  return (
    (data ?? []) as Array<{
      id: string
      text: string
      source: AiPromptSource
      active: boolean
      created_at: string
    }>
  ).map((r) => promptView({ ...r, tracker_id: trackerId }))
}

/**
 * Change a tracker. Turning the schedule on (even with no prompts) or a
 * change that raises a running schedule's monthly cost needs the access
 * check and `confirmed`; changing a running schedule's interval needs the
 * access check (it makes the person the schedule's owner).
 */
export async function updateTracker(
  svc: SupabaseClient,
  who: Who,
  trackerId: string,
  patch: TrackerInput,
  opts: { confirmed?: boolean; now?: Date } = {},
  deps: TrackerDeps = {},
): Promise<
  | { ok: true; tracker: AiTrackerView; estimate: AiCostEstimate }
  | TrackerFailure
> {
  const row = await getTrackerRow(svc, who.workspaceId, trackerId)
  if (!row) return notFound
  const before = rowAsClean(row)
  const after = cleanTracker(before, patch)
  if (isFailure(after)) return after
  const prompts = await activePromptCount(svc, who.workspaceId, trackerId)
  const oldEstimate = estimateFor(before, prompts)
  const newEstimate = estimateFor(after, prompts)
  const runsAfter = scheduleRuns(after)
  // Off or paused before, running after.
  const turnedOn = runsAfter && !scheduleRuns(before)
  const raises = runsAfter && monthlyRises(oldEstimate, newEstimate)
  // Whoever turns the schedule on, or sets its interval, owns it from now on.
  const takesOwnership =
    turnedOn ||
    (runsAfter && after.schedule_interval !== before.schedule_interval)
  if (turnedOn || raises) {
    const stop = await recurringSpendGate(who, deps, opts.confirmed, {
      message: turnedOn
        ? scheduleOnMessage(after.schedule_interval, newEstimate, 'turn it on')
        : `This change raises the schedule’s cost to about ${formatUsd(newEstimate.monthly_usd)} a month (${formatUsd(newEstimate.run_usd)} a check), from ${formatUsd(oldEstimate.monthly_usd)}. Confirm to save it.`,
      estimate: newEstimate,
      previous: oldEstimate,
    })
    if (stop) return stop
  } else if (takesOwnership) {
    const refused = await mayRunSchedule(who, deps)
    if (refused) return refused
  }
  if (
    after.domain !== before.domain ||
    after.location_code !== before.location_code ||
    after.language_code !== before.language_code
  ) {
    const { data: dupes, error: dupeError } = await svc
      .from('seo_ai_tracker')
      .select('id')
      .eq('workspace_id', who.workspaceId)
      .eq('domain', after.domain)
      .eq('location_code', after.location_code)
      .eq('language_code', after.language_code)
      .neq('id', trackerId)
      .limit(1)
    if (dupeError)
      throw new Error(
        `seo ai tracker duplicate check failed: ${dupeError.message}`,
      )
    if ((dupes ?? []).length)
      return {
        ok: false,
        code: 'DUPLICATE_TRACKER',
        message: 'This brand is already tracked in that market.',
      }
  }

  const now = opts.now ?? new Date()
  const update: Record<string, unknown> = {
    ...after,
    updated_at: now.toISOString(),
  }
  if (after.schedule_interval === 'off') {
    update.next_run_at = null
  } else if (
    after.schedule_interval !== before.schedule_interval ||
    !row.next_run_at
  ) {
    update.next_run_at = computeNextCheckAt(after.schedule_interval)
  }
  // Only a person who just passed the access check above becomes the owner.
  if (takesOwnership) {
    update.created_by = who.userId
    update.last_skip_reason = null
  }
  const { data, error } = await svc
    .from('seo_ai_tracker')
    .update(update)
    .eq('workspace_id', who.workspaceId)
    .eq('id', trackerId)
    .select(TRACKER_FIELDS)
    .maybeSingle()
  if (error) {
    console.error('[seo-ai] update tracker failed', error.message)
    return {
      ok: false,
      code: 'SAVE_FAILED',
      message: 'Could not save the tracker just now. Try again in a moment.',
    }
  }
  if (!data) return notFound
  return {
    ok: true,
    tracker: trackerView(data as TrackerRow),
    estimate: newEstimate,
  }
}

/** Delete a tracker with its prompts, checks and answers. Refused while a check runs. */
export async function deleteTracker(
  svc: SupabaseClient,
  who: { workspaceId: string },
  trackerId: string,
): Promise<{ ok: true; tracker: AiTrackerView } | TrackerFailure> {
  const row = await getTrackerRow(svc, who.workspaceId, trackerId)
  if (!row) return notFound
  if (await getLiveRun(svc, who.workspaceId, trackerId)) {
    return {
      ok: false,
      code: 'RUN_IN_PROGRESS',
      message:
        'A check of this tracker is running. Stop it before deleting the tracker.',
    }
  }
  const { error } = await svc
    .from('seo_ai_tracker')
    .delete()
    .eq('workspace_id', who.workspaceId)
    .eq('id', trackerId)
  if (error) throw new Error(`seo ai tracker delete failed: ${error.message}`)
  return { ok: true, tracker: trackerView(row) }
}

/**
 * Whether `extra` more active prompts raise the monthly cost of a tracker
 * whose schedule runs. Any rise counts: no floor, so an addition split into
 * small parts asks every time.
 */
function promptAddRaisesSchedule(
  tracker: CleanTracker,
  current: number,
  extra: number,
) {
  const before = estimateFor(tracker, current)
  const after = estimateFor(
    tracker,
    Math.min(current + extra, MAX_PROMPTS_PER_TRACKER),
  )
  return {
    before,
    after,
    raises: scheduleRuns(tracker) && monthlyRises(before, after),
  }
}

/**
 * Add prompts (new ones only, up to the cap). Returns what was added and
 * what was skipped. On a tracker whose schedule runs, any addition that
 * raises the monthly cost needs the access check and `confirmed`.
 */
export async function addPrompts(
  svc: SupabaseClient,
  who: Who,
  trackerId: string,
  prompts: PromptInput[],
  opts: { confirmed?: boolean } = {},
  deps: TrackerDeps = {},
): Promise<
  | {
      ok: true
      added: AiPromptView[]
      skipped_duplicates: number
      skipped_over_cap: number
      estimate: AiCostEstimate
    }
  | TrackerFailure
> {
  const row = await getTrackerRow(svc, who.workspaceId, trackerId)
  if (!row) return notFound
  const cleaned = cleanPrompts(prompts)
  if (isFailure(cleaned)) return cleaned
  if (cleaned.length === 0) return invalid('Give at least one prompt.')
  const existing = await listPrompts(svc, who.workspaceId, trackerId)
  const existingKeys = new Set(existing.map((p) => normalizePrompt(p.text).key))
  const fresh = cleaned.filter((p) => !existingKeys.has(p.text_key))
  const room = Math.max(0, MAX_PROMPTS_PER_TRACKER - existing.length)
  if (fresh.length > 0 && room === 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `This tracker already has ${MAX_PROMPTS_PER_TRACKER} prompts, the most it can hold. Remove some first.`,
    }
  }
  const tracker = rowAsClean(row)
  const active = existing.filter((p) => p.active).length
  const check = promptAddRaisesSchedule(
    tracker,
    active,
    Math.min(fresh.length, room),
  )
  if (check.raises) {
    const stop = await recurringSpendGate(who, deps, opts.confirmed, {
      message: `These prompts raise the schedule’s cost to about ${formatUsd(check.after.monthly_usd)} a month, from ${formatUsd(check.before.monthly_usd)}. Confirm to add them.`,
      estimate: check.after,
      previous: check.before,
    })
    if (stop) return stop
  }
  const added = fresh.length
    ? await insertPrompts(svc, trackerId, fresh, who.userId)
    : []
  return {
    ok: true,
    added,
    skipped_duplicates: cleaned.length - fresh.length,
    skipped_over_cap: fresh.length - added.length,
    estimate: estimateFor(tracker, active + added.length),
  }
}

/** Remove prompts. Their past answers stay (with the words they were asked with). */
export async function removePrompts(
  svc: SupabaseClient,
  who: { workspaceId: string },
  trackerId: string,
  promptIds: string[],
): Promise<{ ok: true; removed: number } | TrackerFailure> {
  const row = await getTrackerRow(svc, who.workspaceId, trackerId)
  if (!row) return notFound
  if (promptIds.length === 0) return invalid('Name the prompts to remove.')
  const { data, error } = await svc
    .from('seo_ai_prompt')
    .delete()
    .eq('workspace_id', who.workspaceId)
    .eq('tracker_id', trackerId)
    .in('id', promptIds.slice(0, MAX_PROMPTS_PER_TRACKER))
    .select('id')
  if (error) throw new Error(`seo ai remove prompts failed: ${error.message}`)
  return { ok: true, removed: (data ?? []).length }
}

/** Turn prompts on or off. Turning them on on a tracker whose schedule runs asks like adding them. */
export async function setPromptsActive(
  svc: SupabaseClient,
  who: Who,
  trackerId: string,
  promptIds: string[],
  active: boolean,
  opts: { confirmed?: boolean } = {},
  deps: TrackerDeps = {},
): Promise<
  { ok: true; changed: number; estimate: AiCostEstimate } | TrackerFailure
> {
  const row = await getTrackerRow(svc, who.workspaceId, trackerId)
  if (!row) return notFound
  if (promptIds.length === 0) return invalid('Name the prompts to change.')
  const tracker = rowAsClean(row)
  const existing = await listPrompts(svc, who.workspaceId, trackerId)
  const current = existing.filter((p) => p.active).length
  const turningOn = active
    ? existing.filter((p) => !p.active && promptIds.includes(p.id)).length
    : 0
  if (turningOn) {
    const check = promptAddRaisesSchedule(tracker, current, turningOn)
    if (check.raises) {
      const stop = await recurringSpendGate(who, deps, opts.confirmed, {
        message: `Turning these prompts on raises the schedule’s cost to about ${formatUsd(check.after.monthly_usd)} a month, from ${formatUsd(check.before.monthly_usd)}. Confirm to turn them on.`,
        estimate: check.after,
        previous: check.before,
      })
      if (stop) return stop
    }
  }
  const { data, error } = await svc
    .from('seo_ai_prompt')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('workspace_id', who.workspaceId)
    .eq('tracker_id', trackerId)
    .in('id', promptIds.slice(0, MAX_PROMPTS_PER_TRACKER))
    .neq('active', active)
    .select('id')
  if (error) throw new Error(`seo ai toggle prompts failed: ${error.message}`)
  const changed = (data ?? []).length
  return {
    ok: true,
    changed,
    estimate: estimateFor(
      tracker,
      active ? current + changed : Math.max(0, current - changed),
    ),
  }
}
